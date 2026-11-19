import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), support: vi.fn(), read: vi.fn(), decrypt: vi.fn(), request: vi.fn(), audit: vi.fn(), encrypt: vi.fn(), from: vi.fn(), inserts: [] as Array<{ table: string; row: Record<string, unknown> }>, filters: [] as unknown[][], credential: null as unknown, configWriteLost: false }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: m.auth }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: m.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: m.from }) }));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("@/lib/crypto/aes_gcm", () => ({ encryptKey: m.encrypt, bufToBytea: (v: Buffer) => "\\x" + v.toString("hex") }));
vi.mock("@/lib/ai/embeddings/configuration", () => ({ readEmbeddingConfiguration: m.read, credentialForEmbedding: m.decrypt }));
vi.mock("@/lib/agent-engine/edge/llm/embedding-provider", () => ({ requestEmbedding: m.request }));
import { GET, PUT } from "./route";
import { POST } from "./validate/route";
import { embeddingProfile, EmbeddingConfigurationError } from "@/lib/ai/embeddings/profile";
const org = "00000000-0000-4000-8000-000000000001";
const credential = "00000000-0000-4000-8000-000000000002";
const version = "00000000-0000-4000-8000-000000000003";
const input = { provider: "siliconflow" as const, base_url: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", dimensions: 1024 as const, model_revision: "1", enabled: false };
const profile = embeddingProfile(input);
const row = { ...input, organization_id: org, fingerprint: profile.fingerprint, credential_id: credential, version };
function request(body: unknown) { return new Request("http://localhost/api/v1/ai/knowledge/embedding", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
beforeEach(() => {
  vi.clearAllMocks(); m.inserts = []; m.filters = []; m.configWriteLost = false;
  m.auth.mockResolvedValue({ ok: true, org: { orgId: org, role: "admin" }, user: { id: org, idioma: "zh-CN" } });
  m.support.mockResolvedValue(null); m.read.mockResolvedValue(row);
  m.credential = { id: credential, provider: "siliconflow", is_active: true, validated_at: null, label: "Embedding" };
  m.encrypt.mockReturnValue({ ciphertext: Buffer.from("cipher"), iv: Buffer.from("iv"), tag: Buffer.from("tag"), last4: "test" });
  m.decrypt.mockResolvedValue({ apiKey: "synthetic-private-credential", profile });
  m.request.mockResolvedValue({ embedding: Array(1024).fill(0.1), promptTokens: 5 });
  m.from.mockImplementation((table: string) => {
    const builder = { select: () => builder, insert: (value: Record<string, unknown>) => { m.inserts.push({ table, row: value }); return builder; },
      update: () => builder, eq: (k: string, v: unknown) => { m.filters.push([table, k, v]); return builder; },
      maybeSingle: async () => ({ data: table === "ai_embedding_configurations" && m.configWriteLost ? null : m.credential, error: null }), single: async () => ({ data: { version }, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve) };
    return builder;
  });
});
describe("embedding configuration API is tenant/admin guarded and explicit about cost", () => {
  it("GET returns metadata without decrypting or calling providers", async () => {
    const response = await GET(); const text = await response.text();
    expect(response.status).toBe(200); expect(text).not.toContain("synthetic-private-credential");
    expect(m.decrypt).not.toHaveBeenCalled(); expect(m.request).not.toHaveBeenCalled();
    expect(m.filters).toContainEqual(["ai_provider_credentials_safe", "organization_id", org]);
  });
  it("permission failure stops before writes or validation", async () => {
    m.auth.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await PUT(request(input))).status).toBe(403);
    expect((await POST(request({ confirm_cost: true }))).status).toBe(403);
    expect(m.inserts).toEqual([]); expect(m.request).not.toHaveBeenCalled();
  });
  it("read-only support sessions cannot save credentials", async () => {
    m.support.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await PUT(request(input))).status).toBe(403); expect(m.auth).not.toHaveBeenCalled();
  });
  it("saving a new key encrypts it, stages disabled and does not spend tokens", async () => {
    m.read.mockResolvedValue(null);
    const response = await PUT(request({ ...input, enabled: true, api_key: "synthetic-new-credential" }));
    expect(response.status).toBe(200); const text = await response.text();
    expect(text).not.toContain("synthetic-new-credential"); expect(m.request).not.toHaveBeenCalled();
    const saved = m.inserts.find((x) => x.table === "ai_provider_credentials")!.row;
    expect(saved.api_key_encrypted).toBe("\\x636970686572"); expect(saved.validated_at).toBeNull();
    expect(JSON.stringify(saved)).not.toContain("synthetic-new-credential");
    expect(m.inserts.find((x) => x.table === "ai_embedding_configurations")?.row.enabled).toBe(false);
  });
  it("rejects stale configuration before encryption", async () => {
    expect((await PUT(request(input))).status).toBe(409); expect(m.encrypt).not.toHaveBeenCalled();
  });
  it("reports a concurrent compare-and-swap loss as 409 without overwriting or calling providers", async () => {
    m.configWriteLost = true;
    const response = await PUT(request({ ...input, credential_id: credential, expected_version: version }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("embedding_configuration_changed");
    expect(m.request).not.toHaveBeenCalled(); expect(m.audit).not.toHaveBeenCalled();
  });
  it("rejects foreign/missing credentials before using a provider", async () => {
    m.credential = null;
    expect((await PUT(request({ ...input, credential_id: credential, expected_version: version }))).status).toBe(422);
    expect(m.request).not.toHaveBeenCalled();
  });
  it("rejects SSRF and cross-organization fields", async () => {
    expect((await PUT(request({ ...input, base_url: "http://127.0.0.1/v1" }))).status).toBe(422);
    expect((await PUT(request({ ...input, organization_id: "foreign" }))).status).toBe(422);
    expect(m.request).not.toHaveBeenCalled();
  });
  it("validation requires explicit billable confirmation", async () => {
    expect((await POST(request({}))).status).toBe(400); expect(m.decrypt).not.toHaveBeenCalled();
  });
  it("validation is one explicit request and never enables indexing", async () => {
    const response = await POST(request({ confirm_cost: true }));
    expect(response.status).toBe(200); expect(m.request).toHaveBeenCalledTimes(1);
    expect(m.decrypt).toHaveBeenCalledWith(org, row, true);
    expect(await response.json()).toMatchObject({ data: { validated: true, dimensions: 1024, prompt_tokens: 5 } });
    expect(m.inserts).toEqual([]);
  });
  it("enabled configurations cannot be accidentally validated with a paid side effect", async () => {
    m.read.mockResolvedValue({ ...row, enabled: true });
    expect((await POST(request({ confirm_cost: true }))).status).toBe(409); expect(m.request).not.toHaveBeenCalled();
  });
  it("upstream error response contains only a fixed category and safe HTTP status", async () => {
    m.request.mockRejectedValue(new EmbeddingConfigurationError("embedding_upstream_rejected", 401));
    const response = await POST(request({ confirm_cost: true }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "embedding_validation_failed", details: { reason: "embedding_upstream_rejected", http_status: 401 } } });
  });
});
