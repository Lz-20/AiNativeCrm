import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import {
  loadCustomerAcceptanceMaterial,
  validateCustomerAcceptanceAssessment,
  type CustomerAcceptanceMaterial,
} from "./mission-customer-acceptance";

const orgId = "11111111-1111-4111-8111-111111111111";
const contactId = "22222222-2222-4222-8222-222222222222";
const outboundId = "33333333-3333-4333-8333-333333333333";
const inboundId = "44444444-4444-4444-8444-444444444444";
const criteria = "客户明确接受报价 1200 元和周五交付";

function fakePool(rows: Record<string, unknown>[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { pool: { query } as unknown as pg.Pool, query };
}

const material: CustomerAcceptanceMaterial = {
  criteria,
  messages: [{ id: inboundId, sentAt: "2026-09-30T02:00:00.000Z",
    body: "我确认接受 1200 元报价，周五交付。" }],
};

describe("independent customer acceptance material", () => {
  it("only reads same-organization, same-contact and same-conversation inbound text after a verified send", async () => {
    const { pool, query } = fakePool([{ id: inboundId,
      sent_at: new Date("2026-09-30T02:00:00Z"), body: material.messages[0]?.body }]);
    expect(await loadCustomerAcceptanceMaterial(pool, orgId, contactId,
      [outboundId, outboundId], criteria)).toEqual(material);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([orgId, contactId, [outboundId], 21]);
    expect(sql).toContain("m.organization_id=$1");
    expect(sql).toContain("organization_id=$1 and id=any($3::uuid[])");
    expect(sql).toContain("o.conversation_id=m.conversation_id");
    expect(sql).toContain("o.channel_session_id=m.channel_session_id");
    expect(sql).toContain("m.direction='inbound' and m.type='text'");
    expect(sql).toContain("m.external_id is not null");
    expect(sql).toContain("m.sent_at>o.first_sent_at");
  });

  it("does not read customer content without a verified outbound message", async () => {
    const { pool, query } = fakePool([]);
    expect(await loadCustomerAcceptanceMaterial(pool, orgId, contactId, [], criteria))
      .toEqual({ criteria, messages: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed instead of judging truncated context", async () => {
    const tooLong = fakePool([{ id: inboundId,
      sent_at: new Date("2026-09-30T02:00:00Z"), body: "x".repeat(2001) }]);
    await expect(loadCustomerAcceptanceMaterial(tooLong.pool, orgId, contactId,
      [outboundId], criteria)).rejects.toThrow("customer_acceptance_material_incomplete");
    const overflow = fakePool(Array.from({ length: 21 }, (_, index) => ({
      id: `${index}`, sent_at: new Date("2026-09-30T02:00:00Z"), body: "同意",
    })));
    await expect(loadCustomerAcceptanceMaterial(overflow.pool, orgId, contactId,
      [outboundId], criteria)).rejects.toThrow("customer_acceptance_material_incomplete");
  });

  it("rejects invented citations, unsupported success, and missing terms", () => {
    const valid = { verdict: "supported" as const, rationale: "两个条款均有明确答复",
      evidence: [{ messageId: inboundId, quote: "接受 1200 元报价，周五交付",
        stance: "accepts" as const }], missingTerms: [] };
    expect(validateCustomerAcceptanceAssessment(material, valid)).toEqual(valid);
    expect(() => validateCustomerAcceptanceAssessment(material, {
      ...valid, evidence: [{ ...valid.evidence[0]!, messageId: outboundId }],
    })).toThrow("customer_acceptance_citation_invalid");
    expect(() => validateCustomerAcceptanceAssessment(material, {
      ...valid, evidence: [{ ...valid.evidence[0]!, quote: "接受 1200 元和折扣" }],
    })).toThrow("customer_acceptance_citation_invalid");
    expect(() => validateCustomerAcceptanceAssessment(material, {
      ...valid, missingTerms: ["交期"],
    })).toThrow("customer_acceptance_support_invalid");
    expect(() => validateCustomerAcceptanceAssessment(material, {
      ...valid, evidence: [],
    })).toThrow("customer_acceptance_support_invalid");
    expect(() => validateCustomerAcceptanceAssessment(material, {
      ...valid, verdict: "contradicted", evidence: valid.evidence,
    })).toThrow("customer_acceptance_contradiction_invalid");
  });
});
