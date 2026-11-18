import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { credentialForEmbedding, readEmbeddingConfiguration } from "@/lib/ai/embeddings/configuration";
import { EmbeddingConfigurationError } from "@/lib/ai/embeddings/profile";
import { requestEmbedding } from "@/lib/agent-engine/edge/llm/embedding-provider";

export const dynamic = "force-dynamic";
const validationSchema = z.object({ confirm_cost: z.literal(true) }).strict();
/** Explicit small embedding call. No GET validation and no automatic indexing. */
export async function POST(req: Request): Promise<Response> {
  const support = await requireSupportWrite(); if (support) return support;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "ai_knowledge" });
  if (!auth.ok) return auth.response;
  const credentialAuth = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!credentialAuth.ok) return credentialAuth.response;
  if (credentialAuth.org.orgId !== auth.org.orgId) return fail("forbidden", "组织权限不一致。", 403, { requestId });
  try { if (!validationSchema.safeParse(await req.json()).success) throw new Error(); }
  catch { return fail("invalid_request", "请明确确认本次Embedding验证可能计费。", 400, { requestId }); }
  const org = auth.org.orgId;
  try {
    const row = await readEmbeddingConfiguration(org);
    if (!row || row.enabled) return fail("embedding_validation_requires_disabled_config", "请先禁用Embedding并保存配置，再验证。", 409, { requestId });
    const resolved = await credentialForEmbedding(org, row, true);
    const result = await requestEmbedding(resolved.profile, resolved.apiKey, "Embedding configuration validation");
    const current = await readEmbeddingConfiguration(org);
    if (current?.version !== row.version) throw new EmbeddingConfigurationError("embedding_configuration_changed");
    const { data, error } = await createAdminClient().from("ai_provider_credentials")
      .update({ validated_at: new Date().toISOString(), validation_error: null })
      .eq("id", row.credential_id!).eq("organization_id", org).eq("provider", row.provider).eq("is_active", true)
      .select("id").maybeSingle();
    if (error || !data) throw new EmbeddingConfigurationError("embedding_credential_unavailable");
    await audit({ organizationId: org, actorUserId: auth.user.id, action: "ai.embedding_validated", resourceType: "ai_provider_credentials", resourceId: row.credential_id!, requestId,
      metadata: { purpose: "embedding_validation", provider: row.provider, model: row.model,
        dimensions: row.dimensions, request_id: requestId } });
    return ok({ validated: true, dimensions: result.embedding.length, prompt_tokens: result.promptTokens }, { requestId });
  } catch (error) {
    return fail("embedding_validation_failed",
      "Embedding验证失败，请检查供应商、模型、维度与凭据。", 422, { requestId,
        details: { reason: error instanceof EmbeddingConfigurationError ? error.code : "embedding_validation_failed",
          ...(error instanceof EmbeddingConfigurationError && error.httpStatus ? { http_status: error.httpStatus } : {}) } });
  }
}
