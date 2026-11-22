/** Small RAG ledger on the existing PostgreSQL pool, not a second task queue.
 * Reservations commit BEFORE HTTP. No reservation/unknown result is refunded.
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { assertEmbedding, embeddingProfile, type EmbeddingProfile } from "./profile";
import {
  type AuthorizeOperation,
  type InputManifest,
  BOUNDED_FREE_QUERY_MARKER_HASH,
  EmbeddingWaitingError,
  MAX_BOUNDED_FREE_QUERY_REQUESTS,
  MAX_BOUNDED_FREE_QUERY_WINDOW_MS,
  hashText,
  inputManifest,
  isBoundedFreeQueryManifest,
  upperCost,
} from "./operation-contract";
import { sourceRevision } from "./source-revision";

export interface OperationRow {
  id: string;
  organization_id: string;
  knowledge_source_id: string;
  kind: "index" | "query" | "validation";
  content_hash: string;
  source_revision_hash: string;
  manifest_hash: string;
  manifest: InputManifest;
  fingerprint: string;
  configuration_version: string;
  price_review_id: string;
  approved_by: string;
  status: string;
  expires_at: Date;
  not_before: Date;
  max_requests: number;
  max_request_tokens: number;
  max_total_tokens: string;
  max_cost_microcents: string;
  currency: string;
  reserved_requests: number;
  reserved_tokens: string;
  reserved_cost_microcents: string;
  knowledge_version_id: string | null;
  lease_owner: string | null;
  lease_until: Date | null;
  fence: string;
}
interface PriceRow {
  fingerprint: string;
  currency: string;
  price_per_million_microcents: string;
  input_token_ceiling: number;
  input_byte_ceiling: number;
  reviewed_by: string;
  expires_at: Date;
}
export interface OperationLease {
  operationId: string;
  organizationId: string;
  owner: string;
  fence: string;
}
export interface EmbeddingAccess {
  organizationId: string;
  kind: "index" | "query" | "validation";
  sourceIds: string[];
  operationId?: string;
  lease?: OperationLease;
  position?: number;
}
export interface WireEmbeddingResult {
  embedding: number[];
  promptTokens: number;
  upstreamRequestId?: string;
  latencyMs?: number;
}
const wait = (code: string): never => {
  throw new EmbeddingWaitingError(code);
};
async function transaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local lock_timeout='5s'");
    const result = await fn(c);
    await c.query("commit");
    return result;
  } catch (error) {
    await c.query("rollback");
    if ((error as { code?: string }).code === "42P01") return wait("embedding_schema_required");
    if ((error as { code?: string }).code === "55P03") return wait("embedding_lease_busy");
    throw error;
  } finally {
    c.release();
  }
}
async function currentAdmin(c: PoolClient, org: string, user: string): Promise<void> {
  const { rows } = await c.query(
    "select 1 from public.user_organizations where organization_id=$1 and user_id=$2 and role='admin' and accepted_at is not null",
    [org, user],
  );
  if (!rows.length) wait("embedding_authorization_required");
}
/** Must be called with the operation row locked. Config/source locks remain held
 * throughout the send/finalization transaction; disable waits for an in-flight
 * request, then prevents all following sends. It cannot retract sent bytes.
 */
async function guard(c: PoolClient, op: OperationRow, validation = false): Promise<PriceRow> {
  const now = (await c.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
  if (op.not_before > now || op.expires_at <= now) wait("embedding_operation_expired");
  if (!["approved", "running", "completed"].includes(op.status))
    wait("embedding_operation_blocked");
  await currentAdmin(c, op.organization_id, op.approved_by);
  const { rows: prices } = await c.query<PriceRow>(
    "select * from public.ai_embedding_price_reviews where organization_id=$1 and id=$2 for share",
    [op.organization_id, op.price_review_id],
  );
  const price = prices[0];
  if (
    !price ||
    price.expires_at <= now ||
    price.fingerprint !== op.fingerprint ||
    price.currency !== op.currency
  )
    return wait("embedding_price_review_required");
  await currentAdmin(c, op.organization_id, price.reviewed_by);
  const { rows } = await c.query<{
    version: string;
    enabled: boolean;
    fingerprint: string;
    provider: string;
    credential_id: string | null;
  }>(
    "select version,enabled,fingerprint,provider,credential_id from public.ai_embedding_configurations where organization_id=$1 for share",
    [op.organization_id],
  );
  const config = rows[0];
  if (
    !config ||
    config.version !== op.configuration_version ||
    config.fingerprint !== op.fingerprint
  )
    return wait("embedding_configuration_changed");
  if (validation ? config.enabled : !config.enabled) return wait("embedding_disabled");
  const credential = await c.query(
    "select 1 from public.ai_provider_credentials where organization_id=$1 and id=$2 and provider=$3 and is_active and ($4 or validated_at is not null) for share",
    [op.organization_id, config.credential_id, config.provider, validation],
  );
  if (!credential.rows.length) return wait("embedding_credential_unavailable");
  const source = await c.query<{ active_kb_version_id: string | null }>(
    "select active_kb_version_id from public.ai_knowledge_sources where organization_id=$1 and id=$2 and is_active and status<>'archived' for share",
    [op.organization_id, op.knowledge_source_id],
  );
  if (!source.rows.length) return wait("embedding_authorization_required");
  // Lock the metadata rows as well as the source; uploads/edits cannot race a
  // network send authorized for an older storage version or FAQ revision.
  await c.query(
    "select o.id from storage.objects o join public.ai_knowledge_sources s on o.bucket_id='ai-policy' and o.name=s.source_metadata->>'blob_path' where s.organization_id=$1 and s.id=$2 for share of o",
    [op.organization_id, op.knowledge_source_id],
  );
  await c.query(
    "select id from public.ai_faq_items where organization_id=$1 and knowledge_source_id=$2 for share",
    [op.organization_id, op.knowledge_source_id],
  );
  if (
    (await sourceRevision(c, op.organization_id, op.knowledge_source_id)) !==
    op.source_revision_hash
  )
    return wait("embedding_configuration_changed");
  if (
    op.kind === "query" &&
    (!op.knowledge_version_id || source.rows[0]!.active_kb_version_id !== op.knowledge_version_id)
  )
    return wait("embedding_configuration_changed");
  return price;
}
function checkLease(op: OperationRow, lease?: OperationLease) {
  if (
    !lease ||
    lease.operationId !== op.id ||
    lease.organizationId !== op.organization_id ||
    lease.owner !== op.lease_owner ||
    lease.fence !== op.fence ||
    !op.lease_until ||
    op.lease_until <= new Date()
  )
    wait("embedding_lease_busy");
}
async function lockOperation(c: PoolClient, org: string, id: string): Promise<OperationRow> {
  const { rows } = await c.query<OperationRow>(
    "select * from public.ai_embedding_operations where organization_id=$1 and id=$2 for update",
    [org, id],
  );
  return rows[0] ?? wait("embedding_authorization_required");
}
export async function authorizeOperation(
  org: string,
  user: string,
  input: AuthorizeOperation,
  pool = getRequestPool(),
): Promise<string> {
  if (input.kind === "query" ? !input.knowledge_version_id : input.knowledge_version_id !== null)
    return wait("embedding_authorization_required");
  const isBoundedFree = isBoundedFreeQueryManifest(input.manifest, input.manifest_hash);
  if (isBoundedFree) {
    if (
      input.kind !== "query" ||
      input.max_requests < 1 ||
      input.max_requests > MAX_BOUNDED_FREE_QUERY_REQUESTS
    )
      return wait("embedding_authorization_required");
    const expiresMs = Date.parse(input.expires_at);
    const notBeforeMs = Date.parse(input.not_before);
    if (
      !Number.isFinite(expiresMs) ||
      !Number.isFinite(notBeforeMs) ||
      expiresMs <= notBeforeMs ||
      expiresMs > Date.now() + MAX_BOUNDED_FREE_QUERY_WINDOW_MS
    )
      return wait("embedding_authorization_required");
  } else if (
    input.manifest.some((m, i) => m.position !== i) ||
    hashText(JSON.stringify([1, input.manifest])) !== input.manifest_hash ||
    input.max_requests < input.manifest.length
  )
    wait("embedding_authorization_required");
  return transaction(pool, async (c) => {
    await currentAdmin(c, org, user);
    const id = randomUUID();
    const { rows } = await c.query<OperationRow>(
      `insert into public.ai_embedding_operations
      (id,organization_id,knowledge_source_id,kind,content_hash,manifest_hash,manifest,fingerprint,configuration_version,price_review_id,approved_by,not_before,expires_at,max_requests,max_request_tokens,max_total_tokens,max_cost_microcents,currency,knowledge_version_id,source_revision_hash)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning *`,
      [
        id,
        org,
        input.knowledge_source_id,
        input.kind,
        input.content_hash,
        input.manifest_hash,
        JSON.stringify(input.manifest),
        input.fingerprint,
        input.configuration_version,
        input.price_review_id,
        user,
        input.not_before,
        input.expires_at,
        input.max_requests,
        input.max_request_tokens,
        input.max_total_tokens,
        input.max_cost_microcents,
        input.currency,
        input.knowledge_version_id,
        input.source_revision_hash,
      ],
    );
    // Index authorization may be prepared while disabled, before enabling. All
    // other identity/price/source/tenant checks still apply on every send.
    const op = rows[0]!;
    if ((await sourceRevision(c, org, op.knowledge_source_id)) !== op.source_revision_hash)
      wait("embedding_configuration_changed");
    const source = await c.query(
      "select 1 from public.ai_knowledge_sources where organization_id=$1 and id=$2",
      [org, op.knowledge_source_id],
    );
    const price = await c.query<PriceRow>(
      "select * from public.ai_embedding_price_reviews where organization_id=$1 and id=$2",
      [org, op.price_review_id],
    );
    const config = await c.query(
      "select 1 from public.ai_embedding_configurations where organization_id=$1 and version=$2 and fingerprint=$3",
      [org, op.configuration_version, op.fingerprint],
    );
    if (!source.rows.length || !config.rows.length || !price.rows.length)
      return wait("embedding_authorization_required");
    const p = price.rows[0]!;
    await currentAdmin(c, org, p.reviewed_by);
    if (
      p.expires_at <= new Date() ||
      p.currency !== op.currency ||
      p.fingerprint !== op.fingerprint ||
      p.input_token_ceiling > op.max_request_tokens ||
      op.manifest.some((m) => m.bytes > p.input_byte_ceiling)
    )
      return wait("embedding_price_review_required");
    return id;
  });
}
export async function acquireIndexOperation(
  org: string,
  sourceId: string,
  contentHash: string,
  inputs: string[],
  profile: EmbeddingProfile,
  pool = getRequestPool(),
) {
  const { manifestHash } = inputManifest(inputs);
  return transaction(pool, async (c) => {
    // Serialize acquisition, including two distinct approved configurations.
    await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      "embedding-index:" + org + ":" + sourceId,
    ]);
    const { rows } = await c.query<OperationRow>(
      `select o.* from public.ai_embedding_operations o join public.ai_embedding_configurations cfg on cfg.organization_id=o.organization_id and cfg.version=o.configuration_version
      where o.organization_id=$1 and o.knowledge_source_id=$2 and o.kind='index' and o.content_hash=$3 and o.manifest_hash=$4 and o.fingerprint=$5 order by o.approved_at desc for update of o`,
      [org, sourceId, contentHash, manifestHash, profile.fingerprint],
    );
    const op = rows[0] ?? wait("embedding_authorization_required");
    await guard(c, op);
    if (op.status === "completed") {
      const active = await c.query(
        "select 1 from public.ai_knowledge_sources where organization_id=$1 and id=$2 and active_kb_version_id=$3",
        [org, sourceId, op.knowledge_version_id],
      );
      if (!active.rows.length) wait("embedding_operation_blocked");
      return { completed: true as const, operation: op, lease: null };
    }
    const running = await c.query<OperationRow>(
      "select * from public.ai_embedding_operations where organization_id=$1 and knowledge_source_id=$2 and kind='index' and status='running' for update",
      [org, sourceId],
    );
    for (const other of running.rows) {
      if (other.lease_until && other.lease_until > new Date()) wait("embedding_lease_busy");
      if (other.id !== op.id) wait("embedding_operation_blocked");
    }
    const uncertain = await c.query(
      `select 1 from public.ai_embedding_requests r join public.ai_embedding_operations old on old.organization_id=r.organization_id and old.id=r.operation_id
      where r.organization_id=$1 and old.knowledge_source_id=$2 and old.kind='index' and r.status in ('reserved','unknown') limit 1`,
      [org, sourceId],
    );
    if (uncertain.rows.length) {
      await c.query(
        "update public.ai_embedding_operations set status='blocked',last_error='embedding_request_uncertain' where organization_id=$1 and id=$2",
        [org, op.id],
      );
      return { completed: false as const, operation: op, lease: null };
    }
    const unresolved = await c.query(
      "select 1 from public.ai_embedding_requests where organization_id=$1 and operation_id=$2 and status<>'succeeded' limit 1",
      [org, op.id],
    );
    if (unresolved.rows.length) {
      await c.query(
        "update public.ai_embedding_operations set status='blocked',last_error='embedding_request_uncertain' where organization_id=$1 and id=$2",
        [org, op.id],
      );
      return { completed: false as const, operation: op, lease: null };
    }
    const owner = randomUUID();
    const updated = await c.query<OperationRow>(
      "update public.ai_embedding_operations set status='running',lease_owner=$3,lease_until=clock_timestamp()+interval '180 seconds',fence=fence+1 where organization_id=$1 and id=$2 returning *",
      [org, op.id, owner],
    );
    const current = updated.rows[0]!;
    return {
      completed: false as const,
      operation: current,
      lease: { operationId: op.id, organizationId: org, owner, fence: current.fence },
    };
  });
}
export async function releaseIndexLease(
  lease: OperationLease,
  pool = getRequestPool(),
): Promise<void> {
  await pool.query(
    "update public.ai_embedding_operations set lease_owner=null,lease_until=null where organization_id=$1 and id=$2 and lease_owner=$3 and fence=$4",
    [lease.organizationId, lease.operationId, lease.owner, lease.fence],
  );
}
export async function ensureIndexVersion(
  lease: OperationLease,
  sourceType: string,
  profile: EmbeddingProfile,
  pool = getRequestPool(),
): Promise<string> {
  return transaction(pool, async (c) => {
    const op = await lockOperation(c, lease.organizationId, lease.operationId);
    checkLease(op, lease);
    await guard(c, op);
    if (op.knowledge_version_id) {
      const version = await c.query(
        "select id from public.ai_knowledge_versions where organization_id=$1 and knowledge_source_id=$2 and id=$3 and status='building' and embedding_model=$4 and embedding_dims=$5",
        [
          op.organization_id,
          op.knowledge_source_id,
          op.knowledge_version_id,
          profile.fingerprint,
          profile.dimensions,
        ],
      );
      if (!version.rows.length) return wait("embedding_operation_blocked");
      return op.knowledge_version_id;
    }
    const { rows } = await c.query<{ id: string }>(
      `insert into public.ai_knowledge_versions(organization_id,knowledge_source_id,agent_id,version_number,description,status,is_active,embedding_model,embedding_dims,embedding_profile)
      select $1,$2,s.agent_id,coalesce((select max(version_number) from public.ai_knowledge_versions where organization_id=$1 and knowledge_source_id=$2),0)+1,$3,'building',false,$4,$5,$6 from public.ai_knowledge_sources s where s.organization_id=$1 and s.id=$2 returning id`,
      [
        op.organization_id,
        op.knowledge_source_id,
        "Indexação de " + sourceType,
        profile.fingerprint,
        profile.dimensions,
        JSON.stringify(profile),
      ],
    );
    const id = rows[0]!.id;
    await c.query(
      "update public.ai_embedding_operations set knowledge_version_id=$3 where organization_id=$1 and id=$2",
      [op.organization_id, op.id, id],
    );
    return id;
  });
}
/** All configured HTTP embeddings enter here: validation, query, Worker and cron.
 * send() is the private wire client. Its result never releases reserved budget.
 */
export async function executeAuthorizedEmbedding(
  profile: EmbeddingProfile,
  input: string,
  access: EmbeddingAccess,
  send: () => Promise<WireEmbeddingResult>,
  pool = getRequestPool(),
): Promise<WireEmbeddingResult> {
  const verified = embeddingProfile({
    provider: profile.provider,
    base_url: profile.baseUrl,
    model: profile.model,
    dimensions: profile.dimensions,
    model_revision: profile.revision,
    enabled: true,
  });
  if (verified.fingerprint !== profile.fingerprint) return wait("embedding_authorization_required");
  const hash = hashText(input),
    bytes = Buffer.byteLength(input);
  if (access.sourceIds.length !== 1) return wait("embedding_authorization_required");
  const reserved = await transaction(pool, async (c) => {
    let op: OperationRow;
    if (access.operationId) op = await lockOperation(c, access.organizationId, access.operationId);
    else {
      const found = await c.query<{ id: string }>(
        `select id from public.ai_embedding_operations where organization_id=$1 and knowledge_source_id=$2 and kind=$3 and fingerprint=$4 and status in ('approved','running','completed')
        and manifest @> $5::jsonb order by approved_at desc limit 1`,
        [
          access.organizationId,
          access.sourceIds[0],
          access.kind,
          profile.fingerprint,
          JSON.stringify([{ hash, bytes }]),
        ],
      );
      let matchedId = found.rows[0]?.id;
      if (!matchedId && access.kind === "query") {
        const bounded = await c.query<{ id: string }>(
          `select o.id
          from public.ai_embedding_operations o
          join public.ai_embedding_configurations cfg
            on cfg.organization_id=o.organization_id and cfg.version=o.configuration_version
          join public.ai_knowledge_sources s
            on s.organization_id=o.organization_id and s.id=o.knowledge_source_id and s.active_kb_version_id=o.knowledge_version_id
          where o.organization_id=$1 and o.knowledge_source_id=$2 and o.kind='query' and o.fingerprint=$3
            and o.status in ('approved','running','completed')
            and o.not_before<=clock_timestamp() and o.expires_at>clock_timestamp()
            and o.manifest @> $4::jsonb
          order by (o.reserved_requests < o.max_requests) desc, o.approved_at desc
          limit 1`,
          [
            access.organizationId,
            access.sourceIds[0],
            profile.fingerprint,
            JSON.stringify([{ position: 0, hash: BOUNDED_FREE_QUERY_MARKER_HASH }]),
          ],
        );
        matchedId = bounded.rows[0]?.id;
      }
      op = await lockOperation(
        c,
        access.organizationId,
        matchedId ?? wait("embedding_authorization_required"),
      );
    }
    if (
      op.kind !== access.kind ||
      op.knowledge_source_id !== access.sourceIds[0] ||
      op.fingerprint !== profile.fingerprint
    )
      wait("embedding_authorization_required");
    const price = await guard(c, op, access.kind === "validation");
    if (op.kind === "index") checkLease(op, access.lease);
    const boundedFree =
      op.kind === "query" && isBoundedFreeQueryManifest(op.manifest, op.manifest_hash);
    let exactPosition: number | null = null;
    if (boundedFree) {
      const maxQueryBytes = op.manifest[0]!.bytes;
      if (bytes < 1 || bytes > maxQueryBytes || bytes > price.input_byte_ceiling)
        wait("embedding_authorization_required");
    } else {
      const position =
        access.position ?? op.manifest.findIndex((m) => m.hash === hash && m.bytes === bytes);
      const entry = op.manifest[position];
      if (
        !entry ||
        entry.position !== position ||
        entry.hash !== hash ||
        entry.bytes !== bytes ||
        bytes > price.input_byte_ceiling
      )
        wait("embedding_authorization_required");
      exactPosition = position;
    }
    const prior = boundedFree
      ? await c.query<{
          id: string;
          status: string;
          embedding: string | null;
          actual_tokens: number;
        }>(
          "select id,status,response_embedding::text as embedding,actual_tokens from public.ai_embedding_requests where organization_id=$1 and operation_id=$2 and input_hash=$3 order by created_at desc limit 1",
          [op.organization_id, op.id, hash],
        )
      : await c.query<{
          id: string;
          status: string;
          embedding: string | null;
          actual_tokens: number;
        }>(
          "select id,status,response_embedding::text as embedding,actual_tokens from public.ai_embedding_requests where organization_id=$1 and operation_id=$2 and input_position=$3",
          [op.organization_id, op.id, exactPosition],
        );
    const cached = prior.rows[0];
    if (cached) {
      if (cached.status !== "succeeded" || !cached.embedding) wait("embedding_operation_blocked");
      const vector: unknown = JSON.parse(cached.embedding!);
      assertEmbedding(vector, profile.dimensions);
      return {
        op,
        requestId: cached.id,
        cached: { embedding: vector, promptTokens: cached.actual_tokens },
      };
    }
    if (boundedFree) {
      const uncertain = await c.query(
        "select 1 from public.ai_embedding_requests where organization_id=$1 and operation_id=$2 and status='unknown' limit 1",
        [op.organization_id, op.id],
      );
      if (uncertain.rows.length) wait("embedding_operation_blocked");
    }
    const allocatePosition = async (): Promise<number> => {
      if (exactPosition !== null) return exactPosition;
      const next = await c.query<{ next_pos: number }>(
        "select coalesce(max(input_position), -1) + 1 as next_pos from public.ai_embedding_requests where organization_id=$1 and operation_id=$2",
        [op.organization_id, op.id],
      );
      return next.rows[0]!.next_pos;
    };
    // Reuse only a durably successful response in the SAME tenant, source,
    // document and vector space. A failed/unknown slot is never reusable.
    const previous = await c.query<{
      id: string;
      embedding: string;
      actual_tokens: number;
      reserved_tokens: number;
    }>(
      `select r.id,r.response_embedding::text as embedding,r.actual_tokens,r.reserved_tokens
      from public.ai_embedding_requests r join public.ai_embedding_operations old on old.id=r.operation_id and old.organization_id=r.organization_id
      where r.organization_id=$1 and old.knowledge_source_id=$2 and old.content_hash=$3 and old.fingerprint=$4
        and old.kind=$5 and $5 <> 'validation' and r.input_hash=$6 and r.status='succeeded' and r.response_embedding is not null order by r.finished_at desc limit 1`,
      [op.organization_id, op.knowledge_source_id, op.content_hash, op.fingerprint, op.kind, hash],
    );
    const reusable = previous.rows[0];
    if (reusable) {
      const vector: unknown = JSON.parse(reusable.embedding);
      assertEmbedding(vector, profile.dimensions);
      const position = await allocatePosition();
      const id = randomUUID();
      await c.query(
        `insert into public.ai_embedding_requests(id,organization_id,operation_id,input_position,input_hash,fence,status,reserved_tokens,reserved_cost_microcents,actual_tokens,actual_cost_microcents,response_embedding,reused_from_request_id,finished_at)
        values($1,$2,$3,$4,$5,$6,'succeeded',$7,0,$8,0,$9::vector,$10,clock_timestamp())`,
        [
          id,
          op.organization_id,
          op.id,
          position,
          hash,
          op.fence,
          0,
          reusable.actual_tokens,
          reusable.embedding,
          reusable.id,
        ],
      );
      return {
        op,
        requestId: id,
        cached: { embedding: vector, promptTokens: reusable.actual_tokens },
      };
    }
    const tokens = price.input_token_ceiling,
      cost = upperCost(tokens, price.price_per_million_microcents);
    if (
      tokens > op.max_request_tokens ||
      op.reserved_requests + 1 > op.max_requests ||
      BigInt(op.reserved_tokens) + BigInt(tokens) > BigInt(op.max_total_tokens) ||
      BigInt(op.reserved_cost_microcents) + cost > BigInt(op.max_cost_microcents)
    )
      wait("embedding_budget_exhausted");
    const position = await allocatePosition();
    const id = randomUUID();
    await c.query(
      "insert into public.ai_embedding_requests(id,organization_id,operation_id,input_position,input_hash,fence,reserved_tokens,reserved_cost_microcents) values($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, op.organization_id, op.id, position, hash, op.fence, tokens, cost.toString()],
    );
    await c.query(
      "update public.ai_embedding_operations set reserved_requests=reserved_requests+1,reserved_tokens=reserved_tokens+$3,reserved_cost_microcents=reserved_cost_microcents+$4 where organization_id=$1 and id=$2",
      [op.organization_id, op.id, tokens, cost.toString()],
    );
    return { op, requestId: id, cached: null };
  });
  if (reserved.cached) return reserved.cached;
  // The second transaction holds config/source/operation row locks across HTTP,
  // closing the disable/takeover race AFTER the durable reservation committed.
  let failure: unknown;
  let sentAt = 0;
  let stillWithinLease = true;
  let result: WireEmbeddingResult | null;
  try {
    result = await transaction(pool, async (c) => {
      const op = await lockOperation(c, access.organizationId, reserved.op.id);
      const price = await guard(c, op, access.kind === "validation");
      if (op.kind === "index") checkLease(op, access.lease);
      const start = Date.now();
      try {
        sentAt = start;
        const wire = await send();
        assertEmbedding(wire.embedding, profile.dimensions);
        stillWithinLease =
          op.kind !== "index" || Boolean(op.lease_until && op.lease_until > new Date());
        if (
          !Number.isSafeInteger(wire.promptTokens) ||
          wire.promptTokens < 0 ||
          wire.promptTokens > price.input_token_ceiling
        )
          throw new Error("embedding_usage_exceeds_reviewed_bound");
        const actualCost = upperCost(wire.promptTokens, price.price_per_million_microcents);
        await c.query(
          "update public.ai_embedding_requests set status='succeeded',response_embedding=$3::vector,actual_tokens=$4,actual_cost_microcents=$5,upstream_request_id=$6,latency_ms=$7,finished_at=clock_timestamp() where organization_id=$1 and id=$2 and status='reserved'",
          [
            op.organization_id,
            reserved.requestId,
            JSON.stringify(wire.embedding),
            wire.promptTokens,
            actualCost.toString(),
            wire.upstreamRequestId?.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 200) ?? null,
            Date.now() - start,
          ],
        );
        if (op.kind === "index" && stillWithinLease)
          await c.query(
            "update public.ai_embedding_operations set lease_until=clock_timestamp()+interval '180 seconds' where organization_id=$1 and id=$2",
            [op.organization_id, op.id],
          );
        return wire;
      } catch (error) {
        failure = error;
        // We do not know if the upstream billed. Preserve all reserved counters.
        await c.query(
          "update public.ai_embedding_requests set status='unknown',error_code='embedding_request_uncertain',latency_ms=$3,finished_at=clock_timestamp() where organization_id=$1 and id=$2",
          [op.organization_id, reserved.requestId, Date.now() - start],
        );
        await c.query(
          "update public.ai_embedding_operations set status='blocked',last_error='embedding_request_uncertain' where organization_id=$1 and id=$2",
          [op.organization_id, op.id],
        );
        return null;
      }
    });
  } catch (error) {
    // SQL/COMMIT failure after HTTP cannot be retried. The reservation lives in
    // the earlier transaction. Best-effort classify it; even a DB outage leaves
    // a non-reusable reserved row, which blocks takeover safely.
    if (sentAt) {
      await pool
        .query(
          "update public.ai_embedding_requests set status='unknown',error_code='embedding_result_commit_uncertain',finished_at=clock_timestamp() where organization_id=$1 and id=$2 and status='reserved'",
          [access.organizationId, reserved.requestId],
        )
        .catch(() => undefined);
    }
    throw error;
  }
  if (failure) throw failure;
  if (!stillWithinLease) return wait("embedding_lease_busy");
  return result!;
}
export async function writeIndexChunk(
  lease: OperationLease,
  profile: EmbeddingProfile,
  position: number,
  content: string,
  metadata: Record<string, unknown>,
  pool = getRequestPool(),
): Promise<void> {
  await transaction(pool, async (c) => {
    const op = await lockOperation(c, lease.organizationId, lease.operationId);
    checkLease(op, lease);
    await guard(c, op);
    const request = await c.query<{ response_embedding: string; actual_tokens: number }>(
      "select response_embedding::text,actual_tokens from public.ai_embedding_requests where organization_id=$1 and operation_id=$2 and input_position=$3 and status='succeeded' and input_hash=$4",
      [op.organization_id, op.id, position, hashText(content)],
    );
    if (!request.rows.length || !op.knowledge_version_id)
      return wait("embedding_operation_blocked");
    const r = request.rows[0]!;
    await c.query(
      `insert into public.ai_embedding_chunks(organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,metadata,embedding,embedding_dims,embedding_fingerprint)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9::vector,$10,$11) on conflict(knowledge_source_id,kb_version_id,position) do nothing`,
      [
        op.organization_id,
        op.knowledge_source_id,
        op.knowledge_version_id,
        position,
        content,
        hashText(content),
        r.actual_tokens,
        JSON.stringify(metadata),
        r.response_embedding,
        profile.dimensions,
        profile.fingerprint,
      ],
    );
    await c.query(
      "update public.ai_embedding_operations set lease_until=clock_timestamp()+interval '180 seconds' where organization_id=$1 and id=$2",
      [op.organization_id, op.id],
    );
  });
}
export async function completeIndexOperation(
  lease: OperationLease,
  pool = getRequestPool(),
): Promise<void> {
  await transaction(pool, async (c) => {
    const op = await lockOperation(c, lease.organizationId, lease.operationId);
    checkLease(op, lease);
    await guard(c, op);
    const { rows } = await c.query<{ position: number; content_hash: string }>(
      "select position,content_hash from public.ai_embedding_chunks where organization_id=$1 and knowledge_source_id=$2 and kb_version_id=$3 order by position",
      [op.organization_id, op.knowledge_source_id, op.knowledge_version_id],
    );
    if (
      rows.length !== op.manifest.length ||
      rows.some((r, i) => r.position !== i || r.content_hash !== op.manifest[i]!.hash)
    )
      return wait("embedding_operation_blocked");
    await c.query(
      "update public.ai_knowledge_versions set status='ready',total_chunks=$3,indexed_at=clock_timestamp() where organization_id=$1 and id=$2 and status='building'",
      [op.organization_id, op.knowledge_version_id, rows.length],
    );
    await c.query("select public.fn_activate_embedding_version($1,$2,$3,$4)", [
      op.organization_id,
      op.knowledge_source_id,
      op.knowledge_version_id,
      op.fingerprint,
    ]);
    await c.query(
      "update public.ai_embedding_operations set status='completed',completed_at=clock_timestamp(),lease_owner=null,lease_until=null where organization_id=$1 and id=$2",
      [op.organization_id, op.id],
    );
  });
}
