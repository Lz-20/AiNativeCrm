import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));

import { GET } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const MISSION = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRequestPool).mockReturnValue({
    query: vi.fn().mockResolvedValue({ rows: [{ mission_id: MISSION, status: "sent" }] }),
  } as never);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true, user: { id: "manager-a" }, org: { orgId: ORG, role: "manager" },
  } as never);
});

describe("GET CRM lead missions", () => {
  it("returns the latest persisted root Run for replay", async () => {
    const missionBuilder = {
      select: () => missionBuilder,
      eq: () => missionBuilder,
      order: () => missionBuilder,
      limit: async () => ({ data: [{ id: MISSION, status: "waiting_internal" }], error: null }),
    };
    const runEq = vi.fn();
    const runBuilder = {
      select: () => runBuilder,
      eq: runEq,
      in: () => runBuilder,
      order: () => runBuilder,
      limit: async () => ({
        data: [{ id: "run-new", mission_id: MISSION }, { id: "run-old", mission_id: MISSION }],
        error: null, count: 2,
      }),
    };
    runEq.mockReturnValue(runBuilder);
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => table === "ai_missions" ? missionBuilder : runBuilder,
    } as never);

    const response = await GET(new NextRequest(`http://localhost/api/v1/ai/missions?leadId=${LEAD}`));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject([{
      id: MISSION, status: "waiting_internal", latest_run_id: "run-new",
      latest_question_status: "sent",
    }]);
    expect(runEq).toHaveBeenCalledWith("organization_id", ORG);
  });

  it("refuses to guess a latest run when the result was truncated", async () => {
    const missionBuilder = {
      select: () => missionBuilder,
      eq: () => missionBuilder,
      order: () => missionBuilder,
      limit: async () => ({ data: [{ id: MISSION }], error: null }),
    };
    const runBuilder = {
      select: () => runBuilder,
      eq: () => runBuilder,
      in: () => runBuilder,
      order: () => runBuilder,
      limit: async () => ({ data: [{ id: "run-old", mission_id: MISSION }], error: null, count: 2 }),
    };
    vi.mocked(createAdminClient).mockReturnValue({
      from: (table: string) => table === "ai_missions" ? missionBuilder : runBuilder,
    } as never);
    const response = await GET(new NextRequest(`http://localhost/api/v1/ai/missions?leadId=${LEAD}`));
    expect(response.status).toBe(409);
  });
});
