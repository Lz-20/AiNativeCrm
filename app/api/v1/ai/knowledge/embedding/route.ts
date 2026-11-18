import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptKey, bufToBytea } from "@/lib/crypto/aes_gcm";
import { audit } from "@/lib/audit";
import { readEmbeddingConfiguration } from "@/lib/ai/embeddings/configuration";
import { embeddingConfigurationSchema, embeddingProfile } from "@/lib/ai/embeddings/profile";

export const dynamic = "force-dynamic";
const schema = embeddingConfigurationSchema.extend({
  credential_id: z.string().uuid().nullable().optional(),
  api_key: z.string().min(8).max(2048).refine((s) => [...s].every((c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127)).optional(),
  expected_version: z.string().uuid().nullable().optional(),
}).strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!auth.ok) return auth.response;
  try {
    const configuration = await readEmbeddingConfiguration(auth.org.orgId);
    if (!configuration) return ok({ configuration: null, credential: null }, { requestId });
    const { data, error } = await createAdminClient().from("ai_provider_credentials_safe")
      .select("id, provider, label, is_active, validated_at")
      .eq("organization_id", auth.org.orgId).eq("id", configuration.credential_id ?? "00000000-0000-0000-0000-000000000000").maybeSingle();
    if (error) throw new Error();
    return ok({ configuration, credential: data }, { requestId });
  } catch { return fail("embedding_configuration_unavailable", "无法读取Embedding配置。", 503, { requestId }); }
}

/** Saving credentials does not validate, enqueue or call any provider. */
export async function PUT(req: Request): Promise<Response> {
  const support = await requireSupportWrite(); if (support) return support;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "ai_knowledge" });
  if (!auth.ok) return auth.response;
  const credentialAuth = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!credentialAuth.ok) return credentialAuth.response;
  if (credentialAuth.org.orgId !== auth.org.orgId) return fail("forbidden", "组织权限不一致。", 403, { requestId });
  let parsed;
  try { parsed = schema.safeParse(await req.json()); } catch { return fail("invalid_request", "无效配置。", 400, { requestId }); }
  if (!parsed.success) return fail("invalid_request", "请检查Embedding配置字段。", 422, { requestId });
  let profile;
  try { profile = embeddingProfile(parsed.data); }
  catch { return fail("embedding_profile_invalid", "供应商、地址、模型或维度不受支持。", 422, { requestId }); }
  const input = parsed.data; const org = auth.org.orgId; const admin = createAdminClient();
  let createdId: string | undefined;
  try {
    const current = await readEmbeddingConfiguration(org);
    if ((current?.version ?? null) !== (input.expected_version ?? null))
      return fail("embedding_configuration_changed", "配置已更改，请刷新后重试。", 409, { requestId });
    let credentialId = input.credential_id ?? null;
    if (input.api_key) {
      const encrypted = encryptKey(input.api_key); createdId = randomUUID(); credentialId = createdId;
      const { error } = await admin.from("ai_provider_credentials").insert({ id: createdId, organization_id: org,
        provider: input.provider, label: `Embedding ${input.provider} ${createdId.slice(0, 8)}`,
        api_key_encrypted: bufToBytea(encrypted.ciphertext), api_key_iv: bufToBytea(encrypted.iv),
        api_key_tag: bufToBytea(encrypted.tag), api_key_last4: encrypted.last4,
        created_by: auth.user.id, is_active: true, validated_at: null });
      if (error) throw new Error();
    }
    const { data: credential, error: credentialError } = credentialId ? await admin.from("ai_provider_credentials")
      .select("id, provider, is_active, validated_at").eq("id", credentialId).eq("organization_id", org).maybeSingle()
      : { data: null, error: null };
    if (credentialError || (credentialId && (!credential || credential.provider !== input.provider || !credential.is_active)))
      throw new Error("credential_provider_mismatch");
    // Rotation is staged disabled. Validation is explicit and may be billable.
    const enabled = createdId ? false : input.enabled;
    if (enabled && !credential?.validated_at)
      return fail("embedding_credential_unavailable", "请先验证凭据，再启用Embedding。", 409, { requestId });
    const row = { organization_id: org, provider: profile.provider, base_url: profile.baseUrl, model: profile.model,
      dimensions: profile.dimensions, model_revision: profile.revision, fingerprint: profile.fingerprint,
      credential_id: credentialId, enabled, version: randomUUID(), updated_at: new Date().toISOString() };
    const result = current ? await admin.from("ai_embedding_configurations").update(row)
      .eq("organization_id", org).eq("version", current.version).select("version").maybeSingle()
      : await admin.from("ai_embedding_configurations").insert(row).select("version").single();
    if (result.error || !result.data) throw new Error();
    await audit({ organizationId: org, actorUserId: auth.user.id, action: "ai.embedding_configured", resourceType: "ai_embedding_configurations",
      resourceId: org, requestId, metadata: { provider: profile.provider, model: profile.model, dimensions: profile.dimensions,
        fingerprint: profile.fingerprint, enabled, request_id: requestId } });
    return ok({ version: row.version, fingerprint: row.fingerprint, enabled }, { requestId });
  } catch {
    if (createdId) await admin.from("ai_provider_credentials").update({ is_active: false }).eq("id", createdId).eq("organization_id", org);
    return fail("embedding_configuration_rejected", "无法保存Embedding配置，请检查供应商与本组织凭据。", 422, { requestId });
  }
}
