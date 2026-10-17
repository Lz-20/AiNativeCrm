import { describe, expect, it } from "vitest";
import { evaluateAgentRun } from "./evaluate-run";
import { resolveAgentEvalProfile } from "./profiles";
import type { AgentEvalRunInput } from "./contracts";

const contactId = "11111111-1111-4111-8111-111111111111";
function run(memory?: unknown): AgentEvalRunInput {
  return {
    runId: "run", agentId: "agent", task: "列出确认的客户记忆", mode: "inspect",
    status: "completed", finalText: "没有确认的客户记忆。", events: [], proposals: [],
    runtimeMessages: [{ role: "tool", toolCallId: "read", toolName: "crm_get_contact",
      content: JSON.stringify({ id: contactId, ...(memory ? { confirmed_customer_memory: memory } : {}) }) }],
    confirmedMemoryExpectations: [{ contactId, memoryIds: ["memory-1"], asOf: "2026-10-03T00:00:00Z" }],
  };
}
describe("independent confirmed-memory coverage", () => {
  it.each([undefined, { status: "disabled", memories: [] }, { coverage: "complete", memories: [] }])(
    "rejects missing canonical facts even if the observation falsely looks empty", (memory) => {
      const report = evaluateAgentRun(run(memory), resolveAgentEvalProfile());
      expect(report.verdict).toBe("fail");
      expect(report.dimensions.find(d => d.key === "answer_quality")?.findings)
        .toContainEqual(expect.objectContaining({ code: "confirmed_memory_not_observed" }));
      expect(JSON.stringify(report)).not.toContain(contactId);
    });
  it("requires review for an explicitly bounded partial read rather than claiming absence", () => {
    const report = evaluateAgentRun(run({ coverage: "partial", memories: [] }), resolveAgentEvalProfile());
    expect(report.verdict).toBe("needs_review");
  });
  it("does not claim natural language is validated when only fact coverage matches", () => {
    const report = evaluateAgentRun(run({ coverage: "complete", memories: [{ id: "memory-1" }] }), resolveAgentEvalProfile());
    expect(report.verdict).toBe("needs_review");
    expect(report.dimensions.find(d => d.key === "answer_quality")?.findings)
      .toContainEqual(expect.objectContaining({ code: "memory_claims_require_semantic_review" }));
  });
});
