import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db }));
import { activateVersion } from "./version";
beforeEach(() => { vi.clearAllMocks(); db.rpc.mockResolvedValue({ error: null }); });
describe("profiled index activation delegates the entire pointer swap to the atomic RPC", () => {
  it("supplies tenant/source/version/fingerprint without independent updates", async () => {
    await activateVersion({ organizationId: "org", knowledgeSourceId: "source", versionId: "version", embeddingFingerprint: "fingerprint" });
    expect(db.rpc).toHaveBeenCalledWith("fn_activate_embedding_version", { p_organization_id: "org", p_source_id: "source", p_version_id: "version", p_fingerprint: "fingerprint" });
    expect(db.from).not.toHaveBeenCalled();
  });
  it("propagates activation failure with a safe category and no fallback writes", async () => {
    db.rpc.mockResolvedValue({ error: { message: "synthetic-private-database-error" } });
    await expect(activateVersion({ organizationId: "org", knowledgeSourceId: "source", versionId: "version", embeddingFingerprint: "fingerprint" }))
      .rejects.toThrow(/^embedding_activation_failed$/);
    expect(db.from).not.toHaveBeenCalled();
  });
});
