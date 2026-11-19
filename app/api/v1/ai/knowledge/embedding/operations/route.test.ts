import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  support: vi.fn(),
  query: vi.fn(),
  audit: vi.fn(),
  authorize: vi.fn(),
  read: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: m.auth }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: m.support }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: m.query }),
}));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("@/lib/ai/embeddings/operation-store", () => ({ authorizeOperation: m.authorize }));
vi.mock("@/lib/ai/embeddings/configuration", () => ({
  readEmbeddingConfiguration: m.read,
  profileFromRow: () => ({ fingerprint: "embedding:v1:" + "a".repeat(64) }),
}));
vi.mock("@/workers/rag-indexer", () => ({ prepareIndexMaterial: m.prepare }));
import { GET, POST } from "./route";
const org = "e4130000-0000-4000-8000-000000000011",
  id = "e4130000-0000-4000-8000-000000000012";
const request = (body: unknown) =>
  new Request("http://localhost/api/v1/ai/knowledge/embedding/operations", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
beforeEach(() => {
  vi.clearAllMocks();
  m.support.mockResolvedValue(null);
  m.auth.mockResolvedValue({ ok: true, org: { orgId: org }, user: { id, idioma: "zh-CN" } });
  m.query.mockResolvedValue({ rows: [] });
  m.audit.mockResolvedValue(undefined);
  m.read.mockResolvedValue({
    fingerprint: "embedding:v1:" + "a".repeat(64),
    provider: "siliconflow",
  });
});
describe("operation approval is an explicit dual-admin action, not a supplier call", () => {
  it("only returns a tenant-scoped SAFE projection of budgets and receipts", async () => {
    expect((await GET()).status).toBe(200);
    expect(m.query).toHaveBeenCalledTimes(3);
    for (const [sql, args] of m.query.mock.calls) {
      expect(args).toEqual([org]);
      expect(sql).not.toContain("response_embedding");
      expect(sql).not.toContain("api_key");
    }
    expect(m.authorize).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
  it("rejects absent authorization or price attestation instead of inventing defaults", async () => {
    expect((await POST(request({ action: "authorize", operation: {} }))).status).toBe(400);
    expect((await POST(request({ action: "review_price", review: {} }))).status).toBe(400);
    expect(m.query).not.toHaveBeenCalled();
    expect(m.authorize).not.toHaveBeenCalled();
  });
  it("rejects foreign organization fields and unknown action types", async () => {
    expect(
      (await POST(request({ action: "revoke", operation_id: id, organization_id: "foreign" })))
        .status,
    ).toBe(400);
    expect((await POST(request({ action: "apply", operation_id: id }))).status).toBe(400);
    expect(m.query).not.toHaveBeenCalled();
  });
  it("requires both knowledge and credential administration; no query occurs on denial", async () => {
    m.auth
      .mockResolvedValueOnce({ ok: true, org: { orgId: org }, user: { id } })
      .mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(request({ action: "revoke", operation_id: id }))).status).toBe(403);
    expect(m.query).not.toHaveBeenCalled();
  });
  it("does not accept a reviewer-invented smaller BGE token ceiling", async () => {
    const review = {
      fingerprint: "embedding:v1:" + "a".repeat(64),
      currency: "CNY",
      price_per_million_microcents: "1000000",
      input_token_ceiling: 1,
      input_byte_ceiling: 32000,
      evidence_url: "https://api-docs.siliconflow.cn/docs/api/embeddings-post",
      evidence_sha256: "a".repeat(64),
      token_bound_evidence_sha256: "b".repeat(64),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      confirm_price_ceiling: true,
      confirm_provider_rejects_over_token_limit: true,
    };
    expect((await POST(request({ action: "review_price", review }))).status).toBe(409);
    expect(m.query).not.toHaveBeenCalled();
  });
  it("revokes future use without resetting requests or event history", async () => {
    m.query.mockResolvedValue({ rows: [{ id }] });
    expect((await POST(request({ action: "revoke", operation_id: id }))).status).toBe(200);
    expect(m.query).toHaveBeenCalledWith(expect.stringContaining("status='revoked'"), [org, id]);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: org,
        actorUserId: id,
        action: "ai.embedding_operation_revoke",
        resourceId: id,
      }),
    );
    expect(m.query.mock.calls[0]![0]).not.toMatch(/event_log|reserved_requests\s*=/);
  });
});
