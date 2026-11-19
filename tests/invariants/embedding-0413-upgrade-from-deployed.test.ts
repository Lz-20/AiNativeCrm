/** Actual expand migration from the exact ea26ee4 baseline; no deployed access. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
const container = process.env.TEST_DB_CONTAINER;
if (!container?.startsWith("pi-native-test-db-")) throw new Error("isolated_harness_required");
const database = "rag_operations_upgrade_fixture";
function query(body: string, db = database) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container!,
      "psql",
      "-U",
      "postgres",
      "-d",
      db,
      "-qtA",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    { input: body, encoding: "utf8" },
  ).trim();
}
describe("0413 additive upgrade from the deployed 0412 schema", () => {
  it("preserves legacy vectors, 1024/1536 indexes and dead/pending event history on repeated SQL", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8"),
      marker = "\n-- 0413: durable RAG operation admission, reservations and fencing.\n";
    const pos = baseline.indexOf(marker);
    expect(pos).toBeGreaterThan(0);
    const old = baseline.slice(0, pos);
    expect(createHash("sha256").update(old).digest("hex")).toBe(
      "cbb07783b87ad3b284134bf19421784bc6d2f7f8f48876dde88bdad3452a08d7",
    );
    const harness = readFileSync("scripts/test-db.sh", "utf8");
    const part = harness.slice(harness.indexOf('echo "==> prelude:'));
    const prelude = part.match(/psql_install <<'SQL'\n([\s\S]*?)\nSQL\n/)?.[1];
    expect(prelude).toContain("create extension if not exists vector");
    query(`create database ${database};`, "template1");
    try {
      query(prelude!);
      query(old);
      const org = "e4131111-0000-4000-8000-000000000001",
        source = "e4131111-0000-4000-8000-000000000002",
        version = "e4131111-0000-4000-8000-000000000003";
      query(`insert into public.organizations(id,slug,legal_name,display_name) values('${org}','rag-upgrade','Synthetic','Synthetic');
        insert into public.ai_knowledge_sources(id,organization_id,source_type,name,status,is_active) values('${source}','${org}','documento','Synthetic legacy','ready',true);
        insert into public.ai_knowledge_versions(id,organization_id,knowledge_source_id,version_number,status,is_active,embedding_model,embedding_dims) values('${version}','${org}','${source}',1,'ready',true,'openai/text-embedding-3-small',1536);
        insert into public.ai_chunks(organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding) values('${org}','${source}','${version}',0,'synthetic old vector','synthetic',5,array_fill(0.1::real,array[1536])::vector);
        insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload,status,attempts) values('${org}','knowledge_source.updated','ai_knowledge_source','${source}','{"knowledge_source_id":"${source}"}','dead',5),('${org}','knowledge_source.updated','ai_knowledge_source','${source}','{"knowledge_source_id":"${source}"}','pending',4);`);
      const snapshot = () =>
        query(
          `select md5((select jsonb_agg(to_jsonb(e) order by id)::text from public.event_log e where organization_id='${org}') || (select jsonb_agg(to_jsonb(c) order by id)::text from public.ai_chunks c where organization_id='${org}'))`,
        );
      const before = snapshot();
      const indexes = query(
        "select jsonb_agg(jsonb_build_array(indexname,indexname::regclass::oid) order by indexname) from pg_indexes where schemaname='public' and indexname in ('ai_chunks_embedding_ivfflat_idx','embedding_chunks_1024_cosine','embedding_chunks_1536_cosine')",
      );
      const migration = readFileSync(
        "supabase/migrations/20261119080000_0413_rag_operacoes_controladas.sql",
        "utf8",
      );
      query(migration);
      query(migration);
      expect(snapshot()).toBe(before);
      expect(query("select count(*) from public.ai_embedding_operations")).toBe("0");
      expect(query("select count(*) from public.ai_embedding_price_reviews")).toBe("0");
      expect(
        query(
          "select jsonb_agg(jsonb_build_array(indexname,indexname::regclass::oid) order by indexname) from pg_indexes where schemaname='public' and indexname in ('ai_chunks_embedding_ivfflat_idx','embedding_chunks_1024_cosine','embedding_chunks_1536_cosine')",
        ),
      ).toBe(indexes);
      query(baseline);
      expect(snapshot()).toBe(before);
    } finally {
      query(`drop database ${database} with (force);`, "template1");
    }
  }, 120000);
});
