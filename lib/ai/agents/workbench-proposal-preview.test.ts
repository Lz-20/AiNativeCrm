import { describe, expect, it } from "vitest";
import { followupProposalPreview } from "./workbench-proposal-preview";
const lead = "11111111-1111-4111-8111-111111111111";
describe("safe follow-up approval preview", () => {
  it("shows target and relative due time using the same precedence as the real tool", () => {
    expect(
      followupProposalPreview("crm_schedule_followup", {
        lead_id: lead,
        in_hours: 24,
        promised_at: "2026-01-01T00:00:00Z",
        reason: "private note",
        promise: "private customer commitment",
        token: "secret",
      }),
    ).toEqual({ targetKind: "lead", targetId: lead, inHours: 24 });
  });
  it("uses an absolute ISO instant only when relative scheduling is absent", () => {
    expect(
      followupProposalPreview("crm_schedule_followup", {
        contact_id: lead,
        promised_at: "2026-10-02T08:00:00Z",
      }),
    ).toEqual({ targetKind: "contact", targetId: lead, promisedAt: "2026-10-02T08:00:00Z" });
  });
  it("does not copy arbitrary/invalid arguments to the manager-readable preview", () => {
    expect(
      followupProposalPreview("crm_schedule_followup", {
        lead_id: "secret",
        promised_at: "tomorrow",
      }),
    ).toEqual({});
    expect(followupProposalPreview("unknown", { contact_id: lead })).toEqual({});
  });
});
