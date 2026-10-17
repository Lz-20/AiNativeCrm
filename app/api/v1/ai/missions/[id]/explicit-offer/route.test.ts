import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { evaluateExplicitOffer } from "@/lib/ai/evals/mission-explicit-offer-evidence";
import { issueMissionExplicitOffer } from "@/lib/ai/evals/mission-explicit-offer-service";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/ai/evals/mission-explicit-offer-evidence", () => ({
  evaluateExplicitOffer: vi.fn(),
}));
vi.mock("@/lib/ai/evals/mission-explicit-offer-service", () => ({
  ExplicitOfferError: class ExplicitOfferError extends Error {},
  issueMissionExplicitOffer: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { GET, POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const MISSION = "33333333-3333-4333-8333-333333333333";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const KEY = "55555555-5555-4555-8555-555555555555";
const URL = `http://localhost/api/v1/ai/missions/${MISSION}/explicit-offer`;
const ctx = { params: Promise.resolve({ id: MISSION }) };
const terms = { description: "500 件设备", amountMinor: 123450, currency: "CNY",
  deliveryDate: "2026-10-15" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: USER },
    org: { orgId: ORG, role: "manager" } } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(getRequestPool).mockReturnValue({ query: vi.fn()
    .mockResolvedValueOnce({ rows: [{ id: MISSION, contact_id: USER }] })
    .mockResolvedValueOnce({ rows: [{ id: CONVERSATION,
      last_message_preview: "最后一条客户消息" }] }) } as never);
  vi.mocked(evaluateExplicitOffer).mockResolvedValue({ offerId: null,
    verdict: "not_issued", reason: "explicit_offer_missing",
    terms: null, offerText: null, acceptanceText: null,
    outboundMessageId: null, inboundMessageId: null,
    structuredTermsAccepted: false, legalIdentityVerified: false,
    businessOutcomeVerified: false });
  vi.mocked(issueMissionExplicitOffer).mockResolvedValue({ id: KEY,
    missionId: MISSION, conversationId: CONVERSATION,
    offerText: "Offer", acceptanceText: "Accept", expiresAt: "2026-10-07T00:00:00Z",
    superseded: false, replayed: false });
});

describe("Mission explicit offer route", () => {
  it("exposes only the authenticated org's eligible conversations and evidence", async () => {
    const response = await GET(new NextRequest(URL), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).data.eligibleConversations).toEqual([{
      id: CONVERSATION, label: "最后一条客户消息",
    }]);
    expect(evaluateExplicitOffer).toHaveBeenCalledWith(expect.anything(), ORG, MISSION);
  });

  it("rejects missing idempotency key and scopes issue to the manager", async () => {
    const body = JSON.stringify({ conversationId: CONVERSATION, terms });
    expect((await POST(new NextRequest(URL, { method: "POST", body }), ctx)).status).toBe(400);
    expect(issueMissionExplicitOffer).not.toHaveBeenCalled();
    const response = await POST(new NextRequest(URL, { method: "POST", body,
      headers: { "Content-Type": "application/json", "Idempotency-Key": KEY } }), ctx);
    expect(response.status).toBe(201);
    expect(issueMissionExplicitOffer).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG, missionId: MISSION, actorUserId: USER,
      conversationId: CONVERSATION, requestKey: KEY, terms,
    });
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
  });

  it("does not create an offer when support write is denied", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(new Response(null,
      { status: 403 }) as never);
    const response = await POST(new NextRequest(URL, { method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": KEY },
      body: JSON.stringify({ conversationId: CONVERSATION, terms }) }), ctx);
    expect(response.status).toBe(403);
    expect(issueMissionExplicitOffer).not.toHaveBeenCalled();
  });
});
