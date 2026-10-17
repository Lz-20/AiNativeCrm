import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  runModelCall: vi.fn(),
  tool: (definition: unknown) => definition,
}));

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { judgeCustomerAcceptance } from "./mission-customer-acceptance";

const messageId = "11111111-1111-4111-8111-111111111111";
const mockedRunModelCall = vi.mocked(runModelCall);
const input = () => ({
  material: { criteria: "客户接受 1200 元报价和周五交付",
    messages: [{ id: messageId, sentAt: "2026-09-30T00:02:00Z",
      body: "我接受 1200 元报价和周五交付。" }] },
  pool: {} as never,
  llmCfg: {} as never,
  log: {} as never,
  organizationId: "org-1",
  model: "model-1",
  llmOverride: { provider: "provider-1", credentialId: "credential-1" },
  signal: new AbortController().signal,
});

describe("separate customer acceptance judge adapter", () => {
  beforeEach(() => { mockedRunModelCall.mockReset(); });

  it("accepts only an exact inbound citation through one in-memory result tool", async () => {
    mockedRunModelCall.mockImplementation(async (_pool, _cfg, request) => {
      const submit = request.tools?.submit_customer_acceptance_assessment as unknown as {
        execute: (value: unknown, context: unknown) => Promise<unknown>;
      };
      await submit.execute({ verdict: "supported", rationale: "两项明确接受",
        evidence: [{ messageId, quote: "接受 1200 元报价和周五交付", stance: "accepts" }],
        missingTerms: [] }, { toolCallId: "judge-1", messages: [], context: {} });
      return { provider: "provider-1", model: "model-1", result: { text: "" } } as never;
    });
    expect(await judgeCustomerAcceptance(input())).toMatchObject({
      verdict: "supported", businessOutcomeVerified: false,
      judgeId: "mission_customer_acceptance_v1:provider-1:model-1",
    });
    const call = mockedRunModelCall.mock.calls[0]?.[2];
    expect(call?.purpose).toBe("mission_customer_acceptance_judge");
    expect(call?.runtimeMode).toBe("shadow");
    expect(Object.keys(call?.tools ?? {})).toEqual(["submit_customer_acceptance_assessment"]);
    expect(call?.system).toContain("不可信数据");
    expect(call?.shouldStopAfterTurn?.({} as never)).toBe(true);
  });

  it("rejects a model-invented quote even when it claims success", async () => {
    mockedRunModelCall.mockImplementation(async (_pool, _cfg, request) => {
      const submit = request.tools?.submit_customer_acceptance_assessment as unknown as {
        execute: (value: unknown, context: unknown) => Promise<unknown>;
      };
      await submit.execute({ verdict: "supported", rationale: "编造了优惠",
        evidence: [{ messageId, quote: "接受 1200 元并同意折扣", stance: "accepts" }],
        missingTerms: [] }, { toolCallId: "judge-1", messages: [], context: {} });
      return { provider: "provider-1", model: "model-1", result: { text: "" } } as never;
    });
    await expect(judgeCustomerAcceptance(input()))
      .rejects.toThrow("customer_acceptance_citation_invalid");
  });

  it("fails closed when provider answers in prose or no eligible customer message exists", async () => {
    mockedRunModelCall.mockResolvedValue({ provider: "provider-1", model: "model-1",
      result: { text: "客户好像同意了" } } as never);
    await expect(judgeCustomerAcceptance(input()))
      .rejects.toThrow("customer_acceptance_submission_missing");
    await expect(judgeCustomerAcceptance({ ...input(), material: {
      criteria: "客户接受", messages: [],
    } })).rejects.toThrow("customer_acceptance_no_eligible_reply");
  });
});
