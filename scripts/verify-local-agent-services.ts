/** Opt-in probes against real local services, only the synthetic pi-native-demo org. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { integrationBinding } from "@/lib/ai/integrations/config";
import { readConfirmedCustomerMemory, syncCustomerMemory } from "@/lib/ai/integrations/mem0";
import { searchCompanyWiki } from "@/lib/ai/integrations/weknora";
import { langfuseTraceId } from "@/lib/ai/integrations/langfuse";

const organizationId = "3ea5dbc2-050b-4324-a489-8a17c2b654c3";
const contactId = "6842302c-a864-4a4e-8dc5-a605f6c10827";
async function main() {
  const url = new URL(process.env.SUPABASE_DB_URL ?? "");
  assert(["localhost", "127.0.0.1"].includes(url.hostname), "local_db_required");
  const pool = new pg.Pool({ connectionString: url.href, max: 2 });
  const action = process.argv[2];
  try {
    assert.equal(
      (await pool.query("select slug from organizations where id=$1", [organizationId])).rows[0]
        ?.slug,
      "pi-native-demo",
    );
    let result: Record<string, unknown>;
    if (action === "mem0") {
      const memoryId = process.argv[3];
      assert.match(memoryId, /^[a-f0-9-]{36}$/);
      const binding = integrationBinding(organizationId, "mem0");
      assert(binding && binding.base_url === "http://127.0.0.1:8888", "local_mem0_required");
      const row = (
        await pool.query(
          "select contact_id,body,subject_key from ai_customer_memories where organization_id=$1 and id=$2 and deleted_at is null",
          [organizationId, memoryId],
        )
      ).rows[0];
      assert(
        row && row.contact_id === contactId && row.body.startsWith("[演示合成事实]"),
        "synthetic_memory_required",
      );
      const denied = await fetch(`${binding.base_url}/memories?user_id=unauthorized-probe`);
      assert.equal(denied.status, 401);
      const sync = await syncCustomerMemory(pool, organizationId, memoryId);
      const saved = (
        await pool.query(
          "select external_id,sync_state from ai_customer_memories where organization_id=$1 and id=$2",
          [organizationId, memoryId],
        )
      ).rows[0];
      assert.equal(saved.sync_state, "synced");
      assert(saved.external_id);
      const search = await fetch(`${binding.base_url}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": binding.api_key! },
        body: JSON.stringify({
          query: "客户偏好下午三点沟通",
          filters: { user_id: row.subject_key },
          top_k: 10,
        }),
      });
      assert(search.ok, "real_mem0_search_failed");
      const remote = (await search.json()) as { results: { id: string }[] };
      assert(
        remote.results.some((r) => r.id === saved.external_id),
        "remote_memory_not_retrieved",
      );
      const crm = await readConfirmedCustomerMemory(
        pool,
        organizationId,
        contactId,
        "客户偏好下午三点沟通",
      );
      assert.equal(crm.providerStatus, "connected");
      assert(crm.memories.some((m) => m.id === memoryId));
      result = {
        synthetic: true,
        memoryId,
        sync,
        remoteSearchMatched: true,
        crmProviderStatus: crm.providerStatus,
        crmMemoryCount: crm.returnedCount,
        unauthorizedStatus: denied.status,
      };
    } else if (action === "mem0-delete") {
      const id = process.argv[3];
      assert.match(id, /^[a-f0-9-]{36}$/);
      const row = (
        await pool.query(
          "select deleted_at from ai_customer_memories where organization_id=$1 and id=$2",
          [organizationId, id],
        )
      ).rows[0];
      assert(row?.deleted_at, "retire_via_crm_api_first");
      assert.equal(await syncCustomerMemory(pool, organizationId, id), "deleted");
      const receipt = (
        await pool.query(
          "select remote_deleted_at from ai_customer_memories where organization_id=$1 and id=$2",
          [organizationId, id],
        )
      ).rows[0];
      assert(receipt.remote_deleted_at);
      result = { memoryId: id, remoteDeletionVerified: true };
    } else if (action === "langfuse-project" || action === "langfuse") {
      const binding = integrationBinding(organizationId, "langfuse");
      assert(binding && binding.base_url === "http://127.0.0.1:3006", "local_langfuse_required");
      const headers = {
        Authorization: `Basic ${Buffer.from(`${binding.public_key}:${binding.secret_key}`).toString("base64")}`,
      };
      if (action === "langfuse-project") {
        const response = await fetch(`${binding.base_url}/api/public/projects`, {
          headers,
          signal: AbortSignal.timeout(30000),
        });
        assert(response.ok, "langfuse_project_auth_failed");
        const projects = (await response.json()) as { data: { id: string }[] };
        assert(projects.data.some((p) => p.id === "crm-local-demo-project"));
        result = { projectId: "crm-local-demo-project", authenticated: true };
      } else {
        const runId = process.argv[3];
        assert.match(runId, /^[a-f0-9-]{36}$/);
        const owned = (
          await pool.query(
            "select status,created_at from ai_workbench_runs where organization_id=$1 and id=$2",
            [organizationId, runId],
          )
        ).rows[0];
        assert(owned, "owned_run_required");
        const traceId = langfuseTraceId(organizationId, runId);
        const from = new Date(new Date(owned.created_at).getTime() - 60000).toISOString();
        const to = new Date().toISOString();
        const query = new URLSearchParams({
          traceId,
          fromStartTime: from,
          toStartTime: to,
          fields: "core,basic,io",
          limit: "100",
        });
        const response = await fetch(`${binding.base_url}/api/public/v2/observations?${query}`, {
          headers,
          signal: AbortSignal.timeout(30000),
        });
        assert(response.ok, "langfuse_persisted_trace_required");
        const observations = (await response.json()) as {
          data: {
            id: string;
            traceId: string;
            type: string;
            name: string;
            input?: unknown;
            output?: unknown;
          }[];
          meta: { cursor?: string };
        };
        assert(!observations.meta.cursor, "bounded_trace_probe_requires_complete_page");
        assert(
          observations.data.length > 0 && observations.data.every((o) => o.traceId === traceId),
        );
        assert(
          observations.data.every((o) => o.input == null && o.output == null),
          "private_content_must_not_be_exported",
        );
        const scoreQuery = new URLSearchParams({
          traceId,
          fields: "subject",
          fromTimestamp: from,
          toTimestamp: to,
          limit: "100",
        });
        const scoreResponse = await fetch(
          `${binding.base_url}/api/public/v3/scores?${scoreQuery}`,
          { headers, signal: AbortSignal.timeout(30000) },
        );
        assert(scoreResponse.ok, "langfuse_persisted_scores_required");
        const scores = (await scoreResponse.json()) as {
          data: {
            name: string;
            value: number;
            subject: { traceId?: string; kind: string; id: string };
          }[];
          meta: { cursor?: string };
        };
        assert(
          !scores.meta.cursor &&
            scores.data.every(
              (s) =>
                s.subject.traceId === traceId ||
                (s.subject.kind === "trace" && s.subject.id === traceId),
            ),
          "scores_must_belong_to_verified_trace",
        );
        assert(
          observations.data.some((o) => o.name === "crm.model"),
          "real_model_observation_required",
        );
        assert(
          observations.data.some((o) => o.name === "crm.tool"),
          "real_tool_observation_required",
        );
        assert(
          scores.data.some((s) => s.name === "crm.overall"),
          "real_eval_score_required",
        );
        result = {
          runId,
          traceId,
          runStatus: owned.status,
          observationCount: observations.data.length,
          modelObservationCount: observations.data.filter((o) => o.name === "crm.model").length,
          toolObservationCount: observations.data.filter((o) => o.name === "crm.tool").length,
          scores: scores.data.map((s) => ({ name: s.name, value: s.value })),
          privateContentAbsent: true,
          persisted: true,
        };
      }
    } else if (action === "wiki") {
      const sourceId = process.argv[3];
      assert.match(sourceId, /^[a-f0-9-]{36}$/);
      const found = await searchCompanyWiki(pool, organizationId, [sourceId], "产品", 5);
      assert(found.evidence.length > 0, "live_wiki_evidence_required");
      result = {
        synthetic: true,
        sourceId,
        status: found.status,
        evidenceCount: found.evidence.length,
        evidenceIds: found.evidence.map((e) => e.id),
        contentHashes: found.evidence.map((e) =>
          createHash("sha256").update(e.excerpt).digest("hex"),
        ),
      };
    } else throw new Error("unsupported_probe");
    const path = resolve("infra/local-agent-services/.env.verification.generated");
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    writeFileSync(
      path,
      JSON.stringify(
        { ...previous, [action!]: { verifiedAt: new Date().toISOString(), ...result } },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.info(JSON.stringify({ action, ...result }));
  } finally {
    await pool.end();
  }
}
void main().catch((error) => {
  console.error({
    probeFailed: true,
    code: error instanceof assert.AssertionError ? error.message : "local_service_probe_failed",
  });
  process.exitCode = 1;
});
