import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ from: vi.fn(), decrypt: vi.fn(), config: null as unknown, credential: null as unknown, error: null as unknown, filters: [] as unknown[][] }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mock.from }) }));
vi.mock("@/lib/crypto/aes_gcm", () => ({ byteaToBuffer: (v: unknown) => v, decryptKey: mock.decrypt }));
vi.mock("@/lib/env", () => ({ env: { OPENAI_API_KEY: "synthetic-platform-fallback-must-not-be-used" } }));
import { credentialForEmbedding, readEmbeddingConfiguration, type EmbeddingConfigurationRow } from "./configuration";
import { resolverChaveDeEmbedding, temChaveDeEmbedding } from "./chave";
import { embeddingProfile } from "./profile";
const profile = embeddingProfile({ provider: "siliconflow", base_url: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", dimensions: 1024, model_revision: "1", enabled: true });
function row(): EmbeddingConfigurationRow {
  return { organization_id: "org-a", provider: profile.provider, base_url: profile.baseUrl, model: profile.model,
    dimensions: profile.dimensions, model_revision: profile.revision, fingerprint: profile.fingerprint,
    enabled: true, credential_id: "credential-a", version: "config-version" };
}
beforeEach(() => {
  vi.clearAllMocks(); mock.filters = []; mock.error = null; mock.config = row();
  mock.credential = { provider: "siliconflow", is_active: true, validated_at: "2026-11-18", label: "test", api_key_encrypted: "cipher", api_key_iv: "iv", api_key_tag: "tag" };
  mock.decrypt.mockReturnValue("synthetic-test-credential");
  mock.from.mockImplementation((table: string) => {
    const builder = { select: () => builder, eq: (k: string, v: unknown) => { mock.filters.push([table, k, v]); return builder; },
      maybeSingle: async () => ({ data: table === "ai_embedding_configurations" ? mock.config : mock.credential, error: mock.error }) };
    return builder;
  });
});
describe("tenant-scoped independent embedding credentials", () => {
  it("selects only the matching tenant/provider key, using encrypted storage just in time", async () => {
    const key = await resolverChaveDeEmbedding("org-a", "embedding_indexar");
    expect(key?.profile?.fingerprint).toBe(profile.fingerprint);
    expect(mock.filters).toContainEqual(["ai_provider_credentials", "organization_id", "org-a"]);
    expect(mock.filters).toContainEqual(["ai_provider_credentials", "id", "credential-a"]);
    expect(mock.decrypt).toHaveBeenCalledTimes(1);
    expect(mock.from).not.toHaveBeenCalledWith("ai_purpose_bindings");
  });
  it("uses the same profile for indexing and querying", async () => {
    const a = await resolverChaveDeEmbedding("org-a", "embedding_indexar");
    const b = await resolverChaveDeEmbedding("org-a", "embedding_consultar");
    expect(a?.profile).toEqual(b?.profile);
  });
  it.each(["inactive", "unverified", "missing", "wrong-provider", "decrypt-failed"])("rejects %s without platform fallback", async (kind) => {
    if (kind === "inactive") Object.assign(mock.credential as object, { is_active: false });
    if (kind === "unverified") Object.assign(mock.credential as object, { validated_at: null });
    if (kind === "missing") mock.credential = null;
    if (kind === "wrong-provider") Object.assign(mock.credential as object, { provider: "openai" });
    if (kind === "decrypt-failed") mock.decrypt.mockImplementation(() => { throw new Error("synthetic-secret"); });
    await expect(resolverChaveDeEmbedding("org-a")).rejects.toThrow();
    expect(mock.from).not.toHaveBeenCalledWith("ai_purpose_bindings");
  });
  it("never decrypts a foreign tenant configuration", async () => {
    await expect(credentialForEmbedding("org-b", row())).rejects.toThrow("embedding_tenant_mismatch");
    expect(mock.decrypt).not.toHaveBeenCalled();
  });
  it("disabled explicit configuration blocks rather than falling back to OpenAI", async () => {
    mock.config = { ...row(), enabled: false };
    await expect(resolverChaveDeEmbedding("org-a")).rejects.toThrow("embedding_disabled");
    expect(mock.decrypt).not.toHaveBeenCalled();
  });
  it("only an explicit validation caller can load an unverified staged credential", async () => {
    Object.assign(mock.credential as object, { validated_at: null });
    await expect(credentialForEmbedding("org-a", { ...row(), enabled: false }, true)).resolves.toMatchObject({ profile });
  });
  it("allows uploads to wait for disabled or unverified credentials without fallback", async () => {
    mock.config = { ...row(), enabled: false };
    await expect(temChaveDeEmbedding("org-a")).resolves.toBe(false);
    mock.config = row();
    Object.assign(mock.credential as object, { validated_at: null });
    await expect(temChaveDeEmbedding("org-a")).resolves.toBe(false);
    expect(mock.decrypt).not.toHaveBeenCalled();
    expect(mock.from).not.toHaveBeenCalledWith("ai_purpose_bindings");
  });
  it("does not disguise a database outage as missing credentials", async () => {
    mock.error = { code: "42501" };
    await expect(temChaveDeEmbedding("org-a")).rejects.toThrow("embedding_configuration_unavailable");
  });
  it("only missing additive schema preserves the legacy mode", async () => {
    mock.config = null; mock.error = { code: "PGRST205" };
    await expect(readEmbeddingConfiguration("org-a")).resolves.toBeNull();
    mock.error = { code: "42501", message: "synthetic-secret" };
    await expect(readEmbeddingConfiguration("org-a")).rejects.toThrow("embedding_configuration_unavailable");
  });
});
