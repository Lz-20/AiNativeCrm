import type { RuntimeMessage } from "@/lib/agent-runtime";

/** Public evidence projection, not the production telemetry exporter.
 * Only an explicitly verified synthetic demo may use this projection.
 * Unknown fields, system/assistant messages and private continuation never leave it.
 */
export function publicDemoText(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[密钥已移除]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[邮箱已移除]")
    .replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, "[演示对象 ID]")
    .replace(/\+?\d[\d -]{9,}\d/g, "[电话已移除]");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function memory(value: unknown) {
  const m = object(value);
  if (!Object.keys(m).length) return { coverage: "not_returned", confirmedCount: 0 };
  const facts = Array.isArray(m.memories) ? m.memories : [];
  return {
    status: typeof m.status === "string" ? publicDemoText(m.status) : null,
    coverage: typeof m.coverage === "string" ? publicDemoText(m.coverage) : "unknown",
    providerStatus: typeof m.providerStatus === "string" ? publicDemoText(m.providerStatus) : "unknown",
    confirmedCount: facts.length,
    facts: facts.flatMap(value => {
      const row = object(value);
      return typeof row.body === "string" && row.body.startsWith("[演示合成事实]")
        ? [{ body: publicDemoText(row.body), authority: "customer_context_only" }] : [];
    }),
  };
}
export function publicDemoTools(messages: RuntimeMessage[]) {
  const calls = new Map(messages.flatMap(message => message.role === "assistant"
    ? (message.toolCalls ?? []).map(call => [call.id, call] as const) : []));
  return messages.flatMap(message => {
    if (message.role !== "tool" || !/^crm_[a-z_]+$/.test(message.toolName)) return [];
    let result: Record<string, unknown> = {};
    try {
      const text = typeof message.content === "string" ? message.content : message.content
        .filter(part => part.type === "text").map(part => part.text).join("\n");
      result = object(message.details ?? JSON.parse(text));
    } catch { /* No raw or malformed tool body is published. */ }
    const args = calls.get(message.toolCallId)?.arguments ?? {};
    const input = Object.fromEntries(Object.entries(args).flatMap<[string, string | number]>(([key, value]) => {
      if (["contact_id", "conversation_id", "lead_id", "pipeline_id"].includes(key)) return [[key, "[演示对象 ID]"]];
      if (key === "query") return [[key, value === "林晓梅" ? value : "[已脱敏搜索词]"]];
      if (["limit", "offset"].includes(key) && typeof value === "number") return [[key, value]];
      return [];
    }));
    const observation: Record<string, unknown> = { status: message.isError ? "error" : "success" };
    if (message.toolName === "crm_get_contact") observation.confirmedCustomerMemory = memory(result.confirmed_customer_memory);
    if (message.toolName === "crm_get_conversation_history") {
      observation.messageCount = Array.isArray(result.messages) ? result.messages.length : 0;
      const m = object(result.customer_memory);
      observation.confirmedCustomerMemory = memory(m.confirmed_customer_memory);
    }
    for (const key of ["contacts", "conversations", "leads", "tasks", "evidence", "entries"])
      if (Array.isArray(result[key])) observation[`${key}Count`] = result[key].length;
    return [{ name: message.toolName, input, observation }];
  });
}
