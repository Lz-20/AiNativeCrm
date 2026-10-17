import { describe, expect, it, vi } from "vitest";

import type {
  AgentEvalRunInput,
  AgentSemanticJudgePort,
  AgentSemanticJudgement,
} from "@/lib/ai/evals/contracts";
import { resolveAgentEvalProfile } from "@/lib/ai/evals/profiles";
import { runAgentEvaluation } from "@/lib/ai/evals/run-evaluation";

function run(over: Partial<AgentEvalRunInput> = {}): AgentEvalRunInput {
  return {
    runId: "run-1",
    agentId: "agent-1",
    task: "读取知识证据并回答问题",
    mode: "inspect",
    status: "completed",
    finalText: "## 结论\n\n知识证据支持该结论。",
    events: [
      { sequence: 1, eventType: "tool_started", payload: { tool: "crm_search_knowledge" } },
      {
        sequence: 2,
        eventType: "tool_completed",
        payload: { tool: "crm_search_knowledge", status: "success" },
      },
      { sequence: 3, eventType: "run_completed", payload: { status: "completed" } },
    ],
    proposals: [],
    runtimeMessages: [
      {
        role: "tool",
        toolCallId: "call-1",
        toolName: "crm_search_knowledge",
        content: JSON.stringify({ evidence: [{ id: "chunk-1" }] }),
      },
    ],
    ...over,
  };
}

function judgement(
  over: Partial<AgentSemanticJudgement> = {},
): AgentSemanticJudgement {
  return {
    judgeId: "judge:test",
    rubricRevision: 1,
    verdict: "pass",
    score: 95,
    findings: [],
    rubric: [
      { key: "task_fit", score: 4, rationale: "完成任务" },
      { key: "factual_support", score: 4, rationale: "证据支持" },
      { key: "missing_material_honesty", score: 4, rationale: "边界明确" },
      { key: "actionability", score: 3, rationale: "建议可执行" },
    ],
    ...over,
  };
}

describe("semantic Agent evaluation orchestration", () => {
  it("can downgrade a deterministic pass and never increase its score", async () => {
    const judge: AgentSemanticJudgePort = {
      judge: vi.fn().mockResolvedValue(
        judgement({
          verdict: "needs_review",
          score: 62,
          findings: [{ code: "weak_support", message: "一个结论缺少直接证据。" }],
        }),
      ),
    };
    const report = await runAgentEvaluation({
      run: run(),
      profile: resolveAgentEvalProfile("crm_intelligence_v1"),
      judge,
    });

    expect(report.verdict).toBe("needs_review");
    expect(report.score).toBe(62);
    expect(report.semanticJudge).toMatchObject({
      status: "completed",
      verdict: "needs_review",
      judgeId: "judge:test",
    });
  });

  it("does not let a semantic pass override a deterministic safety failure", async () => {
    const judge: AgentSemanticJudgePort = { judge: vi.fn().mockResolvedValue(judgement()) };
    const report = await runAgentEvaluation({
      run: run({
        finalText: "Now produce the final answer.\n\n## 正式答案\n结论。",
      }),
      profile: resolveAgentEvalProfile("crm_intelligence_v1"),
      judge,
    });

    expect(report.verdict).toBe("fail");
    expect(report.score).toBeLessThanOrEqual(95);
    expect(report.dimensions.find((item) => item.key === "answer_quality")?.verdict).toBe("fail");
  });

  it("fails open for information but closed for release when the judge is unavailable", async () => {
    const judge: AgentSemanticJudgePort = {
      judge: vi.fn().mockRejectedValue(Object.assign(new Error("provider down"), { name: "provider_unavailable" })),
    };
    const report = await runAgentEvaluation({
      run: run(),
      profile: resolveAgentEvalProfile("crm_intelligence_v1"),
      judge,
    });

    expect(report.verdict).toBe("needs_review");
    expect(report.semanticJudge).toMatchObject({
      status: "failed",
      findings: [expect.objectContaining({ code: "semantic_judge_failed" })],
    });
  });

  it("does not spend a judge call on a non-terminal run", async () => {
    const judge = { judge: vi.fn().mockResolvedValue(judgement()) };
    const report = await runAgentEvaluation({
      run: run({ status: "running", finalText: null }),
      profile: resolveAgentEvalProfile("crm_intelligence_v1"),
      judge,
    });

    expect(report.verdict).toBe("not_run");
    expect(report.semanticJudge.status).toBe("not_run");
    expect(judge.judge).not.toHaveBeenCalled();
  });
});
