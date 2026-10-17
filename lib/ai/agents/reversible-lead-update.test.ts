import { describe, expect, it, vi } from "vitest";
import { executeReversibleLeadUpdate } from "./reversible-lead-update";

describe("reversible CRM lead updates", () => {
  it("reads through the CRM tool, uses optimistic locking, and creates a business inverse", async () => {
    const get = vi.fn().mockResolvedValue({ lead: {
      id: "lead-1", updated_at: "2026-09-26T01:00:00.000Z", title: "Old title",
      description: null, contact_id: "contact-1", value_cents: 1000,
      currency: "BRL", expected_close_date: null,
    } });
    const update = vi.fn().mockResolvedValue({ lead: { updated_at: "2026-09-26T01:01:00.000Z" } });
    const result = await executeReversibleLeadUpdate({
      args: { lead_id: "lead-1", title: "New title" },
      tools: { crm_get_lead: { execute: get }, crm_update_lead: { execute: update } },
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      lead_id: "lead-1", title: "New title", expected_updated_at: "2026-09-26T01:00:00.000Z",
    }), expect.any(Object));
    expect(result?.compensationArgs).toEqual({
      lead_id: "lead-1", title: "Old title", expected_updated_at: "2026-09-26T01:01:00.000Z",
    });
    expect(result?.preview.changedFields).toEqual(["title"]);
  });

  it("fails closed for fields without exact compensation", async () => {
    const execute = vi.fn();
    const result = await executeReversibleLeadUpdate({
      args: { lead_id: "lead-1", custom_fields: { priority: "high" } },
      tools: { crm_get_lead: { execute }, crm_update_lead: { execute } },
    });
    expect(result).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
