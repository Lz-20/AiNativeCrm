/** Real PostgreSQL upgrade from the exact deployed c5919aa baseline, with data. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container?.startsWith("pi-native-test-db-")) throw new Error("isolated_harness_required");
const database = "embedding_upgrade_fixture";
function query(body: string, db = database) {
  return execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "postgres", "-d", db,
    "-qtA", "-v", "ON_ERROR_STOP=1", "-f", "-"], { input: body, encoding: "utf8" }).trim();
}
describe("0412 incremental upgrade of the deployed schema", () => {
  it("preserves old data/1536 index, applies migration twice, then reapplies full baseline", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const marker = "\n-- 0412: additive configurable embedding profiles and isolated vector spaces.\n";
    const start = baseline.indexOf(marker);
    expect(start).toBeGreaterThan(0);
    const old = baseline.slice(0, start);
    // This digest was measured from git show c5919aa:supabase/baseline.sql.
    expect(createHash("sha256").update(old).digest("hex")).toBe("8df6e32cdcdf3a0a1d1a9c95c9215b61d73a61e691b1b4b5ec985ec163e24b7b");
    const harness = readFileSync("scripts/test-db.sh", "utf8");
    const preludeSection = harness.slice(harness.indexOf('echo "==> prelude:'));
    const prelude = preludeSection.match(/psql_install <<'SQL'\n([\s\S]*?)\nSQL\n/)?.[1];
    expect(prelude).toContain("create extension if not exists vector");
    expect(prelude).toContain("auth.uid()");
    query(`create database ${database};`, "template1");
    try {
      query(prelude!); query(old);
      const org = "e4121111-0000-4000-8000-000000000001";
      const source = "e4121111-0000-4000-8000-000000000002";
      const version = "e4121111-0000-4000-8000-000000000003";
      query(`insert into public.organizations(id,slug,legal_name,display_name) values('${org}','embedding-upgrade','Synthetic','Synthetic');
        insert into public.ai_knowledge_sources(id,organization_id,source_type,name,status,is_active)
          values('${source}','${org}','documento','Legacy SVC-101','ready',true);
        insert into public.ai_knowledge_versions(id,organization_id,knowledge_source_id,version_number,status,is_active,total_chunks,embedding_model,embedding_dims)
          values('${version}','${org}','${source}',1,'ready',true,1,'openai/text-embedding-3-small',1536);
        insert into public.ai_chunks(organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding)
          values('${org}','${source}','${version}',0,'Legacy SVC-101','synthetic-hash',8,array_fill(0.1::real,array[1536])::vector);
        update public.ai_knowledge_sources set active_kb_version_id='${version}' where id='${source}';`);
      const snapshot = () => query(`select md5(string_agg(row_to_json(c)::text,'' order by id)) from public.ai_chunks c;`);
      const before = snapshot();
      const oldIndex = query("select 'public.ai_chunks_embedding_ivfflat_idx'::regclass::oid");
      const migration = readFileSync("supabase/migrations/20261118080000_0412_embedding_multiplos_provedores.sql", "utf8");
      query(migration); query(migration);
      expect(snapshot()).toBe(before);
      expect(query("select 'public.ai_chunks_embedding_ivfflat_idx'::regclass::oid")).toBe(oldIndex);
      expect(query(`select count(*) from public.retrieve_top_k_chunks('${org}','${version}',array_fill(0.1::real,array[1536])::vector,5,-1)`)).toBe("1");
      query(baseline);
      expect(snapshot()).toBe(before);
      expect(query("select count(*) from pg_indexes where schemaname='public' and indexname in ('embedding_chunks_1024_cosine','embedding_chunks_1536_cosine')")).toBe("2");
    } finally { query(`drop database ${database} with (force);`, "template1"); }
  }, 120_000);
});
