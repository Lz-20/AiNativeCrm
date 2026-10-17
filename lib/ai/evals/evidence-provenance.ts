import type { RuntimeContent, RuntimeMessage } from "@/lib/agent-runtime";
import {
  WORKBENCH_FACT_FIELDS,
  type WorkbenchResultSubmission,
} from "@/lib/ai/agents/workbench-result-submission";
import type { AgentEvalRunInput } from "@/lib/ai/evals/contracts";

type SourceType = WorkbenchResultSubmission["evidence"][number]["sourceType"];
type Evidence = WorkbenchResultSubmission["evidence"];
type Scalar = string | number | boolean | null;

const assertableFields: Partial<Record<SourceType, ReadonlySet<string>>> = {
  contact: new Set(["is_blocked", "is_anonymized", "cpf_available"]),
  lead: new Set(["status", "stage_id", "value_cents", "currency", "expected_close_date"]),
  conversation: new Set(["status", "channel", "unread_count"]),
};
const safeFields = new Set<string>(WORKBENCH_FACT_FIELDS);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textOf(content: string | RuntimeContent[]): string {
  return typeof content === "string"
    ? content
    : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function observation(message: Extract<RuntimeMessage, { role: "tool" }>): Record<string, unknown> | null {
  const text = textOf(message.content).trim();
  if (text) {
    try {
      const parsed = record(JSON.parse(text));
      if (parsed) return parsed;
    } catch {
      // A malformed or plain-text observation cannot prove a structured id.
    }
  }
  return record(message.details);
}

function addRecords(
  observed: Set<string>,
  facts: Map<string, Map<string, Scalar>>,
  sourceType: SourceType,
  values: unknown,
  idField = "id",
): void {
  for (const value of Array.isArray(values) ? values : [values]) {
    const row = record(value);
    const id = row?.[idField];
    if (typeof id !== "string") continue;
    const key = `${sourceType}:${id.toLowerCase()}`;
    observed.add(key);
    const allowed = assertableFields[sourceType];
    if (!allowed || !row) continue;
    const values = facts.get(key) ?? new Map<string, Scalar>();
    for (const field of allowed) {
      if (!safeFields.has(field) || !Object.hasOwn(row, field)) continue;
      const value = row[field];
      if (value === null || typeof value === "string" ||
        typeof value === "number" && Number.isFinite(value) ||
        typeof value === "boolean") {
        values.set(field, value);
      }
    }
    facts.set(key, values);
  }
}

/**
 * Checks typed source IDs and opt-in scalar assertions against this run's
 * successful tool observations. It cannot prove free-text claim content or
 * that the CRM row still has the same value after the observation.
 */
export function auditWorkbenchEvidenceProvenance(
  evidence: Evidence,
  input: Pick<AgentEvalRunInput, "runtimeMessages" | "collaborationRuns" | "events">,
): { observed: number; unobserved: number; verified: number; mismatched: number; unverifiable: number } {
  const observed = new Set<string>();
  const facts = new Map<string, Map<string, Scalar>>();
  for (const message of input.runtimeMessages) {
    if (message.role !== "tool" || message.isError) continue;
    const value = observation(message);
    if (!value) continue;
    switch (message.toolName) {
      case "crm_search_contacts":
        addRecords(observed, facts, "contact", value.contacts);
        break;
      case "crm_get_contact":
        addRecords(observed, facts, "contact", value.contact ?? value);
        break;
      case "crm_list_leads":
        addRecords(observed, facts, "lead", value.leads);
        break;
      case "crm_get_lead":
        addRecords(observed, facts, "lead", value.lead ?? value);
        break;
      case "crm_list_conversations":
        addRecords(observed, facts, "conversation", value.conversations);
        break;
      case "crm_get_conversation":
        addRecords(observed, facts, "conversation", value.conversation ?? value);
        break;
      case "crm_get_org_memory":
        addRecords(observed, facts, "knowledge", value.evidence);
        break;
      case "crm_search_knowledge":
        addRecords(observed, facts, "knowledge", value.evidence);
        addRecords(observed, facts, "knowledge", value.trechos, "chunk_id");
        break;
      default:
        break;
    }
  }
  addRecords(observed, facts, "specialist", input.collaborationRuns ?? []);
  addRecords(observed, facts, "run_event", input.events);
  const matched = evidence.filter((item) => observed.has(`${item.sourceType}:${item.sourceId.toLowerCase()}`)).length;
  let verified = 0;
  let mismatched = 0;
  let unverifiable = 0;
  for (const item of evidence) {
    const key = `${item.sourceType}:${item.sourceId.toLowerCase()}`;
    const values = facts.get(key);
    const allowed = assertableFields[item.sourceType];
    for (const assertion of item.assertions ?? []) {
      if (!observed.has(key) || !allowed?.has(assertion.field) || !values?.has(assertion.field)) {
        unverifiable += 1;
      } else if (Object.is(values.get(assertion.field), assertion.equals)) {
        verified += 1;
      } else {
        mismatched += 1;
      }
    }
  }
  return { observed: matched, unobserved: evidence.length - matched, verified, mismatched, unverifiable };
}
