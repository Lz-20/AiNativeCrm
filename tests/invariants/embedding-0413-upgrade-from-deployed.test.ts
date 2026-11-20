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
      const oldRelations = query(
        "select array_agg(c.oid order by c.oid)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth','storage')",
      );
      const securitySnapshot = () =>
        query(`select encode(sha256(convert_to(jsonb_build_object(
        'relations',(select jsonb_agg(jsonb_build_array(oid,relname,relkind,relowner,relacl,relrowsecurity,relforcerowsecurity) order by oid) from pg_class where oid=any('${oldRelations}'::oid[])),
        'columns',(select jsonb_agg(jsonb_build_array(attrelid,attnum,attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated) order by attrelid,attnum) from pg_attribute where attrelid=any('${oldRelations}'::oid[]) and attnum>0),
        'constraints',(select jsonb_agg(jsonb_build_array(conrelid,conname,pg_get_constraintdef(oid)) order by conrelid,conname) from pg_constraint where conrelid=any('${oldRelations}'::oid[])),
        'policies',(select jsonb_agg(to_jsonb(p) order by p.oid) from pg_policy p where polrelid=any('${oldRelations}'::oid[])),
        'triggers',(select jsonb_agg(jsonb_build_array(tgrelid,tgname,pg_get_triggerdef(oid)) order by tgrelid,tgname) from pg_trigger where tgrelid=any('${oldRelations}'::oid[]) and not tgisinternal),
        'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,pg_get_functiondef(p.oid)) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','auth','storage') and p.prokind in ('f','p')),
        'roles',(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls) order by rolname) from pg_roles),
        'memberships',(select jsonb_agg(to_jsonb(m) order by roleid,member) from pg_auth_members m),
        'default_acl',(select jsonb_agg(to_jsonb(a) order by oid) from pg_default_acl a))::text,'UTF8')),'hex')`);
      const oldSecurity = securitySnapshot();
      const indexes = query(
        "select jsonb_agg(jsonb_build_array(indexname,indexname::regclass::oid) order by indexname) from pg_indexes where schemaname='public' and indexname in ('ai_chunks_embedding_ivfflat_idx','embedding_chunks_1024_cosine','embedding_chunks_1536_cosine')",
      );
      const migration = readFileSync(
        "supabase/migrations/20261119080000_0413_rag_operacoes_controladas.sql",
        "utf8",
      );
      query(migration);
      query(migration);
      expect(securitySnapshot()).toBe(oldSecurity);
      const delta = JSON.parse(
        query(`select jsonb_build_object(
        'tables',(select jsonb_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.oid=any('${oldRelations}'::oid[])),
        'indexes',(select jsonb_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='i' and not c.oid=any('${oldRelations}'::oid[])))`),
      );
      expect(delta.tables).toEqual([
        "ai_embedding_operations",
        "ai_embedding_price_reviews",
        "ai_embedding_requests",
      ]);
      expect(delta.indexes).toHaveLength(9);
      console.info("0413_CATALOG_DELTA", JSON.stringify(delta));
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
