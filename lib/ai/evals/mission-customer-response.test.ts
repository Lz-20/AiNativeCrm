import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { loadMissionCustomerResponses } from "./mission-customer-response";

const orgId = "11111111-1111-4111-8111-111111111111";
const outboundId = "22222222-2222-4222-8222-222222222222";

function fakeDb(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { db: { query } as unknown as Queryable, query };
}

describe("mission customer response evidence", () => {
  it("does not query when there is no sent CRM message", async () => {
    const { db, query } = fakeDb([]);
    expect(await loadMissionCustomerResponses(db, orgId, [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("loads only a later inbound text from the same tenant, contact and conversation", async () => {
    const { db, query } = fakeDb([{
      outbound_message_id: outboundId,
      reply_id: "33333333-3333-4333-8333-333333333333",
      reply_contact_id: "44444444-4444-4444-8444-444444444444",
      reply_conversation_id: "55555555-5555-4555-8555-555555555555",
      reply_sent_at: new Date("2026-09-30T00:02:00Z"),
    }]);
    const rows = await loadMissionCustomerResponses(db, orgId, [outboundId, outboundId]);
    expect(rows).toMatchObject([{ outboundMessageId: outboundId, reply: {
      id: "33333333-3333-4333-8333-333333333333", sentAt: "2026-09-30T00:02:00.000Z",
    } }]);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([orgId, [outboundId]]);
    expect(sql).toContain("m.organization_id=$1");
    expect(sql).toContain("outbound.organization_id=$1");
    expect(sql).toContain("m.contact_id=outbound.contact_id");
    expect(sql).toContain("m.conversation_id=outbound.conversation_id");
    expect(sql).toContain("m.sent_at>outbound.sent_at");
    expect(sql).toContain("m.direction='inbound' and m.type='text'");
    expect(sql).not.toMatch(/(?:select|,)\s*(?:m|outbound)\.body\s*(?:as|,|from)/i);
  });

  it("keeps a missing reply distinct from a missing outbound record", async () => {
    const { db } = fakeDb([{ outbound_message_id: outboundId, reply_id: null }]);
    expect(await loadMissionCustomerResponses(db, orgId, [outboundId]))
      .toEqual([{ outboundMessageId: outboundId, reply: null }]);
  });

  it("rejects duplicate or unrelated rows", async () => {
    const row = { outbound_message_id: outboundId, reply_id: null };
    await expect(loadMissionCustomerResponses(fakeDb([row, row]).db, orgId, [outboundId]))
      .rejects.toThrow("mission_customer_response_evidence_invalid");
    await expect(loadMissionCustomerResponses(fakeDb([{ ...row, outbound_message_id: orgId }]).db,
      orgId, [outboundId]))
      .rejects.toThrow("mission_customer_response_evidence_invalid");
  });
});
