import { z } from "zod";

/** Manager-readable scheduling facts only, never arbitrary tool args or customer text. */
export function followupProposalPreview(tool: string, value: unknown): Record<string, unknown> {
  if (tool !== "crm_schedule_followup" || !value || typeof value !== "object") return {};
  const args = value as Record<string, unknown>;
  const leadId = z.string().uuid().safeParse(args.lead_id);
  const contactId = z.string().uuid().safeParse(args.contact_id);
  const inHours = z.number().positive().max(4320).safeParse(args.in_hours);
  const promisedAt = z.iso.datetime({ offset: true }).safeParse(args.promised_at);
  return {
    ...(leadId.success
      ? { targetKind: "lead", targetId: leadId.data }
      : contactId.success
        ? { targetKind: "contact", targetId: contactId.data }
        : {}),
    ...(inHours.success
      ? { inHours: inHours.data }
      : promisedAt.success
        ? { promisedAt: promisedAt.data }
        : {}),
  };
}
