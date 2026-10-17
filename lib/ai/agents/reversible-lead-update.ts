import { randomUUID } from "node:crypto";

const RESTORABLE_FIELDS = [
  "title",
  "description",
  "contact_id",
  "value_cents",
  "currency",
  "expected_close_date",
] as const;
type RestorableField = (typeof RESTORABLE_FIELDS)[number];

type ExecutableTool = {
  execute: (args: unknown, options: { toolCallId: string; messages: never[]; context: object }) => Promise<unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolOutput(value: unknown): Record<string, unknown> | null {
  const outer = record(value);
  if (!outer || outer.isError === true || outer.ok === false) return null;
  return record(outer.lead) ?? record(record(outer.structuredContent)?.lead);
}

/**
 * Perform the narrowly reversible subset of crm_update_lead. Both the snapshot
 * and mutation travel through organization-scoped CRM tools; unsupported fields
 * fail closed and stay as a human proposal.
 */
export async function executeReversibleLeadUpdate(input: {
  args: unknown;
  tools: Record<string, ExecutableTool | undefined>;
}): Promise<{
  result: unknown;
  compensationArgs: Record<string, unknown>;
  preview: { resource: "crm_leads"; resourceUuid: string; changedFields: string[] };
} | null> {
  const args = record(input.args);
  if (!args || typeof args.lead_id !== "string") return null;
  const fields = Object.keys(args).filter((key) => key !== "lead_id" && key !== "expected_updated_at");
  if (!fields.length || fields.some((field) => !RESTORABLE_FIELDS.includes(field as RestorableField))) return null;
  const reader = input.tools.crm_get_lead;
  const updater = input.tools.crm_update_lead;
  if (!reader?.execute || !updater?.execute) return null;

  const context = { toolCallId: randomUUID(), messages: [] as never[], context: {} };
  const before = toolOutput(await reader.execute({ lead_id: args.lead_id }, context));
  if (!before || typeof before.updated_at !== "string") return null;
  const patch: Record<string, unknown> = { lead_id: args.lead_id, expected_updated_at: before.updated_at };
  const compensationArgs: Record<string, unknown> = { lead_id: args.lead_id };
  for (const field of fields as RestorableField[]) {
    if (!(field in before)) return null;
    patch[field] = args[field];
    compensationArgs[field] = before[field] ?? null;
  }

  const result = await updater.execute(patch, context);
  const after = toolOutput(result);
  if (!after || typeof after.updated_at !== "string")
    throw new Error("reversible_lead_update_result_missing");
  compensationArgs.expected_updated_at = after.updated_at;
  return {
    result,
    compensationArgs,
    preview: { resource: "crm_leads", resourceUuid: args.lead_id, changedFields: fields },
  };
}
