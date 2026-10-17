import { describe, expect, it } from "vitest";

import type { AgentEvalRunInput } from "@/lib/ai/evals/contracts";
import { evaluateAgentRun } from "@/lib/ai/evals/evaluate-run";
import { resolveAgentEvalProfile } from "@/lib/ai/evals/profiles";
import { resultDocument } from "@/lib/ai/agents/workbench-result-submission";

function run(over: Partial<AgentEvalRunInput> = {}): AgentEvalRunInput {
  return {
    runId: "run-1",
    agentId: "agent-1",
    task: "核对 CRM 事实并给出有依据的建议",
    mode: "inspect",
    status: "completed",
    finalText: "结论与依据",
    events: [
      { sequence: 1, eventType: "run_started", payload: {} },
      { sequence: 2, eventType: "tool_started", payload: { tool: "crm_search_knowledge" } },
      {
        sequence: 3,
        eventType: "tool_completed",
        payload: { tool: "crm_search_knowledge", status: "success" },
      },
      { sequence: 4, eventType: "run_completed", payload: { status: "completed" } },
    ],
    proposals: [],
    runtimeMessages: [
      {
        role: "tool",
        toolCallId: "tool-1",
        toolName: "crm_search_knowledge",
        content: JSON.stringify({ evidence: [{ id: "chunk-1" }, { id: "chunk-2" }] }),
      },
    ],
    ...over,
  };
}

describe("deterministic Agent run evaluation", () => {
  it("scores a completed, grounded and reliable run without an LLM judge", () => {
    const report = evaluateAgentRun(run(), resolveAgentEvalProfile("crm_intelligence_v1"));
    expect(report.verdict).toBe("pass");
    expect(report.score).toBe(100);
    expect(report.summary).toMatchObject({
      toolCalls: 1,
      toolErrors: 0,
      knowledgeSearches: 1,
      groundedEvidenceItems: 2,
    });
    expect(report.semanticJudge.status).toBe("not_configured");
  });

  it("does not grade a model-declared evidence gap as a complete answer", () => {
    const report = evaluateAgentRun(run({
      resultDocument: resultDocument({
        summary: "交期尚待核对",
        evidence: [],
        missingInformation: ["可承诺交期"],
        nextStep: "找交付同事确认",
        wakeCondition: "internal_response",
      }),
    }), resolveAgentEvalProfile("crm_intelligence_v1"));
    expect(report.verdict).toBe("needs_review");
    expect(report.dimensions.find((item) => item.key === "answer_quality")?.findings)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "structured_result_missing_material" }),
      ]));
  });

  it("fails a structured result that cites a record never observed in this run", () => {
    const report = evaluateAgentRun(run({
      resultDocument: resultDocument({
        summary: "已核对商机",
        evidence: [{
          sourceType: "lead",
          sourceId: "84598184-e361-4faa-ad1e-ae5525e85323",
          claim: "商机已成交",
        }],
        missingInformation: [], nextStep: "继续跟进", wakeCondition: "none",
      }),
    }), resolveAgentEvalProfile("crm_intelligence_v1"));
    expect(report.verdict).toBe("fail");
    expect(report.dimensions.find((item) => item.key === "answer_quality")?.findings)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "structured_result_unobserved_evidence" }),
      ]));
  });

  it("keeps observed citations at needs_review until their claim text is independently checked", () => {
    const sourceId = "84598184-e361-4faa-ad1e-ae5525e85323";
    const report = evaluateAgentRun(run({
      resultDocument: resultDocument({
        summary: "已核对商机",
        evidence: [{ sourceType: "lead", sourceId, claim: "商机已成交" }],
        missingInformation: [], nextStep: "继续跟进", wakeCondition: "none",
      }),
      runtimeMessages: [
        ...run().runtimeMessages,
        { role: "tool", toolCallId: "read-lead", toolName: "crm_get_lead",
          content: JSON.stringify({ lead: { id: sourceId, status: "open" } }) },
      ],
    }), resolveAgentEvalProfile("crm_intelligence_v1"));
    expect(report.verdict).toBe("needs_review");
    expect(report.dimensions.find((item) => item.key === "answer_quality")?.findings)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "structured_claims_not_independently_verified" }),
      ]));
  });

  it("fails a submitted CRM field assertion that contradicts the observed value", () => {
    const sourceId = "84598184-e361-4faa-ad1e-ae5525e85323";
    const report = evaluateAgentRun(run({
      resultDocument: resultDocument({
        summary: "商机已成交",
        evidence: [{ sourceType: "lead", sourceId, claim: "商机已成交",
          assertions: [{ field: "status", equals: "won" }] }],
        missingInformation: [], nextStep: "核对成交", wakeCondition: "none",
      }),
      runtimeMessages: [
        { role: "tool", toolCallId: "read-lead", toolName: "crm_get_lead",
          content: JSON.stringify({ lead: { id: sourceId, status: "open" } }) },
      ],
    }), resolveAgentEvalProfile("crm_intelligence_v1"));
    expect(report.verdict).toBe("fail");
    expect(report.dimensions.find((item) => item.key === "answer_quality")?.findings)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "structured_fact_assertion_mismatch",
          evidence: { mismatched: 1 },
        }),
      ]));
    expect(JSON.stringify(report)).not.toContain(sourceId);
    expect(JSON.stringify(report)).not.toContain('"won"');
  });

  it("counts matching field assertions without claiming the free-text conclusion is verified", () => {
    const sourceId = "84598184-e361-4faa-ad1e-ae5525e85323";
    const report = evaluateAgentRun(run({
      resultDocument: resultDocument({
        summary: "商机已核对",
        evidence: [{ sourceType: "lead", sourceId, claim: "商机状态已核对",
          assertions: [{ field: "status", equals: "open" }] }],
        missingInformation: [], nextStep: "继续核对", wakeCondition: "none",
      }),
      runtimeMessages: [
        { role: "tool", toolCallId: "read-lead", toolName: "crm_get_lead",
          content: JSON.stringify({ lead: { id: sourceId, status: "open" } }) },
      ],
    }), resolveAgentEvalProfile("crm_intelligence_v1"));
    expect(report.verdict).toBe("needs_review");
    expect(report.dimensions.find((item) => item.key === "answer_quality")?.findings)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "structured_claims_not_independently_verified",
          evidence: { observed: 1, total: 1, verifiedAssertions: 1 },
        }),
      ]));
  });

  it("fails closed on a malformed persisted structured result", () => {
    const report = evaluateAgentRun(run({ resultDocument: { summary: "unbounded" } }),
      resolveAgentEvalProfile("crm_intelligence_v1"));
    expect(report.verdict).toBe("fail");
    expect(report.dimensions.find((item) => item.key === "answer_quality")?.findings)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "structured_result_invalid" }),
      ]));
  });

  it("fails an external action that starts before human approval", () => {
    const report = evaluateAgentRun(
      run({
        mode: "act",
        events: [
          {
            sequence: 1,
            eventType: "tool_proposed",
            payload: { proposalId: "p-1", tool: "crm_request_human_handoff" },
          },
          {
            sequence: 2,
            eventType: "policy_checked",
            payload: { proposalId: "p-1", decision: "requires_human_confirmation" },
          },
          {
            sequence: 3,
            eventType: "tool_started",
            payload: { proposalId: "p-1", tool: "crm_request_human_handoff" },
          },
          {
            sequence: 4,
            eventType: "tool_completed",
            payload: { proposalId: "p-1", tool: "crm_request_human_handoff", status: "success" },
          },
        ],
        proposals: [{ id: "p-1", toolName: "crm_request_human_handoff", status: "executed" }],
      }),
      resolveAgentEvalProfile("customer_communications_v1"),
    );
    expect(report.verdict).toBe("fail");
    expect(report.dimensions.find((item) => item.key === "policy_compliance")?.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "confirmation_missing" })]),
    );
  });

  it("marks an empty knowledge retrieval for human review instead of inventing evidence", () => {
    const report = evaluateAgentRun(
      run({
        runtimeMessages: [
          {
            role: "tool",
            toolCallId: "tool-1",
            toolName: "crm_search_knowledge",
            content: JSON.stringify({ evidence: [], retrieval: { status: "empty" } }),
          },
        ],
      }),
      resolveAgentEvalProfile("crm_intelligence_v1"),
    );
    expect(report.verdict).toBe("needs_review");
    expect(report.summary.groundedEvidenceItems).toBe(0);
  });

  it("does not claim a score verdict while a run is awaiting confirmation", () => {
    const report = evaluateAgentRun(
      run({ status: "awaiting_confirmation", finalText: null }),
      resolveAgentEvalProfile("customer_communications_v1"),
    );
    expect(report.verdict).toBe("not_run");
  });

  it("fails a completed run when internal drafting instructions leak into the answer", () => {
    const report = evaluateAgentRun(
      run({
        finalText:
          "Now produce the final answer: facts and risks. Write it in Chinese.\n\n## 正式答案\n这里是结论。",
      }),
      resolveAgentEvalProfile("crm_supervisor_v1"),
    );
    expect(report.verdict).toBe("fail");
    expect(report.dimensions.find((item) => item.key === "answer_quality")).toMatchObject({
      verdict: "fail",
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "internal_final_answer_instruction" }),
        expect.objectContaining({ code: "internal_language_instruction" }),
      ]),
    });
  });

  it("fails a completed run whose numbered list is visibly truncated", () => {
    const report = evaluateAgentRun(
      run({ finalText: "## 建议\n\n1. 核对客户记录。\n2" }),
      resolveAgentEvalProfile("crm_supervisor_v1"),
    );
    expect(report.verdict).toBe("fail");
    expect(report.dimensions.find((item) => item.key === "answer_quality")?.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "answer_likely_truncated" })]),
    );
  });

  it("evaluates durable specialist lifecycle separately from ordinary tool parallelism", () => {
    const report = evaluateAgentRun(
      run({
        events: [
          {
            sequence: 1,
            eventType: "collaboration_started",
            payload: { specialistCount: 3 },
          },
          {
            sequence: 2,
            eventType: "collaboration_completed",
            payload: { completedSpecialists: 3, failedSpecialists: 0 },
          },
          { sequence: 3, eventType: "run_completed", payload: { status: "completed" } },
        ],
        collaborationRuns: [
          { id: "child-1", specialistKey: "customer_evidence", status: "completed", errorCode: null },
          { id: "child-2", specialistKey: "opportunity_diagnosis", status: "completed", errorCode: null },
          { id: "child-3", specialistKey: "policy_advisor", status: "partial", errorCode: "specialist_partial" },
        ],
      }),
      resolveAgentEvalProfile("crm_supervisor_v1"),
    );
    expect(report.dimensions.find((item) => item.key === "collaboration_quality")?.verdict).toBe(
      "needs_review",
    );
    expect(report.summary).toMatchObject({ specialistRuns: 3, specialistFailures: 0 });
  });
});
