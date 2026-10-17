import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { loadMissionDeliveryEvidence } from "./mission-delivery-evidence";

const orgId = "a3860000-0000-4000-8000-000000000001";
const proposalId = "a3860000-0000-4000-8000-000000000002";

function dbWithRows(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { db: { query } as unknown as Queryable, query };
}

describe("mission delivery receipt loader", () => {
  it("does not query when no send proposal exists", async () => {
    const { db, query } = dbWithRows([]);
    expect(await loadMissionDeliveryEvidence(db, orgId, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("loads only organization-scoped receipt metadata and preserves missing rows", async () => {
    const { db, query } = dbWithRows([{
      proposal_id: proposalId,
      draft_status: "sent",
      draft_message_id: "message-1",
      draft_contact_id: "contact-1",
      draft_conversation_id: "conversation-1",
      send_job_id: "job-1",
      approved_at: new Date("2026-09-30T00:00:00Z"),
      approved_body_matches_ledger: null,
      ledger_idempotency_key: null,
      ledger_job_id: null,
      ledger_status: null,
      actual_message_id: null,
    }]);
    const result = await loadMissionDeliveryEvidence(db, orgId, [proposalId]);
    expect(result).toMatchObject([{
      proposalId, status: "sent", approvedAt: "2026-09-30T00:00:00.000Z",
      ledger: null, message: null,
    }]);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([orgId, [proposalId]]);
    expect(sql).toContain("where d.organization_id=$1 and d.workbench_proposal_id=any($2::uuid[])");
    expect(sql).toContain("l.organization_id=d.organization_id");
    expect(sql).toContain("m.organization_id=d.organization_id");
    expect(sql).toContain("m.metadata->>'idempotency_key'");
    expect(sql).toContain("sha256(convert_to(d.approved_body,'UTF8'))");
    expect(sql).toContain("sha256(convert_to(m.body,'UTF8'))");
    expect(sql).not.toMatch(/d\.(original_body|edited_body)/);
    expect(sql).not.toMatch(/(?:select|,)\s*(?:d\.approved_body|m\.body)\s*(?:as|,|from)/i);
  });

  it("rejects duplicate receipt rows instead of using an arbitrary match", async () => {
    const row = { proposal_id: proposalId };
    const { db } = dbWithRows([row, row]);
    await expect(loadMissionDeliveryEvidence(db, orgId, [proposalId]))
      .rejects.toThrow("mission_delivery_evidence_duplicate");
  });
});
