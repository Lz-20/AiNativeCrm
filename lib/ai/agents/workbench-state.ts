import type { RuntimeContent, RuntimeMessage } from "@/lib/agent-runtime";
import type { AgentEvidenceClaim } from "@/lib/ai/agents/collaboration";
import type { KnowledgeEvidence } from "@/lib/ai/knowledge/contracts";

function parseToolCalls(
  value: unknown,
): NonNullable<Extract<RuntimeMessage, { role: "assistant" }>["toolCalls"]> | null {
  if (!Array.isArray(value)) return null;
  const calls: NonNullable<Extract<RuntimeMessage, { role: "assistant" }>["toolCalls"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const call = item as Record<string, unknown>;
    if (
      typeof call.id !== "string" ||
      typeof call.name !== "string" ||
      !call.arguments ||
      typeof call.arguments !== "object" ||
      Array.isArray(call.arguments)
    )
      return null;
    calls.push({
      id: call.id,
      name: call.name,
      arguments: call.arguments as Record<string, unknown>,
    });
  }
  return calls;
}

const SECRET_KEY = /api.?key|secret|password|credential|authorization/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : redact(item),
      ]),
    );
  }
  return value;
}

/** Parse JSONB at the service boundary; corrupt or old state fails closed. */
export function parseRuntimeMessages(value: unknown): RuntimeMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: RuntimeMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const message = item as Record<string, unknown>;
    if (message.role === "system" && typeof message.content === "string") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    if (
      (message.role === "user" || message.role === "assistant") &&
      (typeof message.content === "string" || Array.isArray(message.content))
    ) {
      const content = message.content as string | RuntimeContent[];
      if (message.role === "user") messages.push({ role: "user", content });
      else {
        const toolCalls = message.toolCalls === undefined ? [] : parseToolCalls(message.toolCalls);
        if (toolCalls === null) return null;
        messages.push({
          role: "assistant",
          content,
          ...(toolCalls.length ? { toolCalls } : {}),
          ...(message.privateContinuation !== undefined
            ? { privateContinuation: message.privateContinuation }
            : {}),
        });
      }
      continue;
    }
    if (
      message.role === "tool" &&
      typeof message.toolCallId === "string" &&
      typeof message.toolName === "string" &&
      (typeof message.content === "string" || Array.isArray(message.content))
    ) {
      messages.push({
        role: "tool",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content as string | RuntimeContent[],
        isError: message.isError === true,
        ...(message.details !== undefined ? { details: message.details } : {}),
      });
      continue;
    }
    return null;
  }
  return messages;
}

/** Append a bounded, secret-redacted CRM observation as the next Pi user turn. */
export function appendWorkbenchObservation(
  messages: RuntimeMessage[],
  observation: { tool: string; status: "executed" | "rejected" | "failed"; result?: unknown },
): RuntimeMessage[] {
  const safe = redact(observation);
  let serialized = JSON.stringify(safe);
  if (serialized.length > 12_000) serialized = `${serialized.slice(0, 12_000)}…[truncated]`;
  return [
    ...messages,
    {
      role: "user",
      content: `CRM Harness 执行动作后的观察结果。请基于此结果继续原任务；不要重复已经执行的动作。\n${serialized}`,
    },
  ];
}

/** Preserve the complete model turn before recording CRM-owned execution results. */
export function continueWorkbenchMessages(
  modelMessages: RuntimeMessage[],
  observations: Array<{ tool: string; status: "executed" | "rejected" | "failed"; result?: unknown }>,
): RuntimeMessage[] {
  return observations.reduce(appendWorkbenchObservation, modelMessages);
}

/** `ai_agent_run_states.observations` is always a JSON array, including specialist evidence. */
export function specialistObservationEnvelope(
  evidence: KnowledgeEvidence[],
  claims: AgentEvidenceClaim[],
): Array<{
  kind: "specialist_evidence";
  evidence: KnowledgeEvidence[];
  claims: AgentEvidenceClaim[];
}> {
  return [{ kind: "specialist_evidence", evidence, claims }];
}
