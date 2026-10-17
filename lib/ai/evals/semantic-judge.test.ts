import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  runModelCall: vi.fn(),
  tool: (definition: unknown) => definition,
}));

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import type { AgentEvalReport, AgentEvalRunInput } from "@/lib/ai/evals/contracts";
import { resolveAgentEvalProfile } from "@/lib/ai/evals/profiles";
import {
  LlmAgentSemanticJudge,
  WORKBENCH_SEMANTIC_RUBRIC_REVISION,
} from "@/lib/ai/evals/semantic-judge";

const mockedRunModelCall = vi.mocked(runModelCall);

function subject(): { run: AgentEvalRunInput; report: AgentEvalReport } {
  const profile = resolveAgentEvalProfile("crm_intelligence_v1");
  return {
    run: {
      runId: "run-1",
      agentId: "agent-1",
      task: "核对 CRM 事实",
      mode: "inspect",
      status: "completed",
      finalText: "## 结论\n事实有证据支持。",
      events: [],
      proposals: [],
      runtimeMessages: [
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "crm_get_lead",
          content: JSON.stringify({ id: "lead-1", stage: "qualified" }),
        },
      ],
    },
    report: {
      runId: "run-1",
      profileKey: profile.key,
      profileRevision: profile.revision,
      verdict: "pass",
      score: 100,
      dimensions: [],
      summary: {
        toolCalls: 1,
        toolErrors: 0,
        knowledgeSearches: 0,
        groundedEvidenceItems: 0,
        specialistRuns: 0,
        specialistFailures: 0,
        structuredClaims: 0,
      },
      semanticJudge: { status: "not_configured" },
    },
  };
}

function judge() {
  return new LlmAgentSemanticJudge({
    pool: {} as never,
    llmCfg: {} as never,
    log: {} as never,
    organizationId: "org-1",
    workbenchRunId: "run-1",
    agentId: "agent-1",
    model: "model-1",
    llmOverride: { provider: "provider-1", credentialId: "credential-1" },
  });
}

describe("LLM Agent semantic judge adapter", () => {
  beforeEach(() => {
    mockedRunModelCall.mockReset();
  });

  it("accepts a schema-validated tool submission and attributes the judge call to the workbench run", async () => {
    mockedRunModelCall.mockImplementation(async (_pool, _cfg, input) => {
      const submission = {
        verdict: "needs_review",
        score: 72,
        findings: [{ code: "weak_support", message: "一项建议缺少直接 observation。" }],
        rubric: [
          { key: "task_fit", score: 4, rationale: "任务已覆盖" },
          { key: "factual_support", score: 2, rationale: "部分支持" },
          { key: "missing_material_honesty", score: 3, rationale: "边界基本明确" },
          { key: "actionability", score: 3, rationale: "建议可执行" },
        ],
      };
      const submit = input.tools?.submit_semantic_evaluation as unknown as {
        execute?: (value: unknown, options: unknown) => Promise<unknown>;
      };
      await submit.execute?.(submission, {
        toolCallId: "judge-submit-1",
        messages: [],
        context: {},
      });
      return {
        provider: "provider-1",
        model: "model-1",
        result: { text: "" },
      } as never;
    });
    const value = subject();
    const result = await judge().judge({
      profile: resolveAgentEvalProfile("crm_intelligence_v1"),
      run: value.run,
      deterministicReport: value.report,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      verdict: "needs_review",
      score: 72,
      rubricRevision: WORKBENCH_SEMANTIC_RUBRIC_REVISION,
      judgeId: "workbench_semantic_v2:provider-1:model-1",
    });
    expect(mockedRunModelCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        purpose: "workbench_eval_judge",
        workbenchRunId: "run-1",
        agentId: "agent-1",
        maxSteps: 2,
        maxOutputTokens: 4_000,
        runtimeMode: "shadow",
      }),
      expect.anything(),
    );
    const modelInput = mockedRunModelCall.mock.calls[0]?.[2];
    expect(modelInput?.system).toContain("不可信数据");
    expect(modelInput?.system).toContain("submit_semantic_evaluation");
    expect(Object.keys(modelInput?.tools ?? {})).toEqual(["submit_semantic_evaluation"]);
    expect(modelInput?.shouldStopAfterTurn?.({} as never)).toBe(true);
  });

  it("fails closed when the provider does not return the complete rubric", async () => {
    mockedRunModelCall.mockResolvedValue({
      provider: "provider-1",
      model: "model-1",
      result: { text: JSON.stringify({ verdict: "pass", score: 100, findings: [], rubric: [] }) },
    } as never);
    const value = subject();

    await expect(
      judge().judge({
        profile: resolveAgentEvalProfile("crm_intelligence_v1"),
        run: value.run,
        deterministicReport: value.report,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: "semantic_judge_schema_invalid" });
  });

  it("finds the schema-valid object after provider reasoning that contains braces", async () => {
    mockedRunModelCall.mockResolvedValue({
      provider: "provider-1",
      model: "model-1",
      result: {
        text: `I should emit {verdict, rubric} next.\n${JSON.stringify({
          verdict: "pass",
          score: 94,
          findings: [],
          rubric: [
            { key: "task_fit", score: 4, rationale: "完成任务" },
            { key: "factual_support", score: 4, rationale: "事实有依据" },
            { key: "missing_material_honesty", score: 4, rationale: "缺失材料明确" },
            { key: "actionability", score: 3, rationale: "建议可执行" },
          ],
        })}\nDone.`,
      },
    } as never);
    const value = subject();

    await expect(
      judge().judge({
        profile: resolveAgentEvalProfile("crm_intelligence_v1"),
        run: value.run,
        deterministicReport: value.report,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ verdict: "pass", score: 94 });
  });
});
