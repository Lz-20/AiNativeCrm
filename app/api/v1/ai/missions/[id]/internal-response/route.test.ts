import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { submitMissionInternalResponse } from "@/lib/ai/agents/mission-internal-response";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/ai/agents/mission-internal-response", async (importOriginal) => {
  const original = await importOriginal();
  return { ...(original as object), submitMissionInternalResponse: vi.fn() };
});
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const MISSION = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";

function request(headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/v1/ai/missions/${MISSION}/internal-response`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ content: "交期已向仓储核对" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true, user: { id: "manager-a" }, org: { orgId: ORG, role: "manager" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
  vi.mocked(getRequestPool).mockReturnValue({} as never);
  vi.mocked(submitMissionInternalResponse).mockResolvedValue({
    missionId: MISSION, runId: "run-a", runStatus: "queued", missionStatus: "queued",
    customerSendPaused: false, replayed: false,
  });
});

describe("POST Mission internal response", () => {
  it("requires a manager and a valid idempotency key", async () => {
    const ctx = { params: Promise.resolve({ id: MISSION }) };
    expect((await POST(request(), ctx)).status).toBe(400);
    expect(submitMissionInternalResponse).not.toHaveBeenCalled();
    expect((await POST(request({ "Idempotency-Key": KEY }), ctx)).status).toBe(201);
    expect(submitMissionInternalResponse).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG, missionId: MISSION, actorUserId: "manager-a",
      requestKey: KEY, content: "交期已向仓储核对",
    });
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
  });

  it("does not call the service for a denied manager", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const response = await POST(request({ "Idempotency-Key": KEY }), { params: Promise.resolve({ id: MISSION }) });
    expect(response.status).toBe(403);
    expect(submitMissionInternalResponse).not.toHaveBeenCalled();
  });

  it("returns an idempotent replay instead of creating another run", async () => {
    vi.mocked(submitMissionInternalResponse).mockResolvedValueOnce({
      missionId: MISSION, runId: "run-a", runStatus: "completed", missionStatus: "needs_review",
      customerSendPaused: false, replayed: true,
    });
    const response = await POST(request({ "Idempotency-Key": KEY }), { params: Promise.resolve({ id: MISSION }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ replayed: true, missionStatus: "needs_review" });
  });
});
