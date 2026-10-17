import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type * as PiAgentCoreModuleType from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type JsonObject,
  type Message,
  type ToolResultMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import type * as PiAiModuleType from "@earendil-works/pi-ai";

import { importNativeEsm, isTsxWorker } from "./native-import";
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentTurnInput,
  AgentTurnResult,
  RuntimeContent,
  RuntimeMessage,
  RuntimeToolResult,
  RuntimeToolCall,
  RuntimeUsage,
  RuntimeObservation,
} from "../types";
import { resolvePiModel } from "./model-adapter";
import type { ResolvedPiModel } from "./model-adapter";

type PiAgentCoreModule = typeof PiAgentCoreModuleType;
type PiAiModule = typeof PiAiModuleType;

function loadPiAgentCore(): Promise<PiAgentCoreModule> {
  return isTsxWorker()
    ? importNativeEsm<PiAgentCoreModule>("@earendil-works/pi-agent-core")
    : import("@earendil-works/pi-agent-core");
}

function loadPiAi(): Promise<PiAiModule> {
  return isTsxWorker()
    ? importNativeEsm<PiAiModule>("@earendil-works/pi-ai")
    : import("@earendil-works/pi-ai");
}

const EMPTY_USAGE: RuntimeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

function now(): number {
  return Date.now();
}

function steeringMarker(id: string): string {
  return `[crm-steering-id:${encodeURIComponent(id)}]`;
}

function textOf(content: string | RuntimeContent[]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}

function usageOf(usage: Usage | undefined): RuntimeUsage {
  if (usage === undefined) return { ...EMPTY_USAGE };
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
}

function addUsage(left: RuntimeUsage, right: RuntimeUsage): RuntimeUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function contentToPi(content: string | RuntimeContent[]) {
  return typeof content === "string"
    ? content
    : content.map((part) =>
        part.type === "text"
          ? { type: "text" as const, text: part.text }
          : { type: "image" as const, data: part.data, mimeType: part.mimeType },
      );
}

function messageToPi(message: RuntimeMessage, binding: AgentTurnInput["model"]): AgentMessage {
  const timestamp = now();
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content, timestamp };
    case "user":
      return { role: "user", content: contentToPi(message.content), timestamp };
    case "assistant":
      if (message.privateContinuation !== undefined) {
        const saved = message.privateContinuation;
        if (
          saved === null || typeof saved !== "object" || Array.isArray(saved) ||
          !Array.isArray((saved as AssistantMessage).content) ||
          typeof (saved as AssistantMessage).api !== "string" ||
          typeof (saved as AssistantMessage).provider !== "string" ||
          typeof (saved as AssistantMessage).model !== "string" ||
          typeof (saved as AssistantMessage).stopReason !== "string" ||
          typeof (saved as AssistantMessage).timestamp !== "number" ||
          !((saved as AssistantMessage).usage && typeof (saved as AssistantMessage).usage === "object")
        ) throw new Error("pi_assistant_continuation_state_invalid");
        return { ...(saved as AssistantMessage), role: "assistant" };
      }
      return {
        role: "assistant",
        content: [
          ...(typeof message.content === "string"
            ? [{ type: "text" as const, text: message.content }]
            : message.content.filter((part) => part.type === "text")),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: call.arguments as unknown as JsonObject,
          })),
        ],
        api: "openai-completions",
        provider: binding.provider,
        model: binding.model,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp,
      } satisfies AssistantMessage;
    case "tool":
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content:
          typeof message.content === "string"
            ? [{ type: "text" as const, text: message.content }]
            : message.content,
        details: message.details as never,
        isError: message.isError === true,
        timestamp,
      } satisfies ToolResultMessage;
  }
}

function messageFromPi(message: AgentMessage): RuntimeMessage | null {
  if (message.role === "system") {
    const content = message.content;
    return {
      role: "system",
      content:
        typeof content === "string"
          ? content
          : content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(""),
    };
  }
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "toolResult") {
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      isError: message.isError,
      details: message.details,
    };
  }

  if (message.role !== "assistant") return null;
  const content = (message as AssistantMessage).content;
  return {
    role: "assistant",
    content: content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    toolCalls: content
      .filter((part) => part.type === "toolCall")
      .map((part) => ({ id: part.id, name: part.name, arguments: part.arguments })),
    usage: usageOf((message as AssistantMessage).usage),
    privateContinuation: {
      content,
      api: message.api,
      provider: message.provider,
      model: message.model,
      usage: message.usage,
      stopReason: message.stopReason,
      timestamp: message.timestamp,
      ...(message.responseModel ? { responseModel: message.responseModel } : {}),
      ...(message.responseId ? { responseId: message.responseId } : {}),
      ...(message.providerThinkingLevel ? { providerThinkingLevel: message.providerThinkingLevel } : {}),
      ...(message.endTurn !== undefined ? { endTurn: message.endTurn } : {}),
    },
  };
}

function resultContent(result: RuntimeToolResult) {
  return typeof result.content === "string"
    ? [{ type: "text" as const, text: result.content }]
    : result.content;
}

function runtimeEvent(event: AgentEvent): AgentRuntimeEvent {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
      return { type: event.type, data: {} };
    case "agent_end":
      return { type: event.type, data: { message_count: event.messages.length } };
    case "turn_end":
      return { type: event.type, data: {
        tool_result_count: event.toolResults.length,
        stop_reason: event.message.role === "assistant" ? event.message.stopReason : null,
      } };
    case "message_start":
    case "message_end":
      return { type: event.type, data: { role: event.message.role } };
    case "message_update":
      return { type: event.type, data: { role: event.message.role } };
    case "tool_execution_start":
      return {
        type: event.type,
        data: { tool_call_id: event.toolCallId, tool_name: event.toolName, args: event.args },
      };
    case "tool_execution_update":
      return {
        type: event.type,
        data: {
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          partial_result: event.partialResult,
        },
      };
    case "tool_execution_end":
      return {
        type: event.type,
        data: {
          tool_call_id: event.toolCallId,
          tool_name: event.toolName,
          is_error: event.isError,
        },
      };
  }
}

export class PiAgentRuntime implements AgentRuntime {
  constructor(
    private readonly resolveModel: (
      binding: AgentTurnInput["model"],
    ) => ResolvedPiModel | Promise<ResolvedPiModel> = resolvePiModel,
  ) {}

  async run(input: AgentTurnInput): Promise<AgentTurnResult> {
    // Pi attaches the signal to the active stream, but a signal that was
    // already aborted before prompt() can otherwise still produce one model
    // request. The CRM contract promises cancellation at the runtime boundary,
    // so reject before constructing the loop as well.
    input.abortSignal?.throwIfAborted();
    if (input.contextProbe && (
      !input.contextProbe.id.trim() || input.contextProbe.id.length > 200 ||
      !input.contextProbe.userText.trim() || input.contextProbe.userText.length > 20_000
    )) throw new Error("pi_context_probe_invalid");
    const [{ Agent }, { Type }, resolved] = await Promise.all([
      loadPiAgentCore(),
      loadPiAi(),
      this.resolveModel(input.model),
    ]);
    const pendingObservations: Promise<void>[] = [];
    const observe = (observation: RuntimeObservation) => {
      if (!input.onObservation) return;
      // Observability is a separate side effect: it must never repeat or fail a CRM action.
      pendingObservations.push(
        Promise.resolve()
          .then(() => input.onObservation!(observation))
          .then(
            () => {},
            () => {},
          ),
      );
    };
    const observedStream: ResolvedPiModel["streamFn"] = async (model, context, options) => {
      const startedAt = now();
      const id = randomUUID();
      try {
        const stream = await resolved.streamFn(model, context, options);
        // result() does not consume the stream. Pi remains its single token consumer.
        void stream.result().then(
          (message) =>
            observe({
              id,
              kind: "generation",
              name: "model",
              startedAt,
              endedAt: now(),
              status:
                message.stopReason === "aborted"
                  ? "cancelled"
                  : message.stopReason === "error"
                    ? "error"
                    : "ok",
              model: input.model.model,
              provider: input.model.provider,
              messageCount: context.messages.length,
              usage: usageOf(message.usage),
            }),
          () =>
            observe({
              id,
              kind: "generation",
              name: "model",
              startedAt,
              endedAt: now(),
              status: "error",
            }),
        );
        return stream;
      } catch (error) {
        observe({
          id,
          kind: "generation",
          name: "model",
          startedAt,
          endedAt: now(),
          status: input.abortSignal?.aborted ? "cancelled" : "error",
        });
        throw error;
      }
    };
    const events: AgentRuntimeEvent[] = [];
    const calls: RuntimeToolCall[] = [];
    const toolByName = new Map((input.tools ?? []).map((tool) => [tool.name, tool]));
    let turns = 0;
    let usage: RuntimeUsage = { ...EMPTY_USAGE };
    const queuedSteering = new Map<string, string>();
    const steeringMessages = new Map<AgentMessage, string>();
    const steeringInModelContext = new Set<string>();
    const steeringSentToModel = new Set<string>();
    let contextProbeSeenInCurrentModelRequest = false;
    let contextProbeAcknowledged = false;

    const tools: AgentTool[] = (input.tools ?? []).map((tool) => {
      const parameters = Type.Unsafe(tool.inputSchema);
      return {
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters,
        execute: async (toolCallId, args, signal) => {
          const startedAt = now();
          let status: "ok" | "error" | "cancelled" = "error";
          try {
            const result = await tool.execute(args as Record<string, unknown>, {
              toolCallId,
              signal,
            });
            status = result.isError ? "error" : "ok";
            return {
              content: resultContent(result),
              details: result.details,
              ...(result.isError !== undefined ? { isError: result.isError } : {}),
              ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
            };
          } finally {
            observe({
              id: toolCallId,
              kind: "tool",
              name: tool.name,
              startedAt,
              endedAt: now(),
              status: signal?.aborted ? "cancelled" : status,
            });
          }
        },
      };
    });

    const history = input.messages?.map((message) => messageToPi(message, input.model));
    if (history?.[0]?.role === "system") {
      // Pi gives a replayed leading system message precedence over systemPrompt.
      // The CRM has already re-resolved current policy for this call: replace
      // only that baseline, retaining supplemental system updates, tool results,
      // and private provider continuation without mutating the caller's state.
      history[0] = { ...history[0], content: input.systemPrompt };
    }
    const agent = new Agent({
      initialState: {
        systemPrompt: input.systemPrompt,
        model: resolved.model,
        ...(tools.length > 0 ? { tools } : {}),
        ...(history !== undefined ? { messages: history } : {}),
      },
      streamFn: input.onObservation ? observedStream : resolved.streamFn,
      toolExecution: input.toolExecution ?? "parallel",
      transformContext: async (messages, signal) => {
        if (input.transformContext === undefined) return messages;
        const next = await input.transformContext(
          messages.flatMap((message) => {
            const converted = messageFromPi(message);
            return converted === null ? [] : [converted];
          }),
          signal,
        );
        return next.map((message) => messageToPi(message, input.model));
      },
      convertToLlm: (messages) => {
        const modelMessages = messages.filter(
          (message): message is Message =>
            message.role === "system" ||
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult",
        );
        // Pi calls convertToLlm after transformContext and immediately before
        // constructing the provider request. The transcript alone is weaker:
        // a future context transform may remove the manager's instruction.
        const probe = input.contextProbe;
        contextProbeSeenInCurrentModelRequest = probe !== undefined &&
          modelMessages.some((message) => message.role === "user" &&
            textOf(message.content).includes(probe.userText));
        // transformContext may remove a direction after Pi appended it to its
        // transcript. A message_end event alone is not proof it reached the LLM.
        for (const steeringId of steeringInModelContext) {
          const marker = steeringMarker(steeringId);
          if (modelMessages.some((message) => message.role === "user" &&
              textOf(message.content).includes(marker)))
            steeringSentToModel.add(steeringId);
        }
        return modelMessages;
      },
      beforeToolCall: async ({ toolCall, args }) => {
        const tool = toolByName.get(toolCall.name);
        calls.push({
          id: toolCall.id,
          name: toolCall.name,
          arguments: args as Record<string, unknown>,
        });
        if (tool === undefined || input.beforeToolCall === undefined) return undefined;
        return input.beforeToolCall({
          name: toolCall.name,
          args: args as Record<string, unknown>,
          toolCallId: toolCall.id,
        });
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        if (input.afterToolCall === undefined) return undefined;
        const decision = await input.afterToolCall({
          name: toolCall.name,
          args: args as Record<string, unknown>,
          toolCallId: toolCall.id,
          result: {
            content: result.content,
            details: result.details,
            isError,
            terminate: result.terminate,
          },
        });
        if (decision === undefined) return undefined;
        return {
          ...(decision.content !== undefined
            ? { content: resultContent({ content: decision.content }) }
            : {}),
          ...(decision.details !== undefined ? { details: decision.details } : {}),
          ...(decision.isError !== undefined ? { isError: decision.isError } : {}),
          ...(decision.terminate !== undefined ? { terminate: decision.terminate } : {}),
        };
      },
      shouldStopAfterTurn: async ({ message }) => {
        turns += 1;
        if (message.role === "assistant") {
          usage = addUsage(usage, usageOf(message.usage));
        }
        const converted = messageFromPi(message);
        const requested =
          converted === null
            ? false
            : await input.shouldStopAfterTurn?.({ message: converted, turn: turns, usage });
        return requested === true || (input.maxTurns !== undefined && turns >= input.maxTurns);
      },
    });

    const queuePendingSteering = async () => {
      if (!input.steering) return;
      const pending = await input.steering.poll();
      if (!Array.isArray(pending) || pending.length > 8)
        throw new Error("pi_steering_batch_invalid");
      const batchIdentity = new Map(queuedSteering);
      for (const item of pending) {
        if (item === null || typeof item !== "object" ||
            typeof item.id !== "string" || item.id.length > 200 || !item.id.trim() ||
            typeof item.content !== "string" || item.content.length > 20_000 ||
            !item.content.trim())
          throw new Error("pi_steering_message_invalid");
        const previous = batchIdentity.get(item.id);
        if (previous !== undefined && previous !== item.content)
          throw new Error("pi_steering_source_conflict");
        batchIdentity.set(item.id, item.content);
      }
      for (const item of pending) {
        const previous = queuedSteering.get(item.id);
        if (previous !== undefined) continue;
        queuedSteering.set(item.id, item.content);
        const message = messageToPi({ role: "user",
          content: `${steeringMarker(item.id)}\n${item.content}` }, input.model);
        steeringMessages.set(message, item.id);
        agent.steer(message);
        const queued: AgentRuntimeEvent = { type: "steering_queued", data: { steeringId: item.id } };
        events.push(queued);
        await input.onEvent?.(queued);
      }
    };

    agent.subscribe(async (event) => {
      const mapped = runtimeEvent(event);
      events.push(mapped);
      await input.onEvent?.(mapped);
      if (event.type === "message_end") {
        const steeringId = steeringMessages.get(event.message);
        if (steeringId !== undefined) steeringInModelContext.add(steeringId);
      }
      if (event.type !== "turn_end" || event.message.role !== "assistant") return;
      if (!contextProbeAcknowledged && contextProbeSeenInCurrentModelRequest && input.contextProbe &&
          event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
        const consumed: AgentRuntimeEvent = {
          type: "model_context_consumed", data: { probeId: input.contextProbe.id },
        };
        events.push(consumed);
        await input.onEvent?.(consumed);
        contextProbeAcknowledged = true;
      }
      contextProbeSeenInCurrentModelRequest = false;
      if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
        for (const steeringId of steeringSentToModel) {
          const consumed: AgentRuntimeEvent = { type: "steering_consumed", data: { steeringId } };
          events.push(consumed);
          await input.onEvent?.(consumed);
        }
        steeringInModelContext.clear();
        steeringSentToModel.clear();
      }
      if (!input.steering || event.message.stopReason === "error" ||
          event.message.stopReason === "aborted" || input.abortSignal?.aborted ||
          (input.maxTurns !== undefined && turns + 1 >= input.maxTurns)) return;
      await queuePendingSteering();
    });

    const abort = () => agent.abort();
    input.abortSignal?.addEventListener("abort", abort, { once: true });

    try {
      // Pi checks its steering queue before the first model request. A command
      // accepted just before this worker starts must not wait for a second turn.
      await queuePendingSteering();
      input.abortSignal?.throwIfAborted();
      await agent.prompt(input.prompt);
    } finally {
      input.abortSignal?.removeEventListener("abort", abort);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pendingObservations),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1500);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    const messages = agent.state.messages.flatMap((message) => {
      const converted = messageFromPi(message);
      return converted === null ? [] : [converted];
    });
    const assistant = [...messages].reverse().find((message) => message.role === "assistant");
    return {
      messages,
      finalText: assistant === undefined ? "" : textOf(assistant.content),
      usage,
      events,
      toolCalls: calls,
    };
  }
}
