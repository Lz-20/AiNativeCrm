import { createHash } from "node:crypto";

import type { RuntimeMessage } from "@/lib/agent-runtime";
import type { AgentEvidenceClaim } from "@/lib/ai/agents/collaboration";

const MAX_CLAIMS_PER_OBSERVATION = 128;
const MAX_FIELD_DEPTH = 2;
const REVISION_FIELDS = ["revision", "version", "updated_at", "updatedAt", "modified_at"];

const TOOL_RESOURCE: Readonly<Record<string, string>> = {
  crm_get_contact: "contact",
  crm_search_contacts: "contact",
  crm_list_conversations: "conversation",
  crm_get_conversation_history: "conversation_message",
  crm_get_lead: "lead",
  crm_list_leads: "lead",
  crm_list_followups: "followup",
  crm_search_knowledge: "knowledge_evidence",
  crm_get_org_memory: "organization_memory",
  crm_list_automation_runs: "automation_run",
};

type Scalar = string | number | boolean | null;

function textOf(message: Extract<RuntimeMessage, { role: "tool" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function structuredValue(message: Extract<RuntimeMessage, { role: "tool" }>): unknown {
  if (message.details && typeof message.details === "object") return message.details;
  const text = textOf(message).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isScalar(value: unknown): value is Scalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function canonical(value: unknown): string {
  if (isScalar(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(String(value));
}

function valueType(value: Scalar | Scalar[]): AgentEvidenceClaim["valueType"] {
  if (Array.isArray(value)) return "scalar_array";
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function revisionOf(record: Record<string, unknown>): string | undefined {
  for (const field of REVISION_FIELDS) {
    const value = record[field];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return undefined;
}

function scalarFields(
  record: Record<string, unknown>,
  prefix = "",
  depth = 0,
): Array<{ field: string; value: Scalar | Scalar[] }> {
  const fields: Array<{ field: string; value: Scalar | Scalar[] }> = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === "id" || REVISION_FIELDS.includes(key)) continue;
    const field = prefix ? `${prefix}.${key}` : key;
    if (isScalar(value)) fields.push({ field, value });
    else if (Array.isArray(value) && value.every(isScalar)) fields.push({ field, value });
    else if (value && typeof value === "object" && !Array.isArray(value) && depth < MAX_FIELD_DEPTH)
      fields.push(...scalarFields(value as Record<string, unknown>, field, depth + 1));
  }
  return fields;
}

function recordId(value: Record<string, unknown>): string | null {
  const id = value.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

function collectRecords(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (recordId(record)) output.push(record);
  for (const child of Object.values(record)) collectRecords(child, output);
}

function fallbackSubjectId(
  toolName: string,
  scope: { contactId?: string; leadId?: string; conversationId?: string; pipelineId?: string },
): string | null {
  const resource = TOOL_RESOURCE[toolName] ?? "";
  if (resource === "contact") return scope.contactId ?? null;
  if (resource === "lead") return scope.leadId ?? null;
  if (resource.startsWith("conversation")) return scope.conversationId ?? null;
  if (resource === "pipeline") return scope.pipelineId ?? null;
  return null;
}

/**
 * Converts a CRM tool observation into value-hashed, source-addressable claims.
 * Raw field values never enter the collaboration contract or parent event log.
 */
export function extractToolClaims(input: {
  message: Extract<RuntimeMessage, { role: "tool" }>;
  specialistKey: string;
  scope: { contactId?: string; leadId?: string; conversationId?: string; pipelineId?: string };
}): AgentEvidenceClaim[] {
  if (input.message.isError) return [];
  const value = structuredValue(input.message);
  if (!value || typeof value !== "object") return [];
  const resource = TOOL_RESOURCE[input.message.toolName] ?? "crm_record";
  const records: Record<string, unknown>[] = [];
  collectRecords(value, records);
  if (records.length === 0 && !Array.isArray(value)) {
    const fallbackId = fallbackSubjectId(input.message.toolName, input.scope);
    if (fallbackId) records.push({ ...(value as Record<string, unknown>), id: fallbackId });
  }

  const claims: AgentEvidenceClaim[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const subjectId = recordId(record);
    if (!subjectId) continue;
    const revision = revisionOf(record);
    for (const { field, value: fieldValue } of scalarFields(record)) {
      const valueHash = hash(fieldValue);
      const key = `${resource}:${subjectId}:${field}:${valueHash}:${revision ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({
        id: createHash("sha256").update(`${input.specialistKey}:${key}`).digest("hex"),
        specialistKey: input.specialistKey,
        subject: { resource, id: subjectId },
        field,
        valueHash,
        valueType: valueType(fieldValue),
        locator: {
          provider: "crm_tool",
          sourceId: `${resource}:${subjectId}`,
          ...(revision ? { revision } : {}),
        },
      });
      if (claims.length >= MAX_CLAIMS_PER_OBSERVATION) return claims;
    }
  }
  return claims;
}
