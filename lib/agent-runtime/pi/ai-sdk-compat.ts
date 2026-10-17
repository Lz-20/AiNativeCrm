import type { ModelMessage, ToolSet } from "ai";

import type {
  RuntimeContent,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentTurnInput,
  RuntimeMessage,
  RuntimeModelBinding,
  RuntimeTool,
  RuntimeToolResult,
  ToolEffect,
} from "../types";
import { createAgentRuntime } from "../factory";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textFromRuntimeContent(value: RuntimeMessage["content"]): string {
  return typeof value === "string"
    ? value
    : value
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}

function aiPartToRuntime(part: unknown): RuntimeContent | null {
  const record = asRecord(part);
  if (record.type === "text" && typeof record.text === "string") {
    return { type: "text", text: record.text };
  }
  if (record.type === "image" && typeof record.image === "string") {
    return {
      type: "image",
      data: record.image,
      mimeType: String(record.mediaType ?? record.mimeType ?? "image/*"),
    };
  }
  return null;
}

function aiMessageToRuntime(message: ModelMessage): RuntimeMessage[] {
  const record = message as unknown as UnknownRecord;
  if (message.role === "system") {
    return [{ role: "system", content: textFromUnknown(record.content) }];
  }
  if (message.role === "user") {
    if (typeof record.content === "string") return [{ role: "user", content: record.content }];
    const parts = Array.isArray(record.content)
      ? record.content.map(aiPartToRuntime).filter((part): part is RuntimeContent => part !== null)
      : [];
    return [{ role: "user", content: parts }];
  }
  if (message.role === "assistant") {
    const parts = Array.isArray(record.content) ? record.content : [];
    const content = parts
      .map(aiPartToRuntime)
      .filter((part): part is RuntimeContent => part !== null);
    const toolCalls = parts
      .filter((part) => asRecord(part).type === "tool-call")
      .map((part) => {
        const call = asRecord(part);
        return {
          id: String(call.toolCallId ?? ""),
          name: String(call.toolName ?? ""),
          arguments: asRecord(call.input),
        };
      })
      .filter((call) => call.id !== "" && call.name !== "");
    return [
      {
        role: "assistant",
        content: content.length === 0 ? "" : content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
    ];
  }

  const parts = Array.isArray(record.content) ? record.content : [];
  return parts
    .filter((part) => asRecord(part).type === "tool-result")
    .map((part) => {
      const result = asRecord(part);
      const output = asRecord(result.output);
      return {
        role: "tool" as const,
        toolCallId: String(result.toolCallId ?? ""),
        toolName: String(result.toolName ?? ""),
        content: textFromUnknown(output.value ?? result.output),
      };
    })
    .filter((message) => message.toolCallId !== "");
}

function runtimeMessageToAi(message: RuntimeMessage): ModelMessage | null {
  if (message.role === "system") return null;
  if (message.role === "user") return { role: "user", content: message.content as never };
  if (message.role === "assistant") {
    const parts = [
      ...(typeof message.content === "string"
        ? message.content === ""
          ? []
          : [{ type: "text" as const, text: message.content }]
        : message.content.filter((part) => part.type === "text")),
      ...(message.toolCalls ?? []).map((call) => ({
        type: "tool-call" as const,
        toolCallId: call.id,
        toolName: call.name,
        input: call.arguments,
      })),
    ];
    return { role: "assistant", content: parts } as ModelMessage;
  }
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        output: { type: "text", value: textFromRuntimeContent(message.content) },
      },
    ],
  } as ModelMessage;
}

function schemaOf(tool: unknown): Record<string, unknown> {
  const schema = asRecord(tool).inputSchema;
  const toJsonSchema = asRecord(schema).toJSONSchema;
  if (typeof toJsonSchema === "function") {
    const json = (toJsonSchema as () => unknown)();
    if (json !== null && typeof json === "object") return json as Record<string, unknown>;
  }
  if (schema !== null && typeof schema === "object") return schema as Record<string, unknown>;
  return { type: "object", properties: {} };
}

function capabilityOf(name: string): RuntimeTool["capability"] {
  const normalized = name.toLowerCase();
  if (normalized.includes("send")) return "send";
  if (normalized.includes("handoff") || normalized.includes("human_case")) return "handoff";
  if (
    normalized.includes("update") ||
    normalized.includes("save") ||
    normalized.includes("schedule") ||
    normalized.includes("create") ||
    normalized.includes("delete") ||
    normalized.includes("assign") ||
    normalized.includes("write")
  )
    return "write";
  return "read";
}

function declaredCapability(value: unknown): RuntimeTool["capability"] | undefined {
  return value === "read" ||
    value === "write" ||
    value === "send" ||
    value === "handoff" ||
    value === "external"
    ? value
    : undefined;
}

function adaptedToolResult(value: unknown): RuntimeToolResult {
  const record = asRecord(value);
  const content = record.content;
  if (typeof content === "string" || Array.isArray(content)) {
    return {
      content,
      ...(record.details !== undefined ? { details: record.details } : {}),
      ...(record.isError === true ? { isError: true } : {}),
      ...(record.terminate === true ? { terminate: true } : {}),
    };
  }
  return { content: textFromUnknown(value), details: value };
}

export function adaptAiTools(tools: ToolSet | undefined): RuntimeTool[] {
  if (tools === undefined) return [];
  return Object.entries(tools).flatMap(([name, tool]) => {
    const record = asRecord(tool);
    const execute = record.execute;
    if (typeof execute !== "function") return [];
    const effect = ["read", "reversible_write", "external", "irreversible"].includes(String(record.effect))
      ? record.effect as ToolEffect
      : undefined;
    return [
      {
        name,
        description: typeof record.description === "string" ? record.description : name,
        inputSchema: schemaOf(tool),
        capability: declaredCapability(record.capability) ?? capabilityOf(name),
        ...(effect ? { effect } : {}),
        ...(typeof record.resource === "string" ? { resource: record.resource } : {}),
        ...(typeof record.preview === "function"
          ? { preview: async (args: Record<string, unknown>) => await (record.preview as (input: Record<string, unknown>) => unknown)(args) as never }
          : {}),
        ...(typeof record.compensate === "function"
          ? { compensate: async (args: Record<string, unknown>) => await (record.compensate as (input: Record<string, unknown>) => unknown)(args) as never }
          : {}),
        execute: async (args, context) => {
          const value = await (execute as (args: unknown, options: unknown) => unknown)(args, {
            toolCallId: context.toolCallId,
            messages: [],
          });
          return adaptedToolResult(value);
        },
      } satisfies RuntimeTool,
    ];
  });
}

export interface PiAiSdkCallInput {
  system: string;
  messages: ModelMessage[];
  /** CRM-owned serializable conversation state restored for a continuation. */
  runtimeMessages?: RuntimeMessage[];
  tools?: ToolSet;
  model: RuntimeModelBinding;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  evaluation?: boolean;
  runtime?: AgentRuntime;
  transformContext?: AgentTurnInput["transformContext"];
  contextProbe?: AgentTurnInput["contextProbe"];
  beforeToolCall?: AgentTurnInput["beforeToolCall"];
  afterToolCall?: AgentTurnInput["afterToolCall"];
  steering?: AgentTurnInput["steering"];
  shouldStopAfterTurn?: AgentTurnInput["shouldStopAfterTurn"];
  onObservation?: AgentTurnInput["onObservation"];
  onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
}

export async function runPiAiSdkCall(input: PiAiSdkCallInput) {
  const runtimeMessages = input.runtimeMessages ?? input.messages.flatMap(aiMessageToRuntime);
  const last = runtimeMessages.at(-1);
  const prompt = last?.role === "user" ? textFromUnknown(last.content) : "";
  const history = last?.role === "user" ? runtimeMessages.slice(0, -1) : runtimeMessages;
  const tools = adaptAiTools(input.tools);
  const runtime = input.runtime ?? createAgentRuntime();
  const result = await runtime.run({
    systemPrompt: input.system,
    messages: history,
    prompt,
    model: input.model,
    tools,
    maxTurns: input.maxSteps ?? 1,
    abortSignal: input.abortSignal,
    ...(input.transformContext ? { transformContext: input.transformContext } : {}),
    ...(input.contextProbe ? { contextProbe: input.contextProbe } : {}),
    ...(input.evaluation
      ? {
          beforeToolCall: async (toolCall) => {
            const tool = tools.find((candidate) => candidate.name === toolCall.name);
            if (tool?.capability === "read") return input.beforeToolCall?.(toolCall);
            const decision = {
              block: true,
              terminate: true,
              reason: "evaluation runtime blocks CRM mutations and external side effects",
            };
            return decision;
          },
        }
      : input.beforeToolCall
        ? { beforeToolCall: input.beforeToolCall }
        : {}),
    ...(input.afterToolCall ? { afterToolCall: input.afterToolCall } : {}),
    ...(input.steering ? { steering: input.steering } : {}),
    ...(input.onObservation ? { onObservation: input.onObservation } : {}),
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    ...(input.shouldStopAfterTurn ? { shouldStopAfterTurn: input.shouldStopAfterTurn } : {}),
  });

  return {
    text: result.finalText,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      inputTokenDetails: {
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
      },
    },
    response: {
      messages: result.messages
        .map(runtimeMessageToAi)
        .filter((message): message is ModelMessage => message !== null),
    },
    runtimeMessages: result.messages,
    events: result.events,
    steps: [
      {
        text: result.finalText,
        toolCalls: result.toolCalls.map((call) => ({
          toolCallId: call.id,
          toolName: call.name,
          input: call.arguments,
        })),
      },
    ],
    turnCount: result.events.filter((event) => event.type === "turn_end").length,
  };
}
