import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOUNDED_FREE_QUERY_MARKER_HASH,
  boundedFreeQueryManifest,
  isBoundedFreeQueryManifest,
} from "@/lib/ai/embeddings/operation-contract";
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
  it("prepares a bounded_free_text query manifest with a unique nonce per call and zero provider calls", async () => {
    const sourceId = "e4130000-0000-4000-8000-000000000021";
    const versionId = "e4130000-0000-4000-8000-000000000022";
    const configVersion = "e4130000-0000-4000-8000-000000000023";
    m.query.mockResolvedValue({
      rows: [
        {
          id: sourceId,
          organization_id: org,
          agent_id: null,
          source_type: "document",
          name: "SVC-101",
          status: "ready",
          is_active: true,
          source_metadata: {},
          active_kb_version_id: versionId,
        },
      ],
    });
    m.prepare.mockResolvedValue({
      contentHash: "1".repeat(64),
      sourceRevisionHash: "2".repeat(64),
      manifestHash: "3".repeat(64),
      manifest: [{ position: 0, hash: "4".repeat(64), bytes: 10 }],
    });
    m.read.mockResolvedValue({
      version: configVersion,
      fingerprint: "embedding:v1:" + "a".repeat(64),
      provider: "siliconflow",
    });
    const first = await POST(
      request({
        action: "prepare",
        knowledge_source_id: sourceId,
        kind: "query",
        query_mode: "bounded_free_text",
        max_query_bytes: 1500,
      }),
    );
    const second = await POST(
      request({
        action: "prepare",
        knowledge_source_id: sourceId,
        kind: "query",
        query_mode: "bounded_free_text",
        max_query_bytes: 1500,
      }),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const d1 = (await first.json()).data;
    const d2 = (await second.json()).data;
    expect(d1.query_mode).toBe("bounded_free_text");
    expect(d1.max_query_bytes).toBe(1500);
    expect(d1.manifest[0]).toEqual({
      position: 0,
      hash: BOUNDED_FREE_QUERY_MARKER_HASH,
      bytes: 1500,
    });
    expect(isBoundedFreeQueryManifest(d1.manifest, d1.manifest_hash)).toBe(true);
    expect(isBoundedFreeQueryManifest(d2.manifest, d2.manifest_hash)).toBe(true);
    expect(d1.manifest_hash).not.toBe(d2.manifest_hash);
    expect(m.authorize).not.toHaveBeenCalled();
  });
  it("rejects bounded_free_text on non-query kinds, oversized byte ceiling, or expiry > 7 days", async () => {
    const sourceId = "e4130000-0000-4000-8000-000000000021";
    expect(
      (
        await POST(
          request({
            action: "prepare",
            knowledge_source_id: sourceId,
            kind: "index",
            query_mode: "bounded_free_text",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request({
            action: "prepare",
            knowledge_source_id: sourceId,
            kind: "query",
            query_mode: "bounded_free_text",
            max_query_bytes: 2001,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request({
            action: "prepare",
            knowledge_source_id: sourceId,
            kind: "query",
            query_mode: "bounded_free_text",
            inputs: ["not allowed together"],
          }),
        )
      ).status,
    ).toBe(400);
    const bounded = boundedFreeQueryManifest(2000, "e".repeat(64));
    const tooLong = await POST(
      request({
        action: "authorize",
        operation: {
          knowledge_source_id: sourceId,
          kind: "query",
          content_hash: "1".repeat(64),
          source_revision_hash: "2".repeat(64),
          manifest_hash: bounded.manifestHash,
          manifest: bounded.manifest,
          fingerprint: "embedding:v1:" + "a".repeat(64),
          configuration_version: "e4130000-0000-4000-8000-000000000023",
          price_review_id: "e4130000-0000-4000-8000-000000000024",
          knowledge_version_id: "e4130000-0000-4000-8000-000000000025",
          not_before: new Date(Date.now() - 1000).toISOString(),
          expires_at: new Date(Date.now() + 8 * 86400000).toISOString(),
          max_requests: 10,
          max_request_tokens: 8192,
          max_total_tokens: "81920",
          max_cost_microcents: "81920",
          currency: "CNY",
          confirm_cost: true,
        },
      }),
    );
    expect(tooLong.status).toBe(409);
    expect(m.authorize).not.toHaveBeenCalled();
  });
});
