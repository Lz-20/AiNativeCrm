import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { submitMissionManagerDirection } from "@/lib/ai/agents/mission-internal-response";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/ai/agents/mission-internal-response", async (importOriginal) => {
  const original = await importOriginal();
  return { ...(original as object), submitMissionManagerDirection: vi.fn() };
});
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";
const ctx = { params: Promise.resolve({ id: MISSION }) };

function request(key?: string, direction = "改用新的报价依据") {
  return new NextRequest(`http://localhost/api/v1/ai/missions/${MISSION}/follow-up`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify({ direction }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true, user: { id: "manager-a" }, org: { orgId: ORG, role: "manager" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
  vi.mocked(getRequestPool).mockReturnValue({} as never);
  vi.mocked(submitMissionManagerDirection).mockResolvedValue({
    missionId: MISSION, runId: "run-a", runStatus: "queued", missionStatus: "queued",
    customerSendPaused: true, replayed: false,
  });
});

describe("POST Mission manager follow-up", () => {
  it("requires a manager, an idempotency key and a bounded direction", async () => {
    expect((await POST(request(), ctx)).status).toBe(400);
    expect((await POST(request(KEY, "x"), ctx)).status).toBe(422);
    expect(submitMissionManagerDirection).not.toHaveBeenCalled();
    vi.mocked(requireRole).mockResolvedValueOnce({ ok: false,
      response: new Response(null, { status: 403 }) } as never);
    expect((await POST(request(KEY), ctx)).status).toBe(403);
    expect(submitMissionManagerDirection).not.toHaveBeenCalled();
  });

  it("passes only a manager direction to the Mission continuation service", async () => {
    const response = await POST(request(KEY), ctx);
    expect(response.status).toBe(201);
    expect(submitMissionManagerDirection).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG, missionId: MISSION, actorUserId: "manager-a",
      requestKey: KEY, content: "改用新的报价依据",
    });
    expect((await response.json()).data.customerSendPaused).toBe(true);
  });

  it("reports the current send policy on an idempotent replay", async () => {
    vi.mocked(submitMissionManagerDirection).mockResolvedValueOnce({
      missionId: MISSION, runId: "run-a", runStatus: "completed", missionStatus: "needs_review",
      customerSendPaused: false, replayed: true,
    });
    const response = await POST(request(KEY), ctx);
    expect(response.status).toBe(200);
    expect((await response.json()).data.customerSendPaused).toBe(false);
  });
});
