import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { integrationBindings, enabledIntegration } from "./config";
import {
  beginLangfuseCall,
  exportLangfuseEvent,
  projectLangfuseEvaluation,
  langfuseTraceId,
} from "./langfuse";
import { syncCustomerMemory, readConfirmedCustomerMemory, customerMemoryInput } from "./mem0";
import { searchCompanyWiki, readCompanyWikiEvidence } from "./weknora";
import type { EventRow } from "@/lib/event-log/dispatcher";
import type { AgentEvalReport } from "@/lib/ai/evals/contracts";

const org = "a0000000-0000-4000-8000-000000000001";
const other = "b0000000-0000-4000-8000-000000000001";
const run = "a0000000-0000-4000-8000-000000000002";
const child = "a0000000-0000-4000-8000-000000000003";
const contact = "a0000000-0000-4000-8000-000000000004";
const memoryId = "a0000000-0000-4000-8000-000000000005";
const sourceId = "a0000000-0000-4000-8000-000000000006";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const j = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function bindings() {
  vi.stubEnv(
    "AI_INTEGRATION_BINDINGS",
    JSON.stringify([
      {
        organization_id: org,
        provider: "langfuse",
        base_url: "https://trace.test",
        public_key: "public-synthetic",
        secret_key: "secret-synthetic",
      },
      {
        organization_id: org,
        provider: "mem0",
        base_url: "https://memory.test",
        api_key: "synthetic",
      },
      {
        organization_id: org,
        provider: "weknora",
        base_url: "https://wiki.test",
        api_key: "synthetic",
        knowledge_base_ids: ["kb-a"],
        visibility: "organization",
      },
    ]),
  );
}
function sqlPool(handler: (sql: string, values: unknown[]) => unknown) {
  const query = vi.fn(
    async (query: string | { text: string; values: unknown[] }, values?: unknown[]) =>
      handler(
        typeof query === "string" ? query : query.text,
        (typeof query === "string" ? values : query.values) ?? [],
      ),
  );
  return { pool: { query } as unknown as Pool, query };
}
const event = (payload: unknown): EventRow => ({
  id: memoryId,
  organization_id: org,
  event_type: "ai_integration.langfuse_export",
  entity_kind: "ai_workbench_run",
  entity_id: run,
  payload: payload as Record<string, unknown>,
  metadata: {},
  consumed_by: [],
  attempts: 0,
});
beforeEach(bindings);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("optional integration configuration", () => {
  it("is off without trusted config and never queries or fetches", async () => {
    vi.stubEnv("AI_INTEGRATION_BINDINGS", "");
    const { pool, query } = sqlPool(() => {
      throw new Error("must not query");
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await enabledIntegration(pool, org, "mem0")).toBeNull();
    expect(await beginLangfuseCall(pool, org, run)).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("denies unbound tenants, malformed config and shared Langfuse project", async () => {
    expect(integrationBindings().length).toBe(3);
    const { pool, query } = sqlPool(() => ({ rows: [{ enabled: true }] }));
    expect(await enabledIntegration(pool, other, "langfuse")).toBeNull();
    expect(query).not.toHaveBeenCalled();
    const configs = integrationBindings();
    vi.stubEnv(
      "AI_INTEGRATION_BINDINGS",
      JSON.stringify([...configs, { ...configs[0], organization_id: other }]),
    );
    expect(integrationBindings()).toEqual([]);
    vi.stubEnv("AI_INTEGRATION_BINDINGS", '{"secret":"never-echo"}');
    expect(integrationBindings()).toEqual([]);
  });
});

describe("real boundary Langfuse projection", () => {
  it("links concurrent child and root calls with distinct attempts, strips raw canaries and durably enqueues", async () => {
    const writes: unknown[][] = [];
    const { pool } = sqlPool((sql, values) => {
      if (sql.includes("ai_integration_settings")) return { rows: [{ enabled: true }] };
      if (sql.includes("select parent_run_id"))
        return { rows: [{ parent_run_id: values[1] === child ? run : null }] };
      if (sql.includes("insert into event_log")) writes.push(values);
      return { rows: [] };
    });
    const root = await beginLangfuseCall(pool, org, run);
    const specialist = await beginLangfuseCall(pool, org, child);
    root!.onObservation({
      id: "model-a",
      kind: "generation",
      name: "model",
      startedAt: 1000,
      endedAt: 1200,
      status: "ok",
      model: "safe-model",
      provider: "openai",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
      },
      ...{
        input: "pii@example.test",
        output: "private response",
        apiKey: "CANARY_SECRET",
        privateContinuation: "hidden reasoning",
      },
    });
    specialist!.onObservation({
      id: "tool-a",
      kind: "tool",
      name: "crm_get_lead",
      startedAt: 1000,
      endedAt: 1150,
      status: "ok",
    });
    await Promise.all([root!.finish("ok"), specialist!.finish("ok")]);
    const payloads = writes.map((write) => JSON.parse(write[3] as string));
    expect(
      payloads.every((p) =>
        p.spans.every((span: { traceId: string }) => span.traceId === langfuseTraceId(org, run)),
      ),
    ).toBe(true);
    expect(payloads[0].spans.at(-1).spanId).not.toBe(payloads[1].spans.at(-1).spanId);
    expect(payloads[0].spans[0].parentSpanId).toBe(payloads[0].spans.at(-1).spanId);
    expect(JSON.stringify(payloads)).not.toMatch(/CANARY|pii@|private response|hidden reasoning/);
    const http = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano).toBe("1000000000");
      return j({});
    });
    await exportLangfuseEvent(event(payloads[0]), pool, http as unknown as typeof fetch);
    expect(String(http.mock.calls[0]![0])).toBe("https://trace.test/api/public/otel/v1/traces");
    expect(http.mock.calls[0]![1].headers["x-langfuse-ingestion-version"]).toBe("4");
  });
  it("keeps stable score envelope IDs and timestamps across a midnight retry; rejects partial 207", async () => {
    let payload: unknown;
    const { pool } = sqlPool((sql, values) => {
      if (sql.includes("ai_integration_settings")) return { rows: [{ enabled: true }] };
      if (sql.includes("select parent_run_id")) return { rows: [{ parent_run_id: null }] };
      if (sql.includes("insert into event_log")) payload = JSON.parse(values[3] as string);
      return { rows: [] };
    });
    const report = {
      runId: run,
      profileRevision: 3,
      score: 88,
      dimensions: [{ key: "task_completion", score: 80 }],
      semanticJudge: { status: "completed", rubricRevision: 2, score: 90 },
    } as AgentEvalReport;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T23:59:59Z"));
    await projectLangfuseEvaluation(pool, org, report, "a".repeat(64));
    const bodies: unknown[] = [];
    const http = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return j(
        { successes: body.batch.map((item: { id: string }) => ({ id: item.id })), errors: [] },
        207,
      );
    });
    await exportLangfuseEvent(event(payload), pool, http as unknown as typeof fetch);
    vi.setSystemTime(new Date("2026-10-02T00:00:01Z"));
    await exportLangfuseEvent(event(payload), pool, http as unknown as typeof fetch);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(JSON.stringify(bodies[0])).toContain("2026-10-01T23:59:59.000Z");
    expect(String(http.mock.calls[0]![0])).toContain("/api/public/ingestion");
    await expect(
      exportLangfuseEvent(
        event(payload),
        pool,
        vi.fn(async () => j({ successes: [], errors: [{ message: "invalid" }] }, 207)),
      ),
    ).rejects.toThrow("receipt_incomplete");
  });
  it("rechecks activation before delivery and fails closed on arbitrary payload", async () => {
    const { pool } = sqlPool(() => ({ rows: [{ enabled: false }] }));
    const http = vi.fn();
    expect(await exportLangfuseEvent(event({ raw: "PII" }), pool, http)).toBe("disabled");
    expect(http).not.toHaveBeenCalled();
    const enabled = sqlPool(() => ({ rows: [{ enabled: true }] })).pool;
    await expect(exportLangfuseEvent(event({ raw: "PII" }), enabled, http)).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
  });
});

function memoryFixture() {
  const row = {
    id: memoryId,
    organization_id: org,
    contact_id: contact,
    subject_key: sha(`crm-customer:v1:${org}:${contact}`),
    category: "preference",
    body: "Prefers email follow-up",
    content_hash: "b".repeat(64),
    sync_state: "pending",
    external_id: null as string | null,
    write_outcome: "never_started",
    deleted_at: null as string | null,
    remote_deleted_at: null as string | null,
    created_at: "2026-10-01T12:34:56.789Z",
    updated_at: "2026-10-02T12:34:56.789Z",
  };
  let available = true;
  const { pool, query } = sqlPool((sql, values) => {
    if (sql.includes("ai_integration_settings")) return { rows: [{ enabled: true }] };
    if (values[0] !== org) return { rows: [] };
    if (sql.includes("select id from contacts"))
      return { rows: available ? [{ id: contact }] : [] };
    if (sql.includes("select * from ai_customer_memories"))
      return { rows: row.deleted_at && sql.includes("deleted_at is null") ? [] : [{ ...row }] };
    if (sql.includes("sync_state='sending'")) {
      if (row.sync_state !== "pending" || row.deleted_at) return { rows: [] };
      row.sync_state = "sending";
      row.write_outcome = "in_flight";
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes("write_outcome='unknown'")) {
      row.write_outcome = "unknown";
      row.sync_state = row.deleted_at ? "deleted" : "reconcile";
    } else if (sql.includes("write_outcome='confirmed'")) {
      row.write_outcome = "confirmed";
      row.external_id = values[2] as string;
      row.sync_state = row.deleted_at ? "deleted" : "synced";
    } else if (sql.includes("set external_id")) {
      row.external_id = values[2] as string;
      row.sync_state = "synced";
    } else if (sql.includes("sync_state='reconcile'")) row.sync_state = "reconcile";
    if (sql.includes("set remote_deleted_at")) row.remote_deleted_at = "2026-10-02T00:00:00Z";
    return { rows: [] };
  });
  const remote = () => ({
    id: "remote-1",
    user_id: row.subject_key,
    run_id: sha(`crm-memory:v1:${org}:${memoryId}`),
    memory: "REMOTE IS NOT AUTHORITATIVE",
    metadata: {
      crm_id: sha(`crm-memory:v1:${org}:${memoryId}`),
      crm_hash: row.content_hash,
      crm_category: row.category,
    },
  });
  return {
    row,
    pool,
    query,
    remote,
    unavailable: () => {
      available = false;
    },
  };
}

describe("Mem0 controlled real service paths", () => {
  it("reads canonical confirmed facts without a vendor binding or network request", async () => {
    vi.stubEnv("AI_INTEGRATION_BINDINGS", "");
    const f = memoryFixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await readConfirmedCustomerMemory(f.pool, org, contact);
    expect(result).toMatchObject({
      status: "local",
      coverage: "complete",
      providerStatus: "disabled",
    });
    expect(result).toMatchObject({ source: "crm_confirmed_facts", schemaVersion: 1 });
    expect(result.memories).toEqual([
      expect.objectContaining({
        id: memoryId,
        body: f.row.body,
        confirmed: true,
        revision: f.row.content_hash,
        authority: "customer_context_only",
        created_at: f.row.created_at,
        updated_at: f.row.updated_at,
      }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(readConfirmedCustomerMemory(f.pool, other, contact)).rejects.toThrow(
      "contact_unavailable",
    );
    f.row.deleted_at = "2026-10-03T00:00:00Z";
    expect((await readConfirmedCustomerMemory(f.pool, org, contact)).memories).toEqual([]);
    f.unavailable();
    await expect(readConfirmedCustomerMemory(f.pool, org, contact)).rejects.toThrow(
      "contact_unavailable",
    );
  });
  it("writes infer:false once, verifies ownership and replays without duplicate creation", async () => {
    const f = memoryFixture();
    let records: unknown[] = [];
    const posts: unknown[] = [];
    const http = vi.fn(async (url, init) => {
      if (String(url).endsWith("/openapi.json"))
        return j({
          components: {
            schemas: {
              MemoryCreate: { properties: { infer: {} } },
              SearchRequest: { properties: { filters: {} } },
            },
          },
        });
      if (init.method === "POST") {
        posts.push(JSON.parse(init.body));
        records = [f.remote()];
        return j({ results: [{ id: "remote-1" }] });
      }
      return j({ results: records });
    });
    expect(await syncCustomerMemory(f.pool, org, memoryId, http as unknown as typeof fetch)).toBe(
      "synced",
    );
    expect(await syncCustomerMemory(f.pool, org, memoryId, http as unknown as typeof fetch)).toBe(
      "synced",
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      infer: false,
      messages: [{ content: f.row.body }],
      user_id: f.row.subject_key,
    });
    expect(
      customerMemoryInput.safeParse({
        contact_id: contact,
        request_key: memoryId,
        category: "product_policy",
        body: "price",
        confirmed: true,
      }).success,
    ).toBe(false);
  });
  it("does not retry an unknown ADD even if a subsequent search is empty", async () => {
    const f = memoryFixture();
    let posts = 0;
    const http = vi.fn(async (url, init) => {
      if (String(url).endsWith("/openapi.json"))
        return j({
          components: {
            schemas: {
              MemoryCreate: { properties: { infer: {} } },
              SearchRequest: { properties: { filters: {} } },
            },
          },
        });
      if (init.method === "POST") {
        posts++;
        throw new Error("socket disappeared after commit");
      }
      return j({ results: [] });
    });
    await expect(
      syncCustomerMemory(f.pool, org, memoryId, http as unknown as typeof fetch),
    ).rejects.toThrow("outcome_unknown");
    expect(await syncCustomerMemory(f.pool, org, memoryId, http as unknown as typeof fetch)).toBe(
      "reconciliation_required",
    );
    expect(posts).toBe(1);
    f.row.deleted_at = "2026-10-02T00:00:00Z";
    f.row.sync_state = "deleted";
    expect(await syncCustomerMemory(f.pool, org, memoryId, http as unknown as typeof fetch)).toBe(
      "reconciliation_required",
    );
    expect(f.row.remote_deleted_at).toBeNull();
  });
  it("does not confirm cleanup while an earlier ADD is still in flight", async () => {
    const f = memoryFixture();
    let records: unknown[] = [];
    let posts = 0;
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const http = vi.fn(async (url, init) => {
      if (String(url).endsWith("/openapi.json"))
        return j({
          components: {
            schemas: {
              MemoryCreate: { properties: { infer: {} } },
              SearchRequest: { properties: { filters: {} } },
            },
          },
        });
      if (init.method === "POST") {
        posts++;
        started();
        await pending;
        records = [f.remote()];
        return j({ results: [{ id: "remote-1" }] });
      }
      if (init.method === "DELETE") {
        records = [];
        return j({ message: "deleted" });
      }
      return j({ results: records });
    });
    const add = syncCustomerMemory(f.pool, org, memoryId, http as unknown as typeof fetch);
    await entered;
    f.row.deleted_at = "2026-10-02T00:00:00Z";
    f.row.sync_state = "deleted";
    expect(await syncCustomerMemory(f.pool, org, memoryId, http as unknown as typeof fetch)).toBe(
      "reconciliation_required",
    );
    expect(f.row.remote_deleted_at).toBeNull();
    release();
    await add;
    expect(f.row.sync_state).toBe("deleted");
    expect(await syncCustomerMemory(f.pool, org, memoryId, http as unknown as typeof fetch)).toBe(
      "deleted",
    );
    expect(f.row.remote_deleted_at).not.toBeNull();
    expect(posts).toBe(1);
  });
  it("refuses older REST schemas, cross-tenant memory and contact revocation", async () => {
    const f = memoryFixture();
    const http = vi.fn(async (url) =>
      String(url).endsWith("/openapi.json") ? j({ components: {} }) : j({ results: [] }),
    );
    await expect(syncCustomerMemory(f.pool, org, memoryId, http)).rejects.toThrow(
      "protocol_unsupported",
    );
    expect(f.row.sync_state).toBe("pending");
    expect(await syncCustomerMemory(f.pool, other, memoryId, http)).toBe("disabled");
    f.unavailable();
    await expect(syncCustomerMemory(f.pool, org, memoryId, http)).rejects.toThrow(
      "contact_unavailable",
    );
  });
  it("remote content cannot overwrite a confirmed local fact, and deletion blocks read", async () => {
    const f = memoryFixture();
    f.row.external_id = "remote-1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        j({ results: [f.remote(), { ...f.remote(), id: "evil", user_id: "other" }] }),
      ),
    );
    const result = await readConfirmedCustomerMemory(f.pool, org, contact);
    expect(result.memories[0]?.body).toBe("Prefers email follow-up");
    expect(JSON.stringify(result)).not.toContain("REMOTE IS NOT AUTHORITATIVE");
    f.row.deleted_at = "2026-10-02T00:00:00Z";
    expect((await readConfirmedCustomerMemory(f.pool, org, contact)).memories).toEqual([]);
  });
});

describe("WeKnora current-source Wiki evidence", () => {
  function fixture() {
    const page = {
      id: "page-a",
      knowledge_base_id: "kb-a",
      slug: "product/widget",
      title: "Widget",
      content: "Approved document says the widget weighs 2kg.",
      version: 3,
      status: "published",
      source_refs: ["doc-a|Manual"],
      chunk_refs: ["chunk-a"],
      updated_at: "2026-10-01T02:00:00Z",
      deleted_at: null,
    };
    const source = {
      id: sourceId,
      source_metadata: {
        provider: "weknora",
        knowledge_base_id: "kb-a",
        visibility: "organization",
      },
      updated_at: "2026-10-01T00:00:00Z",
    };
    const doc = {
      id: "doc-a",
      knowledge_base_id: "kb-a",
      title: "Manual",
      updated_at: "2026-10-01T01:00:00Z",
      file_hash: "doc-content-hash",
      parse_status: "completed",
      enable_status: "enabled",
      deleted_at: null,
    };
    let active = true;
    const manifests: unknown[] = [];
    const { pool, query } = sqlPool((sql, values) => {
      if (sql.includes("ai_integration_settings")) return { rows: [{ enabled: true }] };
      if (sql.includes("select id,source_metadata"))
        return { rows: active && (values[1] as string[]).includes(sourceId) ? [source] : [] };
      if (sql.includes("insert into ai_wiki_evidence")) {
        manifests.push(JSON.parse(values[3] as string));
        return { rows: [{ id: memoryId }] };
      }
      return { rows: [] };
    });
    const http = vi.fn(async (url) =>
      String(url).includes("/search?")
        ? j({ pages: [{ slug: page.slug }] })
        : String(url).includes("/wiki/pages/")
          ? j(page)
          : j({ data: doc }),
    );
    return {
      pool,
      query,
      http,
      page,
      doc,
      manifests,
      revoke: () => {
        active = false;
      },
    };
  }
  it("calls actual search/read contracts and persists immutable source/version manifest", async () => {
    const f = fixture();
    const result = await searchCompanyWiki(f.pool, org, [sourceId], "widget", 3, undefined, f.http);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.locator.provider).toBe("weknora");
    expect(f.manifests[0]).toMatchObject({
      page_version: 3,
      content_hash: sha(f.page.content),
      sources: [{ id: "doc-a", file_hash: "doc-content-hash" }],
    });
    expect(
      f.http.mock.calls.every(([url]) => String(url).startsWith("https://wiki.test/api/v1/")),
    ).toBe(true);
    expect(
      f.query.mock.calls.some(
        ([query]) =>
          typeof query !== "string" &&
          query.text.includes("on conflict") &&
          query.text.includes("do nothing"),
      ),
    ).toBe(true);
  });
  it("hides a previously captured receipt after page correction or deletion", async () => {
    const f = fixture();
    await searchCompanyWiki(f.pool, org, [sourceId], "widget", 3, undefined, f.http);
    const prior = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (query, values) => {
      const sql = typeof query === "string" ? query : query.text;
      if (sql.includes("select source_id,manifest,content"))
        return {
          rows: [{ source_id: sourceId, manifest: f.manifests[0], content: f.page.content }],
        };
      return prior(query, values);
    });
    vi.stubGlobal("fetch", f.http);
    expect(await readCompanyWikiEvidence(f.pool, org, memoryId)).not.toBeNull();
    f.page.version += 1;
    expect(await readCompanyWikiEvidence(f.pool, org, memoryId)).toBeNull();
    f.page.version -= 1;
    f.page.status = "archived";
    await expect(readCompanyWikiEvidence(f.pool, org, memoryId)).rejects.toThrow();
  });
  it("never queries unselected KBs and refuses foreign, withdrawn, stale or mixed-source pages", async () => {
    const f = fixture();
    expect(
      (await searchCompanyWiki(f.pool, org, [], "widget", 3, undefined, f.http)).evidence,
    ).toEqual([]);
    expect(f.http).not.toHaveBeenCalled();
    f.doc.knowledge_base_id = "foreign-kb";
    expect(
      (await searchCompanyWiki(f.pool, org, [sourceId], "widget", 3, undefined, f.http)).evidence,
    ).toEqual([]);
    f.doc.knowledge_base_id = "kb-a";
    f.doc.updated_at = "2026-10-02T01:00:00Z";
    expect(
      (await searchCompanyWiki(f.pool, org, [sourceId], "widget", 3, undefined, f.http)).evidence,
    ).toEqual([]);
    f.doc.updated_at = "2026-10-01T01:00:00Z";
    f.page.source_refs = [];
    expect(
      (await searchCompanyWiki(f.pool, org, [sourceId], "widget", 3, undefined, f.http)).evidence,
    ).toEqual([]);
    f.page.source_refs = ["doc-a|Manual"];
    f.revoke();
    expect(
      (await searchCompanyWiki(f.pool, org, [sourceId], "widget", 3, undefined, f.http)).evidence,
    ).toEqual([]);
  });
});

it("sends valid OTLP over a real local HTTP receiver without contacting vendors", async () => {
  const { createServer } = await import("node:http");
  const received: { path?: string; authorization?: string; payload?: unknown } = {};
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      received.path = request.url;
      received.authorization = request.headers.authorization;
      received.payload = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    vi.stubEnv(
      "AI_INTEGRATION_BINDINGS",
      JSON.stringify([
        {
          organization_id: org,
          provider: "langfuse",
          base_url: `http://127.0.0.1:${port}`,
          public_key: "local",
          secret_key: "synthetic",
        },
      ]),
    );
    let payload: unknown;
    const { pool } = sqlPool((sql, values) => {
      if (sql.includes("ai_integration_settings")) return { rows: [{ enabled: true }] };
      if (sql.includes("select parent_run_id")) return { rows: [{ parent_run_id: null }] };
      if (sql.includes("insert into event_log")) payload = JSON.parse(values[3] as string);
      return { rows: [] };
    });
    const trace = await beginLangfuseCall(pool, org, run);
    trace!.onObservation({
      id: "local-model",
      kind: "generation",
      name: "model",
      startedAt: 1000,
      endedAt: 1010,
      status: "ok",
    });
    await trace!.finish("ok");
    expect(await exportLangfuseEvent(event(payload), pool)).toBe("delivered");
    expect(received.path).toBe("/api/public/otel/v1/traces");
    expect(received.authorization).toBe(
      `Basic ${Buffer.from("local:synthetic").toString("base64")}`,
    );
    expect(received.payload).toHaveProperty("resourceSpans");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
