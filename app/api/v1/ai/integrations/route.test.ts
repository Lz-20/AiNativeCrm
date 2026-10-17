import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mock = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  query: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mock.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mock.support }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: mock.query }),
}));
vi.mock("@/lib/audit", () => ({ audit: mock.audit }));
import { GET, PATCH } from "./route";
import { POST as connectWiki } from "./wiki/sources/route";
import { POST as saveMemory, DELETE as deleteMemory } from "../customer-memory/route";
const org = "a0000000-0000-4000-8000-000000000001";
const id = "a0000000-0000-4000-8000-000000000002";
const req = (body: unknown, method = "PATCH") =>
  new NextRequest("http://localhost/api/v1/ai/integrations", {
    method,
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(
    "AI_INTEGRATION_BINDINGS",
    JSON.stringify([
      {
        organization_id: org,
        provider: "weknora",
        base_url: "https://wiki.test",
        api_key: "SECRET_CANARY",
        knowledge_base_ids: ["kb-a"],
        visibility: "organization",
      },
    ]),
  );
  mock.role.mockResolvedValue({ ok: true, org: { orgId: org }, user: { id } });
  mock.support.mockResolvedValue(null);
  mock.query.mockResolvedValue({ rows: [] });
});
describe("provider configuration API boundaries", () => {
  it("shows configuration readiness without leaking credentials or promising connectivity", async () => {
    const result = await GET();
    const body = await result.json();
    expect(
      body.data.providers.find((p: { provider: string }) => p.provider === "weknora"),
    ).toMatchObject({ configured: true, enabled: false, connectivity_verified: false });
    expect(JSON.stringify(body)).not.toContain("SECRET_CANARY");
    expect(mock.role).toHaveBeenCalledWith("manager", expect.anything());
    expect(mock.query.mock.calls.every(([, values]) => values[0] === org)).toBe(true);
  });
  it("requires admin + support-write permission and never accepts org from the caller", async () => {
    mock.role.mockResolvedValueOnce({
      ok: false,
      response: new Response("denied", { status: 403 }),
    });
    expect((await PATCH(req({ provider: "weknora", enabled: true, revision: 0 }))).status).toBe(
      403,
    );
    expect(mock.role).toHaveBeenCalledWith("admin", expect.anything());
    expect(mock.query).not.toHaveBeenCalled();
    expect(
      (
        await PATCH(
          req({ provider: "weknora", enabled: true, revision: 0, organization_id: "other" }),
        )
      ).status,
    ).toBe(400);
    mock.support.mockResolvedValueOnce(new Response("support denied", { status: 403 }));
    expect((await PATCH(req({ provider: "weknora", enabled: true, revision: 0 }))).status).toBe(
      403,
    );
  });
  it("fails closed on missing service binding and optimistic revision conflict", async () => {
    expect((await PATCH(req({ provider: "mem0", enabled: true, revision: 0 }))).status).toBe(409);
    expect(mock.query).not.toHaveBeenCalled();
    expect((await PATCH(req({ provider: "weknora", enabled: true, revision: 7 }))).status).toBe(
      409,
    );
  });
  it("accepts reordered PostgreSQL jsonb metadata on idempotent Wiki registration", async () => {
    mock.query.mockImplementation(async (sql: string) => ({
      rows: sql.startsWith("select")
        ? [
            {
              id,
              name: "Products",
              source_metadata: {
                provider: "weknora",
                visibility: "organization",
                knowledge_base_id: "kb-a",
              },
            },
          ]
        : [],
    }));
    expect(
      (
        await connectWiki(
          req(
            {
              id,
              name: "Products",
              knowledge_base_id: "kb-a",
              whole_organization_visibility_confirmed: true,
            },
            "POST",
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await connectWiki(
          req(
            {
              id,
              name: "Products",
              knowledge_base_id: "foreign",
              whole_organization_visibility_confirmed: true,
            },
            "POST",
          ),
        )
      ).status,
    ).toBe(403);
  });
  it("customer-memory mutations require manager and explicit fact confirmation", async () => {
    expect(
      (
        await saveMemory(
          req({ contact_id: id, request_key: id, category: "preference", body: "Email" }, "POST"),
        )
      ).status,
    ).toBe(400);
    mock.role.mockResolvedValueOnce({
      ok: false,
      response: new Response("denied", { status: 403 }),
    });
    expect(
      (
        await saveMemory(
          req(
            {
              contact_id: id,
              request_key: id,
              category: "preference",
              body: "Email",
              confirmed: true,
            },
            "POST",
          ),
        )
      ).status,
    ).toBe(403);
    expect(mock.role).toHaveBeenCalledWith("manager", expect.anything());
    mock.role.mockResolvedValueOnce({
      ok: false,
      response: new Response("denied", { status: 403 }),
    });
    expect((await deleteMemory(req({ id }, "DELETE"))).status).toBe(403);
    expect(mock.query).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.unstubAllEnvs());
