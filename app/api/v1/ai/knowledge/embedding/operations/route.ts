import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { readEmbeddingConfiguration, profileFromRow } from "@/lib/ai/embeddings/configuration";
import {
  authorizeOperationSchema,
  priceReviewSchema,
  inputManifest,
} from "@/lib/ai/embeddings/operation-contract";
import { authorizeOperation } from "@/lib/ai/embeddings/operation-store";
import { EmbeddingConfigurationError } from "@/lib/ai/embeddings/profile";
import { prepareIndexMaterial, type FonteRow } from "@/workers/rag-indexer";

export const dynamic = "force-dynamic";
const requestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("prepare"),
      knowledge_source_id: z.uuid(),
      kind: z.enum(["index", "validation", "query"]),
      inputs: z.array(z.string().min(1).max(32000)).min(1).max(10).optional(),
    })
    .strict(),
  z.object({ action: z.literal("review_price"), review: priceReviewSchema }).strict(),
  z.object({ action: z.literal("authorize"), operation: authorizeOperationSchema }).strict(),
  z.object({ action: z.literal("revoke"), operation_id: z.uuid() }).strict(),
]);
/** Safe status projection: no source text, vectors, credentials or SQL errors. */
export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!auth.ok) return auth.response;
  try {
    const db = getRequestPool(),
      org = auth.org.orgId;
    const operations = await db.query(
      `select id,knowledge_source_id,kind,content_hash,source_revision_hash,manifest_hash,fingerprint,configuration_version,knowledge_version_id,status,not_before,expires_at,max_requests,max_request_tokens,max_total_tokens,max_cost_microcents,currency,reserved_requests,reserved_tokens,reserved_cost_microcents,last_error,completed_at
      from public.ai_embedding_operations where organization_id=$1 order by approved_at desc limit 100`,
      [org],
    );
    const reviews = await db.query(
      "select id,fingerprint,currency,price_per_million_microcents,input_token_ceiling,input_byte_ceiling,evidence_url,evidence_sha256,token_bound_evidence_sha256,reviewed_at,expires_at from public.ai_embedding_price_reviews where organization_id=$1 order by reviewed_at desc limit 100",
      [org],
    );
    const requests = await db.query(
      "select id,operation_id,input_position,input_hash,status,reserved_tokens,reserved_cost_microcents,actual_tokens,actual_cost_microcents,reused_from_request_id,latency_ms,upstream_request_id,error_code,created_at,finished_at from public.ai_embedding_requests where organization_id=$1 order by created_at desc limit 200",
      [org],
    );
    return ok(
      { operations: operations.rows, price_reviews: reviews.rows, requests: requests.rows },
      { requestId },
    );
  } catch {
    return fail("embedding_configuration_unavailable", "无法读取Embedding操作授权。", 503, {
      requestId,
    });
  }
}
export async function POST(req: Request) {
  const support = await requireSupportWrite();
  if (support) return support;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "ai_knowledge" });
  if (!auth.ok) return auth.response;
  const credentialAuth = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!credentialAuth.ok) return credentialAuth.response;
  if (credentialAuth.org.orgId !== auth.org.orgId)
    return fail("forbidden", "组织权限不一致。", 403, { requestId });
  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await req.json());
  } catch {
    return fail("invalid_request", "请检查操作授权、额度和价格证明。", 400, { requestId });
  }
  const org = auth.org.orgId,
    user = auth.user.id;
  try {
    const db = getRequestPool();
    if (input.action === "prepare") {
      const source = await db.query<FonteRow>(
        "select id,organization_id,agent_id,source_type,name,status,is_active,source_metadata,active_kb_version_id from public.ai_knowledge_sources where organization_id=$1 and id=$2",
        [org, input.knowledge_source_id],
      );
      if (!source.rows[0]) return fail("not_found", "Material não encontrado.", 404, { requestId });
      const material = await prepareIndexMaterial(source.rows[0]);
      const config = await readEmbeddingConfiguration(org);
      if (!config) throw new EmbeddingConfigurationError("embedding_authorization_required");
      const profile = profileFromRow(config);
      const manifest =
        input.kind === "index"
          ? material
          : inputManifest(
              input.kind === "validation"
                ? ["Embedding configuration validation"]
                : (input.inputs ?? []),
            );
      return ok(
        {
          knowledge_source_id: input.knowledge_source_id,
          kind: input.kind,
          content_hash: material.contentHash,
          source_revision_hash: material.sourceRevisionHash,
          manifest_hash: manifest.manifestHash,
          manifest: manifest.manifest,
          fingerprint: profile.fingerprint,
          configuration_version: config.version,
          provider: profile.provider,
          model: profile.model,
          dimensions: profile.dimensions,
          knowledge_version_id: source.rows[0].active_kb_version_id ?? null,
          authorization_installed: false,
        },
        { requestId },
      );
    }
    let operationResourceId: string;
    if (input.action === "review_price") {
      const p = input.review;
      if (
        Date.parse(p.expires_at) <= Date.now() ||
        Date.parse(p.expires_at) > Date.now() + 7 * 86400000
      )
        throw new Error("price_expiry");
      const config = await readEmbeddingConfiguration(org);
      if (!config || profileFromRow(config).fingerprint !== p.fingerprint)
        throw new Error("price_profile");
      const host = new URL(p.evidence_url).hostname;
      if (
        config.provider === "siliconflow" &&
        (!["api-docs.siliconflow.cn", "siliconflow.cn", "www.siliconflow.cn"].includes(host) ||
          p.input_token_ceiling !== 8192)
      )
        throw new Error("price_token_bound");
      if (config.provider === "bailian" && host !== "help.aliyun.com")
        throw new Error("price_evidence_provider");
      if (config.provider === "openai" && host !== "platform.openai.com")
        throw new Error("price_evidence_provider");
      // The reviewer explicitly attests the provider's rejecting token ceiling,
      // maximum PRICE (including rounding), currency and immutable evidence.
      // A URL/hash alone never becomes automatic verification. No default price.
      const { rows } = await db.query<{ id: string }>(
        `insert into public.ai_embedding_price_reviews(organization_id,fingerprint,currency,price_per_million_microcents,input_token_ceiling,input_byte_ceiling,evidence_url,evidence_sha256,token_bound_evidence_sha256,reviewed_by,expires_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [
          org,
          p.fingerprint,
          p.currency,
          p.price_per_million_microcents,
          p.input_token_ceiling,
          p.input_byte_ceiling,
          p.evidence_url,
          p.evidence_sha256,
          p.token_bound_evidence_sha256,
          user,
          p.expires_at,
        ],
      );
      operationResourceId = rows[0]!.id;
    } else if (input.action === "authorize") {
      const operation = input.operation;
      {
        const source = await db.query<FonteRow>(
          "select id,organization_id,agent_id,source_type,name,status,is_active,source_metadata,active_kb_version_id from public.ai_knowledge_sources where organization_id=$1 and id=$2",
          [org, operation.knowledge_source_id],
        );
        if (!source.rows[0]) throw new Error("source");
        const material = await prepareIndexMaterial(source.rows[0]);
        if (
          material.contentHash !== operation.content_hash ||
          material.sourceRevisionHash !== operation.source_revision_hash ||
          (operation.kind === "index" && material.manifestHash !== operation.manifest_hash) ||
          (operation.kind === "validation" &&
            inputManifest(["Embedding configuration validation"]).manifestHash !==
              operation.manifest_hash)
        )
          throw new Error("material_changed");
      }
      operationResourceId = await authorizeOperation(org, user, operation);
    } else {
      const { rows } = await db.query<{ id: string }>(
        "update public.ai_embedding_operations set status='revoked',last_error='revoked_by_admin' where organization_id=$1 and id=$2 returning id",
        [org, input.operation_id],
      );
      if (!rows[0]) return fail("not_found", "操作授权不存在。", 404, { requestId });
      operationResourceId = rows[0].id;
    }
    const action =
      input.action === "review_price"
        ? "ai.embedding_operation_review_price"
        : input.action === "authorize"
          ? "ai.embedding_operation_authorize"
          : "ai.embedding_operation_revoke";
    await audit({
      organizationId: org,
      actorUserId: user,
      action,
      resourceType: "ai_embedding_operations",
      resourceId: operationResourceId,
      requestId,
      metadata: { operation_action: input.action, request_id: requestId },
    });
    return ok({ id: operationResourceId, provider_called: false }, { requestId });
  } catch (error) {
    return fail(
      "embedding_configuration_rejected",
      "Embedding操作被拒绝；请重新核对身份、版本、额度及人工价格证明。",
      409,
      {
        requestId,
        details: {
          reason:
            error instanceof EmbeddingConfigurationError
              ? error.code
              : "embedding_operation_rejected",
        },
      },
    );
  }
}
