import type { RuntimeMessage } from "@/lib/agent-runtime";
import { executePiTurnModelCall } from "@/lib/agent-engine/agent/pi-turn-execution";
import type { RunModelCallInput } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  type createWorkbenchResultChannel,
  WORKBENCH_RESULT_INSTRUCTION,
} from "@/lib/ai/agents/workbench-result-submission";

type ModelCall = Awaited<ReturnType<typeof executePiTurnModelCall>>;

export type ResultRecoveryState =
  | "not_needed" | "deferred_actions" | "skipped_budget" | "skipped_unknown_cost"
  | "submitted" | "missing" | "failed";

/** One bounded follow-up with *only* the in-memory submission tool. */
export async function recoverWorkbenchResult(input: {
  deps: Parameters<typeof executePiTurnModelCall>[0];
  first: ModelCall;
  originalCall: RunModelCallInput;
  channel: ReturnType<typeof createWorkbenchResultChannel>;
  hasProposedActions: boolean;
  maxRemainingSteps: number;
  remainingTokens: number | null;
  remainingCostCents: number | null;
  beforeSideEffect?: () => Promise<void>;
  execute?: typeof executePiTurnModelCall;
}): Promise<{ call: ModelCall; state: ResultRecoveryState }> {
  if (input.channel.submitted()) return { call: input.first, state: "not_needed" };
  // CRM must execute/approve staged actions and feed observations back to Pi
  // before asking for a final result. Otherwise the result may claim a write
  // that has not happened yet.
  if (input.hasProposedActions) return { call: input.first, state: "deferred_actions" };
  const tokensLeft = input.remainingTokens === null
    ? null
    : input.remainingTokens - input.first.usage.inputTokens - input.first.usage.outputTokens;
  const costLeft = input.remainingCostCents === null
    ? null
    : input.first.costCents === null
      ? null
      : input.remainingCostCents - input.first.costCents;
  if (
    input.maxRemainingSteps < 1 ||
    (tokensLeft !== null && tokensLeft <= 0)
  ) return { call: input.first, state: "skipped_budget" };
  if (input.remainingCostCents !== null && input.first.costCents === null) {
    return { call: input.first, state: "skipped_unknown_cost" };
  }
  if (costLeft !== null && costLeft <= 0) return { call: input.first, state: "skipped_budget" };

  // A positive balance is not enough: the next request repeats the prior
  // context. Reserve at least the last observed input turn (plus margin) and
  // a useful output allowance before starting another paid/provider call.
  // The provider may tokenize differently, so this is a conservative gate,
  // not a claim of exact preflight token counting.
  const lastInput = [...input.first.result.runtimeMessages]
    .reverse()
    .find((message) => message.role === "assistant" && (message.usage?.inputTokens ?? 0) > 0);
  const averageInput = input.first.usage.inputTokens / Math.max(1, input.first.result.turnCount);
  const expectedInput = lastInput?.role === "assistant"
    ? Math.max(lastInput.usage?.inputTokens ?? 0, averageInput)
    : averageInput;
  const reservedInput = Math.ceil(expectedInput * 1.25) + 256;
  const outputCap = Math.min(
    input.originalCall.maxOutputTokens ?? 4_000,
    4_000,
    tokensLeft === null ? 4_000 : Math.floor(tokensLeft - reservedInput),
  );
  if (tokensLeft !== null && outputCap < 512) {
    return { call: input.first, state: "skipped_budget" };
  }

  await input.beforeSideEffect?.();
  input.originalCall.abortSignal?.throwIfAborted();
  const reminder: RuntimeMessage = {
    role: "user",
    content: [
      "只完成结果提交。此前 CRM 读取结果已在上文；不要再次读取、修改 CRM 或发送消息。",
      "现在必须调用 submit_workbench_result 一次。缺少的事实写入 missingInformation；",
      "已提出但未由 CRM 确认完成的动作不能写成已执行。不要输出普通文本答案。",
    ].join(""),
  };
  try {
    const recovered = await (input.execute ?? executePiTurnModelCall)(input.deps, {
      ...input.originalCall,
      system: `${input.originalCall.system ?? ""}\n${WORKBENCH_RESULT_INSTRUCTION}\n本轮仅允许结果提交，不允许 CRM 工具。`,
      messages: [],
      runtimeMessages: [...input.first.result.runtimeMessages, reminder],
      tools: input.channel.tools,
      maxSteps: 1,
      maxOutputTokens: outputCap,
      beforeToolCall: undefined,
      afterToolCall: undefined,
      onEvent: undefined,
      shouldStopAfterTurn: ({ cumulativeUsage, costCents }) =>
        input.channel.submitted() !== null ||
        (tokensLeft !== null && cumulativeUsage.totalTokens >= tokensLeft) ||
        (costLeft !== null && costCents !== null && costCents >= costLeft),
    });
    return {
      call: recovered,
      state: input.channel.submitted() ? "submitted" : "missing",
    };
  } catch (error) {
    if (input.originalCall.abortSignal?.aborted) throw error;
    // A lost lease or cancelled Mission must not be disguised as model failure.
    await input.beforeSideEffect?.();
    return { call: input.first, state: "failed" };
  }
}
