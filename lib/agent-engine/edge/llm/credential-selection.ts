import type pg from "pg";
import { ModelCallError } from "@/lib/agent-runtime/errors";

interface CredentialCandidate {
  id: string;
  provider: string;
  is_active: boolean;
  validated_at: string | Date | null;
  created_at: string | Date;
  api_key_encrypted?: unknown;
  api_key_iv?: unknown;
  api_key_tag?: unknown;
}

/** Explicit IDs fail closed. Default selection retains newest-valid policy; ties are ambiguous. */
export async function selectLlmCredential(
  db: pg.Pool,
  organizationId: string,
  provider: string,
  credentialId?: string | null,
  includeSecret = true,
): Promise<CredentialCandidate | undefined> {
  const columns =
    "id, provider, is_active, validated_at, created_at" +
    (includeSecret ? ", api_key_encrypted, api_key_iv, api_key_tag" : "");
  const { rows } = credentialId
    ? await db.query<CredentialCandidate>(
        `select ${columns} from ai_provider_credentials where organization_id=$1 and id=$2 limit 1`,
        [organizationId, credentialId],
      )
    : await db.query<CredentialCandidate>(
        `select ${columns} from ai_provider_credentials where organization_id=$1 and provider=$2
         and is_active and validated_at is not null order by created_at desc limit 2`,
        [organizationId, provider],
      );
  const row = rows[0];
  if (!row) {
    if (credentialId) throw new ModelCallError("credential_unavailable", "credential");
    return undefined;
  }
  if (row.provider !== provider)
    throw new ModelCallError("credential_provider_mismatch", "credential");
  if (!row.is_active || !row.validated_at)
    throw new ModelCallError("credential_unavailable", "credential");
  const second = rows[1];
  if (!credentialId && second) {
    const firstTime = new Date(row.created_at).getTime();
    const secondTime = new Date(second.created_at).getTime();
    if (!Number.isFinite(firstTime) || !Number.isFinite(secondTime) || firstTime <= secondTime)
      throw new ModelCallError("credential_ambiguous", "credential");
  }
  return row;
}
