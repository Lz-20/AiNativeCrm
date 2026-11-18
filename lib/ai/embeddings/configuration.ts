import { createAdminClient } from "@/lib/supabase/admin";
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { embeddingConfigurationSchema, embeddingProfile, EmbeddingConfigurationError, type EmbeddingProfile } from "./profile";

export interface EmbeddingConfigurationRow {
  organization_id: string; provider: string; base_url: string; model: string; dimensions: number;
  model_revision: string; enabled: boolean; fingerprint: string; credential_id: string | null; version: string;
}
/** Missing additive schema preserves legacy mode; every other DB failure closes. */
export async function readEmbeddingConfiguration(org: string): Promise<EmbeddingConfigurationRow | null> {
  const { data, error } = await createAdminClient().from("ai_embedding_configurations")
    .select("organization_id, provider, base_url, model, dimensions, model_revision, enabled, fingerprint, credential_id, version")
    .eq("organization_id", org).maybeSingle();
  if (error && !["42P01", "PGRST205"].includes(error.code))
    throw new EmbeddingConfigurationError("embedding_configuration_unavailable");
  return data as EmbeddingConfigurationRow | null;
}
export function profileFromRow(row: EmbeddingConfigurationRow): EmbeddingProfile {
  const parsed = embeddingConfigurationSchema.safeParse({ provider: row.provider, base_url: row.base_url,
    model: row.model, dimensions: row.dimensions, model_revision: row.model_revision, enabled: row.enabled });
  if (!parsed.success) throw new EmbeddingConfigurationError("embedding_configuration_invalid");
  const profile = embeddingProfile(parsed.data);
  if (profile.fingerprint !== row.fingerprint) throw new EmbeddingConfigurationError("embedding_profile_invalid");
  return profile;
}
export async function credentialForEmbedding(org: string, row: EmbeddingConfigurationRow,
  validating = false): Promise<{ apiKey: string; label: string; profile: EmbeddingProfile }> {
  if (row.organization_id !== org) throw new EmbeddingConfigurationError("embedding_tenant_mismatch");
  const profile = profileFromRow(row);
  if (!validating && !row.enabled) throw new EmbeddingConfigurationError("embedding_disabled");
  if (!row.credential_id) throw new EmbeddingConfigurationError("embedding_credential_unavailable");
  const { data, error } = await createAdminClient().from("ai_provider_credentials")
    .select("provider, label, is_active, validated_at, api_key_encrypted, api_key_iv, api_key_tag")
    .eq("id", row.credential_id).eq("organization_id", org).maybeSingle();
  if (error || !data || !data.is_active || (!validating && !data.validated_at))
    throw new EmbeddingConfigurationError("embedding_credential_unavailable");
  if (data.provider !== row.provider) throw new EmbeddingConfigurationError("credential_provider_mismatch");
  try {
    return { profile, label: data.label, apiKey: decryptKey({ ciphertext: byteaToBuffer(data.api_key_encrypted),
      iv: byteaToBuffer(data.api_key_iv), tag: byteaToBuffer(data.api_key_tag) }) };
  } catch { throw new EmbeddingConfigurationError("embedding_credential_unavailable"); }
}
