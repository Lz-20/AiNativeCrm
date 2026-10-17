import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadMissionDeliveryEvidence } from "@/lib/ai/evals/mission-delivery-evidence";
import {
  judgeCustomerAcceptance, loadCustomerAcceptanceMaterial,
} from "@/lib/ai/evals/mission-customer-acceptance";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: vi.fn(() => ({
  llmCfg: {}, log: {},
})) }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({ loadAgentVersionConfig: vi.fn() }));
vi.mock("@/lib/ai/evals/mission-delivery-evidence", () => ({ loadMissionDeliveryEvidence: vi.fn() }));
vi.mock("@/lib/ai/evals/mission-customer-acceptance", () => ({
  judgeCustomerAcceptance: vi.fn(), loadCustomerAcceptanceMaterial: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const CONTACT = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const PROPOSAL = "66666666-6666-4666-8666-666666666666";
const MESSAGE = "77777777-7777-4777-8777-777777777777";

function stubAdmin(options: { missionMissing?: boolean; proposalStatus?: string;
  proposalCount?: number } = {}) {
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const from = vi.fn((table: string) => {
    const filters: Array<[string, unknown]> = [];
    reads.push({ table, filters });
    const result = () => {
      if (table === "ai_missions") return { data: options.missionMissing ? null
        : { id: MISSION, lead_id: LEAD, acceptance_criteria: "接受报价与交期" }, error: null };
      if (table === "crm_leads") return { data: { id: LEAD, contact_id: CONTACT }, error: null };
      if (table === "ai_workbench_runs") return { data: [{ id: RUN, agent_id: LEAD,
        runtime_state: { versionId: CONTACT } }], error: null, count: 1 };
      if (table === "ai_agent_action_proposals") return { data: [{ id: PROPOSAL,
        status: options.proposalStatus ?? "executed" }], error: null,
        count: options.proposalCount ?? 1 };
      throw new Error(`Unexpected table: ${table}`);
    };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
      in: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
      order: () => builder,
      maybeSingle: async () => result(),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) =>
        Promise.resolve(result()).then(resolve),
    };
    return builder;
  });
  vi.mocked(createAdminClient).mockReturnValue({ from } as never);
  return reads;
}

async function requestReview() {
  const { POST } = await import("./route");
  return POST(new NextRequest(`http://localhost/api/v1/ai/missions/${MISSION}/customer-acceptance`,
    { method: "POST" }), { params: Promise.resolve({ id: MISSION }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: CONTACT },
    org: { orgId: ORG, role: "manager" } } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(loadMissionDeliveryEvidence).mockResolvedValue([{
    proposalId: PROPOSAL, status: "sent", messageId: MESSAGE,
    contactId: CONTACT, conversationId: LEAD, sendJobId: RUN,
    approvedAt: "2026-09-30T00:00:00Z", approvedBodyMatchesLedger: true,
    ledger: { idempotencyKey: PROPOSAL, jobId: RUN, status: "accepted",
      messageId: MESSAGE, contactId: CONTACT },
    message: { id: MESSAGE, idempotencyKey: PROPOSAL, contactId: CONTACT,
      conversationId: LEAD, direction: "outbound", status: "sent", sentVia: "ai",
      sentAt: "2026-09-30T00:01:00Z", bodyMatchesLedger: true },
  }]);
  vi.mocked(loadCustomerAcceptanceMaterial).mockResolvedValue({
    criteria: "接受报价与交期", messages: [{ id: CONTACT,
      sentAt: "2026-09-30T00:02:00Z", body: "接受报价与交期" }],
  });
  vi.mocked(loadAgentVersionConfig).mockResolvedValue({
    provider: "openai", model: "test-model", credentialId: null,
  } as never);
  vi.mocked(judgeCustomerAcceptance).mockResolvedValue({
    verdict: "supported", rationale: "客户明确表示接受", evidence: [{
      messageId: CONTACT, quote: "接受报价与交期", stance: "accepts",
    }], missingTerms: [], rubricRevision: 1, judgeId: "test", businessOutcomeVerified: false,
  });
});

describe("POST mission customer acceptance review", () => {
  it("does not read or judge an unowned Mission", async () => {
    const reads = stubAdmin({ missionMissing: true });
    expect((await requestReview()).status).toBe(404);
    expect(reads.map((read) => read.table)).toEqual(["ai_missions"]);
    expect(judgeCustomerAcceptance).not.toHaveBeenCalled();
  });

  it("requires tenant-scoped executed proposals and verified delivery before reading customer text", async () => {
    const reads = stubAdmin({ proposalStatus: "rejected" });
    const response = await requestReview();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      verdict: "insufficient", businessOutcomeVerified: false,
    });
    expect(loadMissionDeliveryEvidence).not.toHaveBeenCalled();
    expect(loadCustomerAcceptanceMaterial).not.toHaveBeenCalled();
    expect(judgeCustomerAcceptance).not.toHaveBeenCalled();
    for (const read of reads) expect(read.filters).toContainEqual(["organization_id", ORG]);
  });

  it("separately judges exact CRM source material without declaring business completion", async () => {
    const reads = stubAdmin();
    const response = await requestReview();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      verdict: "supported", businessOutcomeVerified: false,
      evidence: [{ messageId: CONTACT }],
    });
    expect(loadCustomerAcceptanceMaterial).toHaveBeenCalledWith({}, ORG, CONTACT,
      [MESSAGE], "接受报价与交期");
    expect(judgeCustomerAcceptance).toHaveBeenCalledOnce();
    for (const read of reads) expect(read.filters).toContainEqual(["organization_id", ORG]);
  });

  it("rejects truncated proposal evidence without using a model", async () => {
    stubAdmin({ proposalCount: 2 });
    expect((await requestReview()).status).toBe(409);
    expect(judgeCustomerAcceptance).not.toHaveBeenCalled();
  });
});
