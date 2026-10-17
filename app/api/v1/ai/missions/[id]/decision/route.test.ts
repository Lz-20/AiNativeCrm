import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

function admin(status: string) {
  const from = vi.fn((table: string) => {
    if (table !== "ai_missions") throw new Error(`unexpected active-run read: ${table}`);
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({
        data: { id: MISSION, lead_id: LEAD, status, deadline_at: null },
        error: null,
      }),
    };
    return builder;
  });
  vi.mocked(createAdminClient).mockReturnValue({ from } as never);
  return from;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true, user: { id: "actor-1" }, org: { orgId: ORG, role: "manager" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
});

async function cancel() {
  const { POST } = await import("./route");
  return POST(new NextRequest(`http://localhost/api/v1/ai/missions/${MISSION}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "cancel", reason: "销售负责人接管" }),
  }), { params: Promise.resolve({ id: MISSION }) });
}

describe("POST /api/v1/ai/missions/:id/decision cancellation", () => {
  it("stops a waiting-approval Mission atomically without refusing its active Run", async () => {
    const from = admin("waiting_approval");
    const query = vi.fn().mockResolvedValue({ rows: [{ result: "cancelled" }] });
    vi.mocked(getRequestPool).mockReturnValue({ query } as never);
    const response = await cancel();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ status: "cancelled" });
    expect(query).toHaveBeenCalledWith(
      "select public.fn_cancel_ai_mission($1,$2,$3,$4) as result",
      [ORG, MISSION, "actor-1", "销售负责人接管"],
    );
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("does not reopen or re-cancel a terminal Mission", async () => {
    admin("cancelled");
    const query = vi.fn();
    vi.mocked(getRequestPool).mockReturnValue({ query } as never);
    expect((await cancel()).status).toBe(409);
    expect(query).not.toHaveBeenCalled();
  });
});
