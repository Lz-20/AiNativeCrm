import { describe, it, expect, vi } from "vitest";
import { resolveEffectiveAgentModelBinding } from "./model-binding";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { selectLlmCredential } from "@/lib/agent-engine/edge/llm/credential-selection";

const draft = { provider: "deepseek", model: "deepseek-flash", credentialId: "deepseek-id" };
const candidate = {
  id: "deepseek-id",
  provider: "deepseek",
  is_active: true,
  validated_at: "2026-11-01T00:00:00Z",
  created_at: "2026-11-01T00:00:00Z",
};
function db(rows: unknown[]) {
  return { query: vi.fn(async () => ({ rows })) } as never;
}

describe("effective model binding", () => {
  it.each(["anthropic", "deepseek"])(
    "organization_default uses %s and never the draft credential",
    (provider) => {
      expect(
        resolveEffectiveAgentModelBinding({
          ...draft,
          mode: "organization_default",
          organizationLlm: { provider, default_model: "org-model" },
        }),
      ).toMatchObject({
        provider,
        model: "org-model",
        credentialId: null,
        source: "organization_default",
      });
    },
  );
  it("pinned retains the explicit tuple", () => {
    expect(resolveEffectiveAgentModelBinding({ ...draft, mode: "pinned" })).toMatchObject(draft);
  });
  it("missing organization defaults cannot fall back to stale draft fields", () => {
    expect(() =>
      resolveEffectiveAgentModelBinding({ ...draft, mode: "organization_default" }),
    ).toThrow("model_binding_unavailable");
  });
  it("the shared version loader uses the same resolver for preview and Workbench", async () => {
    const pool = db([
      {
        ...draft,
        credential_id: "deepseek-id",
        model_binding_mode: "organization_default",
        organization_llm: { provider: "anthropic", default_model: "org-anthropic" },
        config: {},
      },
    ]);
    const result = await loadAgentVersionConfig(pool, "org", "agent", "version");
    expect(result).toMatchObject({
      provider: "anthropic",
      model: "org-anthropic",
      credentialId: null,
    });
  });
});

describe("credential selection before any decryption or model request", () => {
  it("accepts a matching pinned DeepSeek credential", async () => {
    expect(
      await selectLlmCredential(db([candidate]), "org", "deepseek", candidate.id),
    ).toMatchObject(candidate);
  });
  it("rejects pinned DeepSeek with an Anthropic credential", async () => {
    await expect(
      selectLlmCredential(
        db([{ ...candidate, provider: "anthropic" }]),
        "org",
        "deepseek",
        candidate.id,
      ),
    ).rejects.toMatchObject({ code: "credential_provider_mismatch" });
  });
  it.each([[[]], [[{ ...candidate, is_active: false }]], [[{ ...candidate, validated_at: null }]]])(
    "rejects nonexistent, disabled or unverified explicit credentials",
    async (rows) => {
      await expect(
        selectLlmCredential(db(rows), "org", "deepseek", candidate.id),
      ).rejects.toMatchObject({ code: "credential_unavailable" });
    },
  );
  it("selects the newest valid same-provider credential under the existing rule", async () => {
    expect(
      await selectLlmCredential(
        db([candidate, { ...candidate, id: "older", created_at: "2026-10-01" }]),
        "org",
        "deepseek",
      ),
    ).toMatchObject({ id: candidate.id });
  });
  it("rejects ambiguous newest timestamps rather than picking arbitrarily", async () => {
    await expect(
      selectLlmCredential(db([candidate, { ...candidate, id: "tie" }]), "org", "deepseek"),
    ).rejects.toMatchObject({ code: "credential_ambiguous" });
  });
  it("metadata inspection excludes encrypted columns and filters the organization", async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [candidate] }));
    await selectLlmCredential({ query } as never, "org", "deepseek", candidate.id, false);
    expect(query.mock.calls[0]?.[0]).not.toMatch(/encrypted|api_key_iv|api_key_tag/);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("organization_id=$1"), [
      "org",
      candidate.id,
    ]);
  });
});
