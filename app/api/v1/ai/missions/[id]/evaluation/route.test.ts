import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadMissionBudgetUsage } from "@/lib/ai/agents/mission-budget";
import { loadMissionDeliveryEvidence } from "@/lib/ai/evals/mission-delivery-evidence";
import { loadMissionCustomerResponses } from "@/lib/ai/evals/mission-customer-response";
import { evaluateExplicitOffer } from "@/lib/ai/evals/mission-explicit-offer-evidence";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/ai/agents/mission-budget", () => ({ loadMissionBudgetUsage: vi.fn() }));
vi.mock("@/lib/ai/evals/mission-delivery-evidence", () => ({ loadMissionDeliveryEvidence: vi.fn() }));
vi.mock("@/lib/ai/evals/mission-customer-response", () => ({ loadMissionCustomerResponses: vi.fn() }));
vi.mock("@/lib/ai/evals/mission-explicit-offer-evidence", () => ({ evaluateExplicitOffer: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const PROPOSAL = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, unknown>;
type Result = { data: Row[] | Row | null; error: null; count?: number };

function stubAdmin(options: {
  missingMission?: boolean;
  truncateEvents?: boolean;
  invalidContract?: boolean;
  validContract?: boolean;
} = {}) {
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const from = vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    reads.push({ table, filters });
    const rowSet = (): Result => {
      const kind = filters.find(([column]) => column === "run_kind")?.[1];
      if (table === "ai_missions") return {
        data: options.missingMission ? null : {
          id: MISSION, lead_id: LEAD, status: "needs_review",
          acceptance_criteria: "客户确认报价", resolution_reason: null,
          acceptance_contract: options.invalidContract ? { revision: 2, checks: [] }
            : options.validContract ? { revision: 1, checks: [
              { kind: "lead_status", equals: "open" },
              { kind: "customer_inbound_after_verified_send" },
            ] } : null,
          resolved_by_user_id: null, max_runs: 4, deadline_at: null,
        }, error: null,
      };
      if (table === "crm_leads") return {
        data: { id: LEAD, status: "open", stage_id: "stage-1", contact_id: "contact-1" }, error: null,
      };
      if (table === "ai_workbench_runs" && kind === "root") return {
        data: [{ id: RUN, status: "completed", error_code: null }], error: null,
        count: 1,
      };
      if (table === "ai_workbench_runs" && kind === "specialist") return {
        data: [{ id: "child-1", parent_run_id: RUN, status: "partial" }], error: null,
        count: 1,
      };
      if (table === "ai_agent_action_proposals") return {
        data: [{ id: PROPOSAL, run_id: RUN, tool_name: "send_message", status: "executed" }],
        error: null, count: 1,
      };
      if (table === "ai_agent_run_events") return {
        data: [
          { run_id: RUN, sequence: 1, event_type: "human_confirmation_received", payload: { proposalId: PROPOSAL, decision: "approve" } },
          { run_id: RUN, sequence: 2, event_type: "tool_started", payload: { proposalId: PROPOSAL } },
        ], error: null, count: options.truncateEvents ? 3 : 2,
      };
      throw new Error(`Unexpected table: ${table}`);
    };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
      in: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
      order: () => builder,
      maybeSingle: async () => rowSet(),
      then: (resolve: (value: Result) => unknown) => Promise.resolve(rowSet()).then(resolve),
    };
    return builder;
  });
  vi.mocked(createAdminClient).mockReturnValue({ from } as never);
  return reads;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true, user: { id: "user-1" }, org: { orgId: ORG, role: "manager" },
  } as never);
  vi.mocked(loadMissionBudgetUsage).mockResolvedValue({
    missionId: MISSION, maxTotalTokens: 72_000, maxTotalCostCents: 200,
    usedTokens: 1_000, usedCostCents: 1, unknownCostCalls: 0,
  });
  vi.mocked(loadMissionDeliveryEvidence).mockResolvedValue([{
    proposalId: PROPOSAL, status: "sent", messageId: "message-1",
    contactId: "contact-1", conversationId: "conversation-1", sendJobId: "job-1",
    approvedAt: "2026-09-30T00:00:00.000Z", approvedBodyMatchesLedger: true,
    ledger: {
      idempotencyKey: "receipt-key-1", jobId: "job-1", status: "accepted",
      messageId: "message-1", contactId: "contact-1",
    },
    message: {
      id: "message-1", idempotencyKey: "receipt-key-1", contactId: "contact-1",
      conversationId: "conversation-1", direction: "outbound", status: "sent", sentVia: "ai",
      sentAt: "2026-09-30T00:01:00.000Z", bodyMatchesLedger: true,
    },
  }]);
  vi.mocked(loadMissionCustomerResponses).mockResolvedValue([{
    outboundMessageId: "message-1",
    reply: { id: "inbound-1", contactId: "contact-1", conversationId: "conversation-1",
      sentAt: "2026-09-30T00:02:00.000Z" },
  }]);
  vi.mocked(evaluateExplicitOffer).mockResolvedValue({
    offerId: null, verdict: "not_issued", reason: "explicit_offer_missing", terms: null,
    offerText: null, acceptanceText: null, outboundMessageId: null, inboundMessageId: null,
    structuredTermsAccepted: false, legalIdentityVerified: false, businessOutcomeVerified: false,
  });
});

async function requestEvaluation() {
  const { GET } = await import("./route");
  return GET(
    new NextRequest(`http://localhost/api/v1/ai/missions/${MISSION}/evaluation`),
    { params: Promise.resolve({ id: MISSION }) },
  );
}

describe("GET /api/v1/ai/missions/:id/evaluation", () => {
  it("uses tenant-scoped root, specialist, event and delivery evidence", async () => {
    const reads = stubAdmin();
    const response = await requestEvaluation();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.summary).toMatchObject({
      specialistRuns: 1, failedOrPartialSpecialists: 1,
      externalProposalsApproved: 1, customerMessagesSent: 1, customerMessagesNotSent: 0,
      customerRepliesObserved: 1,
    });
    expect(body.data.verdict).toBe("needs_review");
    expect(body.data.businessOutcomeVerified).toBe(false);
    expect(reads.map((read) => read.table)).not.toContain("ai_reply_drafts");
    for (const read of reads) expect(read.filters).toContainEqual(["organization_id", ORG]);
    expect(loadMissionBudgetUsage).toHaveBeenCalledWith({}, ORG, MISSION);
    expect(loadMissionDeliveryEvidence).toHaveBeenCalledWith({}, ORG, [PROPOSAL]);
    expect(loadMissionCustomerResponses).toHaveBeenCalledWith({}, ORG, ["message-1"]);
    expect(evaluateExplicitOffer).toHaveBeenCalledWith({}, ORG, MISSION);
  });

  it("reports channel-confirmed terms without exposing quote text or claiming full outcome", async () => {
    stubAdmin();
    vi.mocked(evaluateExplicitOffer).mockResolvedValueOnce({
      offerId: "offer-1", verdict: "verified", reason: "exact_customer_channel_confirmation",
      terms: { description: "设备", amountMinor: 123450, currency: "CNY", deliveryDate: "2026-10-15" },
      offerText: "private quote text", acceptanceText: "private acceptance text",
      outboundMessageId: "message-1", inboundMessageId: "inbound-1",
      structuredTermsAccepted: true, legalIdentityVerified: false, businessOutcomeVerified: false,
    });
    const response = await requestEvaluation();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.structuredOffer).toMatchObject({
      verdict: "verified", structuredTermsAccepted: true, offerId: "offer-1",
    });
    expect(payload.data.businessOutcomeVerified).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("private quote text");
    expect(JSON.stringify(payload)).not.toContain("private acceptance text");
  });

  it("fails closed when structured-offer evidence cannot be read", async () => {
    stubAdmin();
    vi.mocked(evaluateExplicitOffer).mockRejectedValueOnce(new Error("database_unavailable"));
    const response = await requestEvaluation();
    expect(response.status).toBe(503);
  });

  it("does not read cross-tenant evidence when the Mission is not visible", async () => {
    const reads = stubAdmin({ missingMission: true });
    const response = await requestEvaluation();
    expect(response.status).toBe(404);
    expect(reads.map((read) => read.table)).toEqual(["ai_missions"]);
  });

  it("refuses an invalid persisted acceptance contract before reading other evidence", async () => {
    const reads = stubAdmin({ invalidContract: true });
    const response = await requestEvaluation();
    expect(response.status).toBe(409);
    expect(reads.map((read) => read.table)).toEqual(["ai_missions"]);
  });

  it("checks a valid persisted contract against CRM state and customer-message metadata", async () => {
    stubAdmin({ validContract: true });
    const response = await requestEvaluation();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.observableConditionsMet).toBe(true);
    expect(body.data.observableChecks).toMatchObject([
      { kind: "lead_status", verdict: "met" },
      { kind: "customer_inbound_after_verified_send", verdict: "met" },
    ]);
    expect(body.data.businessOutcomeVerified).toBe(false);
  });

  it("refuses a report when PostgREST truncates ordered evidence", async () => {
    stubAdmin({ truncateEvents: true });
    const response = await requestEvaluation();
    expect(response.status).toBe(409);
    expect(loadMissionBudgetUsage).not.toHaveBeenCalled();
    expect(loadMissionDeliveryEvidence).not.toHaveBeenCalled();
  });

  it("refuses to report verified customer delivery when the receipt query fails", async () => {
    stubAdmin();
    vi.mocked(loadMissionDeliveryEvidence).mockRejectedValueOnce(new Error("database_unavailable"));
    const response = await requestEvaluation();
    expect(response.status).toBe(503);
    expect(loadMissionDeliveryEvidence).toHaveBeenCalledWith({}, ORG, [PROPOSAL]);
  });

  it("refuses a report when the customer response evidence query fails", async () => {
    stubAdmin();
    vi.mocked(loadMissionCustomerResponses).mockRejectedValueOnce(new Error("database_unavailable"));
    const response = await requestEvaluation();
    expect(response.status).toBe(503);
    expect(loadMissionBudgetUsage).not.toHaveBeenCalled();
  });
});
