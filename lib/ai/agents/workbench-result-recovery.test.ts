import { describe, expect, it, vi } from "vitest";
import type { executePiTurnModelCall } from "@/lib/agent-engine/agent/pi-turn-execution";
import {
  createWorkbenchResultChannel,
  SUBMIT_WORKBENCH_RESULT_TOOL,
} from "@/lib/ai/agents/workbench-result-submission";
import { recoverWorkbenchResult } from "@/lib/ai/agents/workbench-result-recovery";

const submission = {
  summary: "已读取商机，交期仍未知。",
  evidence: [],
  missingInformation: ["交期"],
  nextStep: "询问交付团队",
  wakeCondition: "internal_response",
};

function fixture() {
  const channel = createWorkbenchResultChannel();
  const first = {
    result: {
      runtimeMessages: [{ role: "assistant", content: "Let me read the lead." }],
      turnCount: 3,
    },
    usage: { inputTokens: 100, outputTokens: 20 },
    costCents: 0,
  } as unknown as Awaited<ReturnType<typeof executePiTurnModelCall>>;
  const originalCall = {
    tenantId: "org-1",
    messages: [],
    system: "Check CRM facts.",
    tools: { crm_get_lead: { execute: async () => ({ shouldNotRun: true }) } },
    abortSignal: new AbortController().signal,
  } as never;
  return { channel, first, originalCall };
}

describe("bounded structured-result recovery", () => {
  it("exposes only the result tool and reuses prior observations", async () => {
    const { channel, first, originalCall } = fixture();
    const execute = vi.fn(async (_deps, call: {
      tools: Record<string, { execute: (args: unknown, options: unknown) => Promise<unknown> }>;
      runtimeMessages: Array<{ role: string; content: string }>;
      maxSteps: number;
      maxOutputTokens: number;
    }) => {
      expect(Object.keys(call.tools)).toEqual([SUBMIT_WORKBENCH_RESULT_TOOL]);
      expect(call.runtimeMessages.map((message) => message.role)).toEqual(["assistant", "user"]);
      expect(call.maxSteps).toBe(1);
      expect(call.maxOutputTokens).toBeLessThanOrEqual(1000);
      await call.tools[SUBMIT_WORKBENCH_RESULT_TOOL]!.execute(submission, {});
      return { ...first, result: { ...first.result, turnCount: 1 } };
    });
    const recovered = await recoverWorkbenchResult({
      deps: {} as never, first, originalCall, channel, hasProposedActions: false,
      maxRemainingSteps: 2, remainingTokens: 1000, remainingCostCents: 10,
      execute: execute as never,
    });
    expect(recovered.state).toBe("submitted");
    expect(channel.submitted()).toMatchObject({ summary: submission.summary });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not spend another model call after budget exhaustion", async () => {
    const { channel, first, originalCall } = fixture();
    const execute = vi.fn();
    const recovered = await recoverWorkbenchResult({
      deps: {} as never, first, originalCall, channel, hasProposedActions: false,
      maxRemainingSteps: 0, remainingTokens: 1000, remainingCostCents: 10,
      execute: execute as never,
    });
    expect(recovered).toEqual({ call: first, state: "skipped_budget" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reserves the next context and useful output instead of overspending a small positive balance", async () => {
    const { channel, first, originalCall } = fixture();
    const execute = vi.fn();
    const recovered = await recoverWorkbenchResult({
      deps: {} as never,
      first: {
        ...first,
        result: {
          ...first.result,
          runtimeMessages: [{ role: "assistant", content: "Observed CRM", usage: { inputTokens: 3_000 } }],
        },
      } as typeof first,
      originalCall, channel, hasProposedActions: false,
      maxRemainingSteps: 2, remainingTokens: 2_000, remainingCostCents: 10,
      execute: execute as never,
    });
    expect(recovered.state).toBe("skipped_budget");
    expect(execute).not.toHaveBeenCalled();
  });

  it("distinguishes unknown provider pricing from exhausted budget", async () => {
    const { channel, first, originalCall } = fixture();
    const execute = vi.fn();
    const recovered = await recoverWorkbenchResult({
      deps: {} as never,
      first: { ...first, costCents: null },
      originalCall, channel, hasProposedActions: false,
      maxRemainingSteps: 2, remainingTokens: 1000, remainingCostCents: 10,
      execute: execute as never,
    });
    expect(recovered.state).toBe("skipped_unknown_cost");
    expect(execute).not.toHaveBeenCalled();
  });

  it("waits for staged CRM actions to produce observations before final submission", async () => {
    const { channel, first, originalCall } = fixture();
    const execute = vi.fn();
    const recovered = await recoverWorkbenchResult({
      deps: {} as never, first, originalCall, channel, hasProposedActions: true,
      maxRemainingSteps: 2, remainingTokens: 1000, remainingCostCents: 10,
      execute: execute as never,
    });
    expect(recovered).toEqual({ call: first, state: "deferred_actions" });
    expect(execute).not.toHaveBeenCalled();
  });
});
