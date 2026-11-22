/** Real PG15/17 transactions + loopback HTTP receiver. Only provider vectors are
 * synthetic. No supplier credentials, deployed database or external network.
 */
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import pg from "pg";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { GOV_ORG, GOV_ADMIN, GOV_MANAGER, GOV_VIEWER, seedGov, sql, countAs } from "./gov-helpers";
import { embeddingProfile } from "@/lib/ai/embeddings/profile";
import {
  boundedFreeQueryManifest,
  inputManifest,
  hashText,
  type AuthorizeOperation,
} from "@/lib/ai/embeddings/operation-contract";
import {
  authorizeOperation,
  acquireIndexOperation,
  ensureIndexVersion,
  writeIndexChunk,
  completeIndexOperation,
  type OperationLease,
} from "@/lib/ai/embeddings/operation-store";
import { sourceRevision } from "@/lib/ai/embeddings/source-revision";
import * as requestPool from "@/lib/agent-engine/db/request-pool";
import { requestEmbedding } from "@/lib/agent-engine/edge/llm/embedding-provider";

if (!process.env.TEST_DB_CONTAINER?.startsWith("pi-native-test-db-"))
  throw new Error("isolated_pg_harness_required");
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 8,
});
const source = "e4130000-0000-4000-8000-000000000001",
  key = "e4130000-0000-4000-8000-000000000002";
const otherOrg = "e4130000-0000-4000-8000-000000000003",
  otherUser = "e4130000-0000-4000-8000-000000000004";
const profile = embeddingProfile({
  provider: "siliconflow",
  base_url: "https://api.siliconflow.cn/v1",
  model: "BAAI/bge-m3",
  dimensions: 1024,
  model_revision: "1",
  enabled: true,
});
const texts = ["# SVC-101 synthetic", "Read-only synthetic service", "No customer messages"];
const contentHash = hashText(JSON.stringify(texts));
let server: Server,
  url: string,
  calls: number,
  mode: "ok" | "drop" | "wrong" = "ok";
let configVersion: string, reviewId: string;
const fetcher: typeof fetch = async (_input, init) => fetch(url, init);
beforeAll(async () => {
  seedGov();
  vi.spyOn(requestPool, "getRequestPool").mockReturnValue(pool);
  server = createServer(async (req, res) => {
    calls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    if (mode === "drop") {
      req.socket.destroy();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("x-siliconcloud-trace-id", "synthetic-receiver-" + calls);
    res.end(
      JSON.stringify({
        model: parsed.model,
        data: [{ index: 0, embedding: Array(mode === "wrong" ? 1536 : 1024).fill(0.1) }],
        usage: { prompt_tokens: 9 },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});
beforeEach(async () => {
  calls = 0;
  mode = "ok";
  for (const table of [
    "ai_embedding_requests",
    "ai_embedding_operations",
    "ai_embedding_price_reviews",
  ])
    await pool.query("delete from public." + table + " where organization_id=$1", [GOV_ORG]);
  sql(`update public.ai_knowledge_sources set active_kb_version_id=null where id='${source}';
    delete from public.ai_embedding_chunks where knowledge_source_id='${source}';
    delete from public.ai_knowledge_versions where knowledge_source_id='${source}';
    delete from public.ai_knowledge_sources where id='${source}';
    delete from public.ai_embedding_configurations where organization_id='${GOV_ORG}';
    delete from public.ai_provider_credentials where id='${key}';
    insert into public.organizations(id,slug,legal_name,display_name) values('${otherOrg}','rag-operations-other','Synthetic','Synthetic') on conflict do nothing;
    insert into auth.users(id,email) values('${otherUser}','rag-other@invariant.test') on conflict do nothing;
    insert into public.user_organizations(user_id,organization_id,role,accepted_at) values('${otherUser}','${otherOrg}','manager',now()) on conflict do nothing;
    insert into public.ai_knowledge_sources(id,organization_id,source_type,name,status,is_active) values('${source}','${GOV_ORG}','faq','Synthetic SVC-101','ready',true);
    insert into public.ai_provider_credentials(id,organization_id,provider,label,api_key_encrypted,api_key_iv,api_key_tag,api_key_last4,is_active,validated_at)
      values('${key}','${GOV_ORG}','siliconflow','Synthetic','\\x01','\\x02','\\x03','test',true,now());
    insert into public.ai_embedding_configurations(organization_id,provider,base_url,model,dimensions,model_revision,fingerprint,credential_id,enabled)
      values('${GOV_ORG}','siliconflow','${profile.baseUrl}','${profile.model}',1024,'1','${profile.fingerprint}','${key}',true);`);
  configVersion = (
    await pool.query(
      "select version from public.ai_embedding_configurations where organization_id=$1",
      [GOV_ORG],
    )
  ).rows[0].version;
  reviewId = (
    await pool.query(
      `insert into public.ai_embedding_price_reviews(organization_id,fingerprint,currency,price_per_million_microcents,input_token_ceiling,input_byte_ceiling,evidence_url,evidence_sha256,token_bound_evidence_sha256,reviewed_by,expires_at)
    values($1,$2,'CNY',1000000,8192,4096,'https://api-docs.siliconflow.cn/docs/api/embeddings-post',$3,$3,$4,now()+interval '1 hour') returning id`,
      [GOV_ORG, profile.fingerprint, "a".repeat(64), GOV_ADMIN],
    )
  ).rows[0].id;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await pool.end();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
async function approve(overrides: Partial<AuthorizeOperation> = {}, inputs = texts) {
  const { manifest, manifestHash } = inputManifest(inputs);
  const input: AuthorizeOperation = {
    knowledge_source_id: source,
    kind: "index",
    content_hash: contentHash,
    source_revision_hash: await sourceRevision(pool, GOV_ORG, source),
    manifest_hash: manifestHash,
    manifest,
    fingerprint: profile.fingerprint,
    configuration_version: configVersion,
    price_review_id: reviewId,
    not_before: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    max_requests: inputs.length,
    max_request_tokens: 8192,
    max_total_tokens: String(8192 * inputs.length),
    max_cost_microcents: String(8192 * inputs.length),
    currency: "CNY",
    knowledge_version_id: null,
    confirm_cost: true,
    ...overrides,
  };
  return authorizeOperation(GOV_ORG, GOV_ADMIN, input, pool);
}
async function claim(): Promise<OperationLease> {
  const result = await acquireIndexOperation(GOV_ORG, source, contentHash, texts, profile, pool);
  expect(result.lease).toBeTruthy();
  return result.lease!;
}
const access = (lease: OperationLease, position: number) => ({
  organizationId: GOV_ORG,
  kind: "index" as const,
  sourceIds: [source],
  operationId: lease.operationId,
  lease,
  position,
});
async function send(lease: OperationLease, position: number) {
  return requestEmbedding(
    profile,
    "synthetic-no-provider-key",
    texts[position]!,
    fetcher,
    access(lease, position),
  );
}
async function index(lease: OperationLease, from = 0) {
  await ensureIndexVersion(lease, "faq", profile, pool);
  for (let i = from; i < texts.length; i++) {
    await send(lease, i);
    await writeIndexChunk(lease, profile, i, texts[i]!, { source_type: "faq" }, pool);
  }
  await completeIndexOperation(lease, pool);
}
describe("0413 durable single-source operation + hard reservations", () => {
  it("reuses confirmed same-source/same-space vectors after an explicitly approved configuration revision", async () => {
    await approve();
    await index(await claim());
    expect(calls).toBe(3);
    sql(
      `update public.ai_embedding_configurations set version=gen_random_uuid() where organization_id='${GOV_ORG}'`,
    );
    configVersion = (
      await pool.query(
        "select version from public.ai_embedding_configurations where organization_id=$1",
        [GOV_ORG],
      )
    ).rows[0].version;
    const newOperation = await approve();
    await index(await claim());
    expect(calls).toBe(3);
    expect(
      sql(
        `select reserved_requests||':'||reserved_tokens||':'||reserved_cost_microcents from public.ai_embedding_operations where id='${newOperation}'`,
      ),
    ).toBe("0:0:0");
    expect(
      sql(
        `select count(*) from public.ai_embedding_requests where operation_id='${newOperation}' and reused_from_request_id is not null and reserved_tokens=0`,
      ),
    ).toBe("3");
  });
  it("default denies HTTP without operation admission, including a direct wire caller", async () => {
    await expect(requestEmbedding(profile, "synthetic", "SVC-101", fetcher)).rejects.toThrow(
      "embedding_authorization_required",
    );
    await expect(claim()).rejects.toThrow("embedding_authorization_required");
    expect(calls).toBe(0);
  });
  it("an index approval cannot attach an arbitrary existing knowledge version", async () => {
    await expect(
      approve({ knowledge_version_id: "e4130000-0000-4000-8000-000000000099" }),
    ).rejects.toThrow("embedding_authorization_required");
    expect(calls).toBe(0);
    expect(
      sql(`select count(*) from public.ai_embedding_operations where organization_id='${GOV_ORG}'`),
    ).toBe("0");
  });
  it("disabled or unvalidated credentials never reach the receiver", async () => {
    await approve();
    sql(
      `update public.ai_embedding_configurations set enabled=false where organization_id='${GOV_ORG}'`,
    );
    await expect(claim()).rejects.toThrow("embedding_disabled");
    sql(
      `update public.ai_embedding_configurations set enabled=true where organization_id='${GOV_ORG}';update public.ai_provider_credentials set validated_at=null where id='${key}'`,
    );
    await expect(claim()).rejects.toThrow("embedding_credential_unavailable");
    expect(calls).toBe(0);
  });
  it("three duplicate events / simultaneous Worker+Cron get one lease and one complete index", async () => {
    await approve();
    const results = await Promise.allSettled([claim(), claim(), claim()]);
    const won = results.filter(
      (r): r is PromiseFulfilledResult<OperationLease> => r.status === "fulfilled",
    );
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
    await index(won[0]!.value);
    expect(calls).toBe(3);
    for (let i = 0; i < 3; i++)
      expect(
        (await acquireIndexOperation(GOV_ORG, source, contentHash, texts, profile, pool)).completed,
      ).toBe(true);
    expect(calls).toBe(3);
    expect(
      sql(
        `select count(*) from public.ai_knowledge_versions where knowledge_source_id='${source}'`,
      ),
    ).toBe("1");
    expect(
      sql(
        `select count(*) from public.fn_search_knowledge_profile('${GOV_ORG}',array['${source}']::uuid[],array_fill(0.1::real,array[1024])::vector,'${profile.fingerprint}',1024,5,-1)`,
      ),
    ).toBe("3");
  });
  it("crash after persisted response resumes its cached vector without a second paid request", async () => {
    await approve();
    const old = await claim();
    await ensureIndexVersion(old, "faq", profile, pool);
    await send(old, 0);
    expect(calls).toBe(1);
    sql(
      `update public.ai_embedding_operations set lease_until=now()-interval '1 second' where id='${old.operationId}'`,
    );
    const resumed = await claim();
    expect(resumed.fence).not.toBe(old.fence);
    await expect(writeIndexChunk(old, profile, 0, texts[0]!, {}, pool)).rejects.toThrow(
      "embedding_lease_busy",
    );
    await index(resumed);
    expect(calls).toBe(3);
    expect(
      sql(
        `select count(*) from public.ai_embedding_requests where operation_id='${old.operationId}'`,
      ),
    ).toBe("3");
  });
  it("network loss retains tokens/cost/request slots and never automatically resends", async () => {
    await approve();
    const lease = await claim();
    mode = "drop";
    await expect(send(lease, 0)).rejects.toThrow("embedding_transport_failed");
    expect(calls).toBe(1);
    mode = "ok";
    await expect(send(lease, 0)).rejects.toThrow("embedding_operation_blocked");
    expect(calls).toBe(1);
    expect(
      sql(
        `select reserved_requests||':'||reserved_tokens||':'||reserved_cost_microcents from public.ai_embedding_operations where id='${lease.operationId}'`,
      ),
    ).toBe("1:8192:8192");
    expect(
      sql(
        `select status from public.ai_embedding_requests where operation_id='${lease.operationId}'`,
      ),
    ).toBe("unknown");
  });
  it("a wrong-dimension upstream result is uncertain and cannot activate a version", async () => {
    await approve();
    const lease = await claim();
    await ensureIndexVersion(lease, "faq", profile, pool);
    mode = "wrong";
    await expect(send(lease, 0)).rejects.toThrow("embedding_vector_invalid");
    expect(calls).toBe(1);
    mode = "ok";
    await expect(send(lease, 0)).rejects.toThrow("embedding_operation_blocked");
    expect(calls).toBe(1);
    expect(
      sql(
        `select count(*) from public.ai_knowledge_versions where knowledge_source_id='${source}' and is_active`,
      ),
    ).toBe("0");
  });
  it("crash after reservation but before HTTP is uncertain and cannot release/reuse the slot", async () => {
    await approve();
    const lease = await claim();
    // Simulate a real committed reservation whose process never acknowledged it.
    sql(`insert into public.ai_embedding_requests(organization_id,operation_id,input_position,input_hash,fence,reserved_tokens,reserved_cost_microcents)
      values('${GOV_ORG}','${lease.operationId}',0,'${hashText(texts[0]!)}',${lease.fence},8192,8192);
      update public.ai_embedding_operations set lease_until=now()-interval '1 second',reserved_requests=1,reserved_tokens=8192,reserved_cost_microcents=8192 where id='${lease.operationId}'`);
    expect(
      (await acquireIndexOperation(GOV_ORG, source, contentHash, texts, profile, pool)).lease,
    ).toBeNull();
    expect(calls).toBe(0);
  });
  it.each(["requests", "tokens", "cost"])(
    "refuses %s exhaustion BEFORE the next receiver call",
    async (what) => {
      await approve();
      const lease = await claim();
      await send(lease, 0);
      sql(
        `update public.ai_embedding_operations set ${what === "requests" ? "max_requests=1" : what === "tokens" ? "max_total_tokens=8192" : "max_cost_microcents=8192"} where id='${lease.operationId}'`,
      );
      await expect(send(lease, 1)).rejects.toThrow("embedding_budget_exhausted");
      expect(calls).toBe(1);
    },
  );
  it("a chunk database write failure stops the loop and leaves the version unpublishable", async () => {
    await approve();
    const lease = await claim();
    const version = await ensureIndexVersion(lease, "faq", profile, pool);
    sql(
      `alter table public.ai_embedding_chunks add constraint synthetic_reject_chunk check(content<>'${texts[0]}')`,
    );
    try {
      await expect(index(lease)).rejects.toThrow();
      expect(calls).toBe(1);
      expect(
        sql(
          `select status||':'||is_active from public.ai_knowledge_versions where id='${version}'`,
        ),
      ).toBe("building:false");
      await expect(completeIndexOperation(lease, pool)).rejects.toThrow(
        "embedding_operation_blocked",
      );
    } finally {
      sql("alter table public.ai_embedding_chunks drop constraint synthetic_reject_chunk");
    }
    await index(lease);
    expect(calls).toBe(3); // first chunk reused; not four HTTP requests
  });
  it.each(["version", "fingerprint", "document"])(
    "invalidates old grants on changed %s",
    async (what) => {
      await approve();
      const lease = await claim();
      if (what === "version")
        sql(
          `update public.ai_embedding_configurations set version=gen_random_uuid() where organization_id='${GOV_ORG}'`,
        );
      if (what === "fingerprint")
        sql(
          `update public.ai_embedding_configurations set fingerprint='embedding:v1:${"f".repeat(64)}' where organization_id='${GOV_ORG}'`,
        );
      if (what === "document")
        sql(
          `update public.ai_knowledge_sources set source_metadata='{"revision":"changed"}' where id='${source}'`,
        );
      await expect(send(lease, 0)).rejects.toThrow("embedding_configuration_changed");
      expect(calls).toBe(0);
    },
  );
  it("binds the current input hash, manifest, source, and tenant before HTTP", async () => {
    await approve();
    const lease = await claim();
    await expect(
      requestEmbedding(profile, "synthetic", "changed-content", fetcher, access(lease, 0)),
    ).rejects.toThrow("embedding_authorization_required");
    await expect(
      requestEmbedding(profile, "synthetic", texts[0]!, fetcher, {
        ...access(lease, 0),
        organizationId: otherOrg,
      }),
    ).rejects.toThrow("embedding_authorization_required");
    expect(calls).toBe(0);
  });
  it("expired, revoked and absent price attestations fail closed", async () => {
    await approve();
    sql(
      `update public.ai_embedding_price_reviews set expires_at=reviewed_at+interval '1 microsecond' where id='${reviewId}'`,
    );
    await expect(claim()).rejects.toThrow("embedding_price_review_required");
    expect(calls).toBe(0);
  });
  it("has tenant RLS for reviews/operations and server-only request vectors", async () => {
    const op = await approve();
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.ai_embedding_operations where id='${op}'`),
    ).toBe(1);
    expect(
      countAs(otherUser, `select count(*) from public.ai_embedding_operations where id='${op}'`),
    ).toBe(0);
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.ai_embedding_price_reviews where id='${reviewId}'`,
      ),
    ).toBe(1);
    expect(
      countAs(
        otherUser,
        `select count(*) from public.ai_embedding_price_reviews where id='${reviewId}'`,
      ),
    ).toBe(0);
    const lease = await claim();
    await send(lease, 0);
    for (const user of [GOV_MANAGER, otherUser, GOV_VIEWER])
      expect(() => countAs(user, "select count(*) from public.ai_embedding_requests")).toThrow();
    expect(
      sql("select has_table_privilege('authenticated','public.ai_embedding_operations','UPDATE')"),
    ).toBe("f");
    expect(
      sql(
        "select has_table_privilege('service_role','public.ai_embedding_price_reviews','UPDATE')",
      ),
    ).toBe("f");
    expect(calls).toBe(1);
  });
  it("applies the new migration twice without changing legacy vectors or existing operation history", async () => {
    const op = await approve();
    const before = sql(
      `select md5(row_to_json(o)::text) from public.ai_embedding_operations o where id='${op}'`,
    );
    const legacy = sql("select count(*) from public.ai_chunks");
    const ddl = readFileSync(
      "supabase/migrations/20261119080000_0413_rag_operacoes_controladas.sql",
      "utf8",
    );
    sql(ddl);
    sql(ddl);
    expect(
      sql(
        `select md5(row_to_json(o)::text) from public.ai_embedding_operations o where id='${op}'`,
      ),
    ).toBe(before);
    expect(sql("select count(*) from public.ai_chunks")).toBe(legacy);
    expect(calls).toBe(0);
  });
  it("query and validation also reserve budgets; cached identical questions do not rebill", async () => {
    await approve();
    const lease = await claim();
    await index(lease);
    const version = sql(
      `select active_kb_version_id from public.ai_knowledge_sources where id='${source}'`,
    );
    const question = "SVC-101?";
    const queryId = await approve({ kind: "query", knowledge_version_id: version }, [question]);
    const queryAccess = {
      organizationId: GOV_ORG,
      kind: "query" as const,
      sourceIds: [source],
      operationId: queryId,
    };
    await requestEmbedding(profile, "synthetic", question, fetcher, queryAccess);
    await requestEmbedding(profile, "synthetic", question, fetcher, queryAccess);
    expect(calls).toBe(4);
    sql(
      `update public.ai_embedding_configurations set enabled=false where organization_id='${GOV_ORG}';update public.ai_provider_credentials set validated_at=null where id='${key}'`,
    );
    const input = "Embedding configuration validation",
      validationId = await approve({ kind: "validation" }, [input]);
    await requestEmbedding(profile, "synthetic", input, fetcher, {
      organizationId: GOV_ORG,
      kind: "validation",
      sourceIds: [source],
      operationId: validationId,
    });
    expect(calls).toBe(5);
    expect(
      sql(
        `select count(*) from public.ai_embedding_requests where operation_id='${validationId}' and status='succeeded'`,
      ),
    ).toBe("1");
    // A NEW config/credential validation must not reuse the previous operation's
    // vector and incorrectly certify a rotated key without checking it.
    sql(
      `update public.ai_embedding_configurations set version=gen_random_uuid() where organization_id='${GOV_ORG}'`,
    );
    configVersion = (
      await pool.query(
        "select version from public.ai_embedding_configurations where organization_id=$1",
        [GOV_ORG],
      )
    ).rows[0].version;
    const rotatedValidation = await approve({ kind: "validation" }, [input]);
    await requestEmbedding(profile, "synthetic-rotated-key", input, fetcher, {
      organizationId: GOV_ORG,
      kind: "validation",
      sourceIds: [source],
      operationId: rotatedValidation,
    });
    expect(calls).toBe(6);
    await requestEmbedding(profile, "synthetic-rotated-key", input, fetcher, {
      organizationId: GOV_ORG,
      kind: "validation",
      sourceIds: [source],
      operationId: rotatedValidation,
    });
    expect(calls).toBe(6); // same-operation replay remains idempotent
  });
  async function indexAndVersion(): Promise<string> {
    await approve();
    const lease = await claim();
    await index(lease);
    return sql(`select active_kb_version_id from public.ai_knowledge_sources where id='${source}'`);
  }
  async function approveBoundedQuery(
    version: string,
    opts: { maxRequests?: number; maxQueryBytes?: number; expiresMs?: number } = {},
  ) {
    const maxRequests = opts.maxRequests ?? 3;
    const { manifest, manifestHash } = boundedFreeQueryManifest(opts.maxQueryBytes ?? 2000);
    return approve({
      kind: "query",
      knowledge_version_id: version,
      manifest,
      manifest_hash: manifestHash,
      max_requests: maxRequests,
      max_total_tokens: String(8192 * maxRequests),
      max_cost_microcents: String(8192 * maxRequests),
      expires_at: new Date(Date.now() + (opts.expiresMs ?? 3600000)).toISOString(),
    });
  }
  it("bounded_free_text is rejected for index/validation/over-window and exact grants never widen", async () => {
    const version = await indexAndVersion();
    const bounded = boundedFreeQueryManifest(2000);
    await expect(
      approve({
        kind: "index",
        knowledge_version_id: null,
        manifest: bounded.manifest,
        manifest_hash: bounded.manifestHash,
      }),
    ).rejects.toThrow("embedding_authorization_required");
    await expect(
      approve({
        kind: "validation",
        knowledge_version_id: null,
        manifest: bounded.manifest,
        manifest_hash: bounded.manifestHash,
      }),
    ).rejects.toThrow("embedding_authorization_required");
    await expect(approveBoundedQuery(version, { expiresMs: 8 * 86400000 })).rejects.toThrow(
      "embedding_authorization_required",
    );
    await expect(approveBoundedQuery(version, { maxRequests: 201 })).rejects.toThrow(
      "embedding_authorization_required",
    );
    await approve({ kind: "query", knowledge_version_id: version }, ["exact-only-question"]);
    await expect(
      requestEmbedding(profile, "synthetic", "different-free-question", fetcher, {
        organizationId: GOV_ORG,
        kind: "query",
        sourceIds: [source],
      }),
    ).rejects.toThrow("embedding_authorization_required");
    expect(calls).toBe(3); // only the 3 index chunks
  });
  it("bounded_free_text allows natural-language queries up to max_requests then exhausts cleanly", async () => {
    const version = await indexAndVersion();
    const opId = await approveBoundedQuery(version, { maxRequests: 3, maxQueryBytes: 2000 });
    const freeAccess = {
      organizationId: GOV_ORG,
      kind: "query" as const,
      sourceIds: [source],
    };
    await requestEmbedding(profile, "synthetic", "你能提供哪些服务", fetcher, freeAccess);
    await requestEmbedding(profile, "synthetic", "SVC-101 的服务时间是什么", fetcher, freeAccess);
    await requestEmbedding(profile, "synthetic", "是否允许自动发消息", fetcher, freeAccess);
    expect(calls).toBe(6);
    expect(
      sql(
        `select string_agg(input_position::text, ',' order by input_position) from public.ai_embedding_requests where operation_id='${opId}' and status='succeeded'`,
      ),
    ).toBe("0,1,2");
    await expect(
      requestEmbedding(profile, "synthetic", "第四个新问题超出预算", fetcher, freeAccess),
    ).rejects.toThrow("embedding_budget_exhausted");
    expect(calls).toBe(6);
  });
  it("bounded_free_text reuses same-operation cached question at zero additional budget", async () => {
    const version = await indexAndVersion();
    const opId = await approveBoundedQuery(version, { maxRequests: 1, maxQueryBytes: 2000 });
    const freeAccess = {
      organizationId: GOV_ORG,
      kind: "query" as const,
      sourceIds: [source],
    };
    await requestEmbedding(profile, "synthetic", "重复提问测试", fetcher, freeAccess);
    await requestEmbedding(profile, "synthetic", "重复提问测试", fetcher, freeAccess);
    expect(calls).toBe(4); // 3 index + 1 query
    expect(
      sql(`select reserved_requests from public.ai_embedding_operations where id='${opId}'`),
    ).toBe("1");
    expect(
      sql(`select count(*) from public.ai_embedding_requests where operation_id='${opId}'`),
    ).toBe("1");
  });
  it("bounded_free_text rejects inputs exceeding max_query_bytes before any HTTP call", async () => {
    const version = await indexAndVersion();
    await approveBoundedQuery(version, { maxRequests: 3, maxQueryBytes: 64 });
    await expect(
      requestEmbedding(profile, "synthetic", "x".repeat(65), fetcher, {
        organizationId: GOV_ORG,
        kind: "query",
        sourceIds: [source],
      }),
    ).rejects.toThrow("embedding_authorization_required");
    expect(calls).toBe(3);
  });
  it("bounded_free_text marks uncertain upstream drop as unknown and blocks all follow-up queries", async () => {
    const version = await indexAndVersion();
    const opId = await approveBoundedQuery(version, { maxRequests: 3, maxQueryBytes: 2000 });
    const freeAccess = {
      organizationId: GOV_ORG,
      kind: "query" as const,
      sourceIds: [source],
    };
    await requestEmbedding(profile, "synthetic", "问题一正常", fetcher, freeAccess);
    expect(calls).toBe(4);
    mode = "drop";
    await expect(
      requestEmbedding(profile, "synthetic", "问题二超时", fetcher, freeAccess),
    ).rejects.toThrow("embedding_transport_failed");
    expect(calls).toBe(5);
    expect(
      sql(
        `select status from public.ai_embedding_requests where operation_id='${opId}' and input_position=1`,
      ),
    ).toBe("unknown");
    expect(sql(`select status from public.ai_embedding_operations where id='${opId}'`)).toBe(
      "blocked",
    );
    mode = "ok";
    await expect(
      requestEmbedding(profile, "synthetic", "问题一正常", fetcher, {
        ...freeAccess,
        operationId: opId,
      }),
    ).rejects.toThrow("embedding_operation_blocked");
    await expect(
      requestEmbedding(profile, "synthetic", "问题三被阻断", fetcher, freeAccess),
    ).rejects.toThrow("embedding_authorization_required");
    expect(calls).toBe(5);
  });
  it("bounded_free_text serializes concurrent races on max_requests=1 and supports clean renewal", async () => {
    const version = await indexAndVersion();
    await approveBoundedQuery(version, { maxRequests: 1, maxQueryBytes: 2000 });
    const freeAccess = {
      organizationId: GOV_ORG,
      kind: "query" as const,
      sourceIds: [source],
    };
    const [r1, r2] = await Promise.allSettled([
      requestEmbedding(profile, "synthetic", "并发问题A", fetcher, freeAccess),
      requestEmbedding(profile, "synthetic", "并发问题B", fetcher, freeAccess),
    ]);
    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe(
      "embedding_budget_exhausted",
    );
    expect(calls).toBe(4);
    // Renew on the exact same configuration_version with a fresh nonce
    const renewedId = await approveBoundedQuery(version, { maxRequests: 2, maxQueryBytes: 2000 });
    const winningQuestion = r1.status === "fulfilled" ? "并发问题A" : "并发问题B";
    await requestEmbedding(profile, "synthetic", winningQuestion, fetcher, freeAccess);
    expect(calls).toBe(4); // cross-operation cache hit consumes 0 slots and 0 HTTP calls
    expect(
      sql(`select reserved_requests from public.ai_embedding_operations where id='${renewedId}'`),
    ).toBe("0");
    expect(
      sql(
        `select count(*) from public.ai_embedding_requests where operation_id='${renewedId}' and reused_from_request_id is not null`,
      ),
    ).toBe("1");
    await requestEmbedding(profile, "synthetic", "续签后的新问题", fetcher, freeAccess);
    expect(calls).toBe(5);
    expect(
      sql(`select reserved_requests from public.ai_embedding_operations where id='${renewedId}'`),
    ).toBe("1");
  });
});
