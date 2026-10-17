import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import type { EventHandler } from "@/lib/event-log/dispatcher";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { enabledIntegration, integrationBinding, type IntegrationBinding } from "./config";
import { integrationFetch } from "./http";
import { integrationQuery } from "./db";

export const customerMemoryInput = z
  .object({
    contact_id: z.string().uuid(),
    request_key: z.string().uuid(),
    category: z.enum(["preference", "confirmed_fact", "communication_context"]),
    body: z.string().trim().min(1).max(2000),
    confirmed: z.literal(true),
  })
  .strict();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const userScope = (org: string, contact: string) => digest(`crm-customer:v1:${org}:${contact}`);
const memoryScope = (org: string, memory: string) => digest(`crm-memory:v1:${org}:${memory}`);
interface MemoryRow {
  id: string;
  organization_id: string;
  contact_id: string | null;
  subject_key: string;
  category: string;
  body: string;
  content_hash: string;
  sync_state: string;
  external_id: string | null;
  write_outcome: "never_started" | "in_flight" | "confirmed" | "unknown";
  deleted_at: string | null;
  remote_deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
const remoteSchema = z
  .object({
    id: z.string().min(1).max(200),
    memory: z.string().max(4000).optional(),
    user_id: z.string().optional(),
    run_id: z.string().optional(),
    metadata: z
      .object({ crm_id: z.string(), crm_hash: z.string(), crm_category: z.string() })
      .passthrough(),
  })
  .passthrough();

async function assertContact(pool: Pool, org: string, contact: string) {
  const { rows } = await integrationQuery(
    pool,
    "select id from contacts where organization_id=$1 and id=$2 and is_anonymized=false and is_merged_into is null",
    [org, contact],
  );
  if (!rows[0]) throw new Error("customer_memory_contact_unavailable");
}

/** Human-confirmed categories only; company/product policy belongs in the knowledge service. */
export async function saveCustomerMemory(
  pool: Pool,
  org: string,
  actor: string,
  input: z.infer<typeof customerMemoryInput>,
) {
  const parsed = customerMemoryInput.parse(input);
  const hash = digest(
    JSON.stringify({ contact: parsed.contact_id, category: parsed.category, body: parsed.body }),
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    const contact = await client.query(
      "select id from contacts where organization_id=$1 and id=$2 and is_anonymized=false and is_merged_into is null for update",
      [org, parsed.contact_id],
    );
    if (!contact.rows[0]) throw new Error("customer_memory_contact_unavailable");
    const created = await client.query<MemoryRow>(
      `insert into ai_customer_memories(organization_id,contact_id,request_key,category,body,content_hash,confirmed_by,subject_key)
       values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(organization_id,request_key) do nothing returning *`,
      [
        org,
        parsed.contact_id,
        parsed.request_key,
        parsed.category,
        parsed.body,
        hash,
        actor,
        userScope(org, parsed.contact_id),
      ],
    );
    const row =
      created.rows[0] ??
      (
        await client.query<MemoryRow>(
          "select * from ai_customer_memories where organization_id=$1 and request_key=$2",
          [org, parsed.request_key],
        )
      ).rows[0];
    if (!row || row.content_hash !== hash || row.deleted_at)
      throw new Error("customer_memory_idempotency_conflict");
    if (created.rows.length)
      await client.query(
        `insert into event_log(organization_id,event_type,entity_kind,entity_id,payload)
       values($1,'ai_integration.mem0_sync','ai_customer_memory',$2,$3::jsonb)`,
        [org, row.id, JSON.stringify({ memory_id: row.id })],
      );
    await client.query("commit");
    return { id: row.id, sync_state: row.sync_state, confirmed: true };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteCustomerMemory(pool: Pool, org: string, id: string) {
  // Tombstone and deletion request are one SQL statement: retrieval is blocked immediately.
  const { rows } = await pool.query(
    `with retired as (
      update ai_customer_memories set body='',remote_deleted_at=case when write_outcome='never_started' then now() else remote_deleted_at end,sync_state='deleted',deleted_at=coalesce(deleted_at,now()),updated_at=now()
      where organization_id=$1 and id=$2 returning id
    ) insert into event_log(organization_id,event_type,entity_kind,entity_id,payload)
      select $1,'ai_integration.mem0_sync','ai_customer_memory',id,jsonb_build_object('memory_id',id) from retired returning entity_id`,
    [org, id],
  );
  return rows.length > 0;
}

async function mem0Json(
  binding: IntegrationBinding,
  path: string,
  init: RequestInit,
  fetchImpl?: typeof fetch,
) {
  const response = await integrationFetch(
    binding,
    path,
    { ...init, headers: { "Content-Type": "application/json", "X-API-Key": binding.api_key! } },
    fetchImpl,
  );
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("mem0_response_too_large");
  return JSON.parse(text) as unknown;
}

async function assertProtocol(binding: IntegrationBinding, fetchImpl?: typeof fetch) {
  // Old official REST builds silently dropped infer:false. Do not send a fact to them.
  const spec = (await mem0Json(binding, "/openapi.json", { method: "GET" }, fetchImpl)) as {
    components?: {
      schemas?: {
        MemoryCreate?: { properties?: Record<string, unknown> };
        SearchRequest?: { properties?: Record<string, unknown> };
      };
    };
  };
  if (
    !spec.components?.schemas?.MemoryCreate?.properties?.infer ||
    !spec.components.schemas.SearchRequest?.properties?.filters
  )
    throw new Error("mem0_protocol_unsupported");
}

async function findRemote(binding: IntegrationBinding, row: MemoryRow, fetchImpl?: typeof fetch) {
  const user = row.subject_key;
  const run = memoryScope(row.organization_id, row.id);
  // Per-receipt run_id avoids capped broad listing and makes reconciliation independent of embedding ranking.
  const payload = await mem0Json(
    binding,
    `/memories?user_id=${user}&run_id=${run}&top_k=1000`,
    { method: "GET" },
    fetchImpl,
  );
  const values = z.object({ results: z.array(z.unknown()).max(1000) }).parse(payload).results;
  return values
    .map((value) => remoteSchema.parse(value))
    .filter((value) => {
      if (
        value.user_id !== user ||
        value.run_id !== run ||
        value.metadata.crm_id !== run ||
        value.metadata.crm_hash !== row.content_hash
      )
        throw new Error("mem0_ownership_mismatch");
      return true;
    });
}

/** On an ambiguous write, only reconcile. A missing result is not proof that re-adding is safe. */
export async function syncCustomerMemory(
  pool: Pool,
  org: string,
  id: string,
  fetchImpl?: typeof fetch,
) {
  const originalFetch = fetchImpl ?? fetch;
  const deadline = AbortSignal.timeout(15000);
  fetchImpl = (url, init) =>
    originalFetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
    });
  const binding = await enabledIntegration(pool, org, "mem0");
  if (!binding) return "disabled";
  const { rows } = await integrationQuery<MemoryRow>(
    pool,
    "select * from ai_customer_memories where organization_id=$1 and id=$2",
    [org, id],
  );
  const row = rows[0];
  if (!row) return "absent";
  if (row.deleted_at && row.remote_deleted_at) return "deleted";
  const matches = await findRemote(binding, row, fetchImpl);
  if (row.deleted_at) {
    for (const remote of matches.slice(0, 10))
      await mem0Json(
        binding,
        `/memories/${encodeURIComponent(remote.id)}`,
        { method: "DELETE" },
        fetchImpl,
      );
    if ((await findRemote(binding, row, fetchImpl)).length)
      throw new Error("mem0_deletion_pending");
    // An earlier timed-out ADD can commit later. Empty GET alone never clears that fence.
    if (row.write_outcome === "in_flight" || row.write_outcome === "unknown")
      return "reconciliation_required";
    await integrationQuery(
      pool,
      "update ai_customer_memories set remote_deleted_at=now(),updated_at=now() where organization_id=$1 and id=$2 and deleted_at is not null",
      [org, id],
    );
    return "deleted";
  }
  if (!row.contact_id) throw new Error("customer_memory_contact_unavailable");
  await assertContact(pool, org, row.contact_id);
  if (
    matches.length === 1 &&
    (row.write_outcome === "unknown" || row.write_outcome === "in_flight")
  ) {
    await integrationQuery(
      pool,
      "update ai_customer_memories set external_id=$3,sync_state='reconcile',updated_at=now() where organization_id=$1 and id=$2 and deleted_at is null",
      [org, id, matches[0]!.id],
    );
    return "reconciliation_required";
  }
  if (matches.length === 1) {
    await integrationQuery(
      pool,
      "update ai_customer_memories set external_id=$3,sync_state='synced',updated_at=now() where organization_id=$1 and id=$2 and deleted_at is null",
      [org, id, matches[0]!.id],
    );
    return "synced";
  }
  if (matches.length > 1 || row.sync_state !== "pending") {
    await integrationQuery(
      pool,
      "update ai_customer_memories set sync_state='reconcile',updated_at=now() where organization_id=$1 and id=$2 and deleted_at is null",
      [org, id],
    );
    return "reconciliation_required";
  }
  await assertProtocol(binding, fetchImpl);
  const claim = await integrationQuery(
    pool,
    "update ai_customer_memories set sync_state='sending',write_outcome='in_flight',write_started_at=now(),updated_at=now() where organization_id=$1 and id=$2 and sync_state='pending' and deleted_at is null returning id",
    [org, id],
  );
  if (!claim.rows[0]) return "reconciliation_required";
  try {
    if (!row.contact_id) throw new Error("customer_memory_contact_unavailable");
    await assertContact(pool, org, row.contact_id);
    await mem0Json(
      binding,
      "/memories",
      {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: row.body }],
          user_id: row.subject_key,
          run_id: memoryScope(org, id),
          infer: false,
          metadata: {
            crm_id: memoryScope(org, id),
            crm_hash: row.content_hash,
            crm_category: row.category,
          },
        }),
      },
      fetchImpl,
    );
    // Verify the stored ownership metadata, rather than trusting an add response or caller-provided ID.
    const verified = await findRemote(binding, row, fetchImpl);
    if (verified.length !== 1) throw new Error("mem0_write_unverified");
    await integrationQuery(
      pool,
      "update ai_customer_memories set external_id=$3,write_outcome='confirmed',sync_state=case when deleted_at is null then 'synced' else 'deleted' end,updated_at=now() where organization_id=$1 and id=$2",
      [org, id, verified[0]!.id],
    );
    return "synced";
  } catch {
    await integrationQuery(
      pool,
      "update ai_customer_memories set write_outcome='unknown',sync_state=case when deleted_at is null then 'reconcile' else 'deleted' end,updated_at=now() where organization_id=$1 and id=$2",
      [org, id],
    );
    throw new Error("mem0_write_outcome_unknown");
  }
}

export async function readConfirmedCustomerMemory(
  pool: Pool,
  org: string,
  contact: string,
  query = "Customer preferences and confirmed communication context",
  signal?: AbortSignal,
) {
  await assertContact(pool, org, contact);
  // CRM owns the confirmed facts. Optional Mem0 only ranks owned local IDs.
  const binding = integrationBinding(org, "mem0")
    ? await enabledIntegration(pool, org, "mem0").catch(() => null)
    : null;
  const local = await integrationQuery<MemoryRow>(
    pool,
    "select * from ai_customer_memories where organization_id=$1 and contact_id=$2 and deleted_at is null order by created_at desc limit 50",
    [org, contact],
  );
  let ids: string[] = [];
  let status = binding ? "local_fallback" : "local";
  let providerStatus = binding ? "unavailable" : "disabled";
  if (binding)
    try {
      const payload = await mem0Json(binding, "/search", {
        method: "POST",
        signal,
        body: JSON.stringify({
          query: query.slice(0, 2000),
          filters: { user_id: userScope(org, contact) },
          top_k: 10,
        }),
      });
      const results = z.object({ results: z.array(z.unknown()).max(100) }).parse(payload).results;
      // Remote content is never trusted: rank only known owned IDs, then use current local facts.
      ids = results
        .map((value) => remoteSchema.parse(value))
        .filter((value) => value.user_id === userScope(org, contact))
        .flatMap((value) =>
          local.rows
            .filter(
              (row) =>
                row.external_id === value.id &&
                value.metadata.crm_id === memoryScope(org, row.id) &&
                value.metadata.crm_hash === row.content_hash,
            )
            .map((row) => row.id),
        );
      status = "mem0";
      providerStatus = "connected";
    } catch {
      signal?.throwIfAborted();
    }
  await assertContact(pool, org, contact);
  const fresh = await integrationQuery<MemoryRow>(
    pool,
    "select * from ai_customer_memories where organization_id=$1 and contact_id=$2 and deleted_at is null order by created_at desc limit 50",
    [org, contact],
  );
  const ordered = ids.length
    ? [...fresh.rows].sort((a, b) => {
        const rank = (id: string) => (ids.includes(id) ? ids.indexOf(id) : 999);
        return rank(a.id) - rank(b.id);
      })
    : fresh.rows;
  return {
    status,
    source: "crm_confirmed_facts",
    schemaVersion: 1,
    providerStatus,
    coverage: ordered.length > 10 ? "partial" : "complete",
    returnedCount: Math.min(ordered.length, 10),
    // Bounded selection, not a claim that all CRM facts were read.
    readLimit: 50,
    memories: ordered.slice(0, 10).map((row) => ({
      id: row.id,
      category: row.category,
      body: row.body,
      revision: row.content_hash,
      confirmed: true,
      created_at: row.created_at,
      updated_at: row.updated_at,
      authority: "customer_context_only",
    })),
  };
}

export const mem0SyncHandler: EventHandler = {
  lane: "integration",
  key: "ai_integration.mem0_v1",
  events: ["ai_integration.mem0_sync"],
  async handle(row) {
    try {
      const { memory_id } = z.object({ memory_id: z.string().uuid() }).strict().parse(row.payload);
      const outcome = await syncCustomerMemory(getRequestPool(), row.organization_id, memory_id);
      if (outcome === "disabled")
        return {
          consumer_key: this.key,
          status: "retry",
          retry_at: new Date(Date.now() + 300_000).toISOString(),
          detail: "integration_disabled",
        };
      if (outcome === "reconciliation_required")
        return { consumer_key: this.key, status: "error", detail: "mem0_reconciliation_required" };
      return { consumer_key: this.key, status: "ok" };
    } catch {
      return { consumer_key: this.key, status: "error", detail: "mem0_sync_failed" };
    }
  },
};

/** Explicit human acknowledgement after checking the service; never retries ADD. */
export async function reconcileCustomerMemory(
  pool: Pool,
  org: string,
  id: string,
  fetchImpl?: typeof fetch,
) {
  const binding = await enabledIntegration(pool, org, "mem0");
  if (!binding) throw new Error("mem0_not_enabled");
  const { rows } = await integrationQuery<MemoryRow>(
    pool,
    "select * from ai_customer_memories where organization_id=$1 and id=$2 and coalesce(write_started_at,created_at)<now()-interval '60 seconds'",
    [org, id],
  );
  const row = rows[0];
  if (!row || !["unknown", "in_flight"].includes(row.write_outcome))
    throw new Error("memory_resolution_not_ready");
  const matches = await findRemote(binding, row, fetchImpl);
  if (matches.length > 1) throw new Error("mem0_receipt_collision");
  await integrationQuery(
    pool,
    `with settled as (
      update ai_customer_memories set write_outcome='confirmed',external_id=$3,
        sync_state=case when deleted_at is not null then 'deleted' when $3::text is not null then 'synced' else 'reconcile' end,
        updated_at=now() where organization_id=$1 and id=$2 and write_outcome in ('unknown','in_flight') returning id
    ) insert into event_log(organization_id,event_type,entity_kind,entity_id,payload)
      select $1,'ai_integration.mem0_sync','ai_customer_memory',id,jsonb_build_object('memory_id',id) from settled`,
    [org, id, matches[0]?.id ?? null],
  );
  return {
    id,
    status: row.deleted_at
      ? "deletion_pending_verification"
      : matches.length
        ? "synced"
        : "settled_without_remote_record",
  };
}
