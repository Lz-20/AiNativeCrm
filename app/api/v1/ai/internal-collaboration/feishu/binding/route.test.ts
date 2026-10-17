import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  getFeishuBindingStatus, issueFeishuBinding,
} from "@/lib/ai/internal-collaboration/feishu-binding";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/ai/internal-collaboration/feishu-binding", () => ({
  FeishuBindingError: class FeishuBindingError extends Error {},
  getFeishuBindingStatus: vi.fn(), issueFeishuBinding: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { GET, POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const URL = "http://localhost/api/v1/ai/internal-collaboration/feishu/binding";

function post(kind: string) {
  return new NextRequest(URL, { method: "POST", headers: {
    "content-type": "application/json",
  }, body: JSON.stringify({ kind }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FEISHU_APP_ID", "app");
  vi.stubEnv("FEISHU_APP_SECRET", "secret");
  vi.stubEnv("FEISHU_TENANT_KEY", "tenant");
  vi.stubEnv("FEISHU_TENANT_ORGANIZATION_ID", ORG);
  vi.stubEnv("FEISHU_EVENT_ENCRYPT_KEY", "encrypt");
  vi.stubEnv("FEISHU_EVENT_VERIFICATION_TOKEN", "verify");
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: USER },
    org: { orgId: ORG, role: "manager" } } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(getFeishuBindingStatus).mockResolvedValue({ tenantBound: true, userBound: false });
  vi.mocked(issueFeishuBinding).mockResolvedValue({ token: "test-token",
    expiresAt: "2026-09-30T10:10:00Z" });
});
afterEach(() => vi.unstubAllEnvs());

describe("Feishu binding route", () => {
  it("uses authenticated org and member identity, not request-provided IDs", async () => {
    const response = await POST(post("member"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).data.message).toBe("CRM-BIND test-token");
    expect(issueFeishuBinding).toHaveBeenCalledWith({}, {
      organizationId: ORG, userId: USER, kind: "member", tenantKey: "tenant",
      ownerOrganizationId: ORG,
    });
    expect(requireRole).toHaveBeenCalledWith("agent", expect.anything());
  });

  it("requires manager for tenant claim and rejects invalid or write-denied requests", async () => {
    expect((await POST(post("unknown"))).status).toBe(400);
    expect((await POST(post("tenant_owner"))).status).toBe(200);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(new Response(null,
      { status: 403 }) as never);
    expect((await POST(post("member"))).status).toBe(403);
    expect(issueFeishuBinding).toHaveBeenCalledTimes(1);
  });

  it("does not issue a token without installed application configuration", async () => {
    vi.stubEnv("FEISHU_APP_SECRET", "");
    expect((await POST(post("member"))).status).toBe(503);
    expect(issueFeishuBinding).not.toHaveBeenCalled();
    const response = await GET(new NextRequest(URL));
    expect((await response.json()).data.available).toBe(false);
  });
});
