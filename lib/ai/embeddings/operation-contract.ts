import { createHash } from "node:crypto";
import { z } from "zod";
import { EmbeddingConfigurationError } from "./profile";

export const hashText = (text: string) => createHash("sha256").update(text).digest("hex");
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const fingerprintSchema = z.string().regex(/^embedding:v1:[a-f0-9]{64}$/);
const integerAmount = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
export const manifestEntrySchema = z
  .object({
    position: z.number().int().min(0),
    hash: sha256Schema,
    bytes: z.number().int().positive().max(32000),
  })
  .strict();
export type InputManifest = z.infer<typeof manifestEntrySchema>[];
/** Versioned, ordered manifest. The existing chunk algorithm is unchanged. */
export function inputManifest(inputs: string[]): { manifest: InputManifest; manifestHash: string } {
  const manifest = inputs.map((input, position) => ({
    position,
    hash: hashText(input),
    bytes: Buffer.byteLength(input),
  }));
  z.array(manifestEntrySchema).min(1).max(10000).parse(manifest);
  return { manifest, manifestHash: hashText(JSON.stringify([1, manifest])) };
}
export const priceReviewSchema = z
  .object({
    fingerprint: fingerprintSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    price_per_million_microcents: integerAmount,
    input_token_ceiling: z.number().int().min(1).max(32768),
    input_byte_ceiling: z.number().int().min(1).max(32000),
    evidence_url: z.url().refine((v) => {
      const u = new URL(v);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.port &&
        !u.search &&
        !u.hash &&
        [
          "api-docs.siliconflow.cn",
          "siliconflow.cn",
          "www.siliconflow.cn",
          "help.aliyun.com",
          "platform.openai.com",
        ].includes(u.hostname)
      );
    }),
    evidence_sha256: sha256Schema,
    token_bound_evidence_sha256: sha256Schema,
    expires_at: z.iso.datetime({ offset: true }),
    confirm_price_ceiling: z.literal(true),
    confirm_provider_rejects_over_token_limit: z.literal(true),
  })
  .strict();
export const authorizeOperationSchema = z
  .object({
    knowledge_source_id: z.uuid(),
    kind: z.enum(["index", "query", "validation"]),
    content_hash: sha256Schema,
    source_revision_hash: sha256Schema,
    manifest_hash: sha256Schema,
    manifest: z.array(manifestEntrySchema).min(1).max(10000),
    fingerprint: fingerprintSchema,
    configuration_version: z.uuid(),
    price_review_id: z.uuid(),
    knowledge_version_id: z.uuid().nullable().default(null),
    not_before: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
    max_requests: z.number().int().min(1).max(10000),
    max_request_tokens: z.number().int().positive().max(32768),
    max_total_tokens: integerAmount,
    max_cost_microcents: integerAmount,
    currency: z.string().regex(/^[A-Z]{3}$/),
    confirm_cost: z.literal(true),
  })
  .strict();
export type AuthorizeOperation = z.infer<typeof authorizeOperationSchema>;
export class EmbeddingWaitingError extends EmbeddingConfigurationError {}
const WAITING = new Set([
  "embedding_disabled",
  "embedding_credential_unavailable",
  "embedding_authorization_required",
  "embedding_lease_busy",
  "embedding_budget_exhausted",
  "embedding_operation_blocked",
  "embedding_operation_expired",
  "embedding_configuration_changed",
  "embedding_schema_required",
  "embedding_price_review_required",
]);
export function isEmbeddingWaiting(error: unknown): error is EmbeddingConfigurationError {
  return error instanceof EmbeddingConfigurationError && WAITING.has(error.code);
}
/** Integer microcents only. No float prices, no chars/4 token estimate. */
export function upperCost(tokens: number, pricePerMillion: string): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw new EmbeddingConfigurationError("embedding_token_bound_invalid");
  return (BigInt(tokens) * BigInt(pricePerMillion) + 999999n) / 1000000n;
}
