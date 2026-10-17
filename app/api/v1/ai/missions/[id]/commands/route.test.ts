import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";
const KEY = "44444444-4444-4444-8444-444444444444";

function request(command = "pause_customer_send", reason = "先核对最新报价") {
  return new NextRequest(`http://localhost/api/v1/ai/missions/${MISSION}/commands`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, reason, requestKey: KEY }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: ACTOR },
    org: { orgId: ORG, role: "manager" } } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
});

describe("Mission customer-send commands", () => {
  it("passes the exact manager command to one atomic DB function", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ result: {
      result: "changed", paused: true, revision: 1, commandId: 8,
    } }] });
    vi.mocked(getRequestPool).mockReturnValue({ query } as never);
    const { POST } = await import("./route");
    const response = await POST(request(), { params: Promise.resolve({ id: MISSION }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      missionId: MISSION, customerSendPaused: true, policyRevision: 1, changed: true,
    });
    expect(query).toHaveBeenCalledWith(
      "select public.fn_set_ai_mission_send_policy($1,$2,$3,$4,$5,$6) as result",
      [ORG, MISSION, ACTOR, KEY, "pause_customer_send", "先核对最新报价"],
    );
  });

  it("rejects invalid or unauthorized commands before the DB call", async () => {
    const query = vi.fn();
    vi.mocked(getRequestPool).mockReturnValue({ query } as never);
    const { POST } = await import("./route");
    expect((await POST(request("send_now"), { params: Promise.resolve({ id: MISSION }) })).status)
      .toBe(422);
    vi.mocked(requireRole).mockResolvedValueOnce({ ok: false,
      response: new Response(null, { status: 403 }) } as never);
    expect((await POST(request(), { params: Promise.resolve({ id: MISSION }) })).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("reports idempotency-key conflicts rather than mutating policy", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ result: { result: "source_conflict" } }] });
    vi.mocked(getRequestPool).mockReturnValue({ query } as never);
    const { POST } = await import("./route");
    const response = await POST(request(), { params: Promise.resolve({ id: MISSION }) });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("idempotency_conflict");
  });

  it("lists only the current organization's Mission commands", async () => {
    const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    vi.mocked(createAdminClient).mockReturnValue({ from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      reads.push({ table, filters });
      const builder = {
        select: () => builder,
        eq: (field: string, value: unknown) => { filters.push([field, value]); return builder; },
        gt: (field: string, value: unknown) => { filters.push([`>${field}`, value]); return builder; },
        order: () => builder,
        limit: async () => ({ data: [{ id: 8, kind: "pause_customer_send" }], error: null }),
        maybeSingle: async () => ({ data: { id: MISSION }, error: null }),
      };
      return builder;
    } } as never);
    const { GET } = await import("./route");
    const response = await GET(new NextRequest(`http://localhost/api/v1/ai/missions/${MISSION}/commands?after=7`),
      { params: Promise.resolve({ id: MISSION }) });
    expect(response.status).toBe(200);
    expect(reads.map((read) => read.table)).toEqual(["ai_missions", "ai_mission_commands"]);
    for (const read of reads) {
      expect(read.filters).toContainEqual(["organization_id", ORG]);
      expect(read.filters).toContainEqual([read.table === "ai_missions" ? "id" : "mission_id", MISSION]);
    }
    expect(reads[1]?.filters).toContainEqual([">id", 7]);
  });
});
