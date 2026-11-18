/** PostgreSQL invariants with SYNTHETIC vectors. Not a live embedding acceptance. */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GOV_ORG, GOV_VIEWER, seedGov, sql, countAs, indexExists } from "./gov-helpers";
const source = "e4120000-0000-4000-8000-000000000001";
const versionA = "e4120000-0000-4000-8000-000000000002";
const versionB = "e4120000-0000-4000-8000-000000000003";
const keyA = "e4120000-0000-4000-8000-000000000004";
const keyB = "e4120000-0000-4000-8000-000000000005";
const otherOrg = "e4120000-0000-4000-8000-000000000006";
const fpA = "embedding:v1:" + "a".repeat(64);
const fpB = "embedding:v1:" + "b".repeat(64);
const vector = (dims: number) => `(select array_fill(0.1::real,array[${dims}])::vector)`;
const profile = (fp: string, dims: number) => JSON.stringify({ provider: dims === 1024 ? "siliconflow" : "bailian",
  model: dims === 1024 ? "BAAI/bge-m3" : "text-embedding-v4", dimensions: dims,
  baseUrl: dims === 1024 ? "https://api.siliconflow.cn/v1" : "https://dashscope.aliyuncs.com/compatible-mode/v1", revision: "1", fingerprint: fp });
beforeAll(() => seedGov());
beforeEach(() => {
  // Reset only this fixture namespace; cases also pass in shuffled order.
  sql(`update public.ai_knowledge_sources set active_kb_version_id=null where id='${source}';
    delete from public.ai_embedding_chunks where knowledge_source_id='${source}';
    delete from public.ai_knowledge_versions where knowledge_source_id='${source}';
    delete from public.ai_knowledge_sources where id='${source}';
    delete from public.ai_embedding_configurations where organization_id in ('${GOV_ORG}','${otherOrg}');
    delete from public.ai_provider_credentials where id in ('${keyA}','${keyB}');
    insert into public.organizations(id,slug,legal_name,display_name) values('${otherOrg}','embedding-other-org','Synthetic','Synthetic') on conflict do nothing;
    insert into public.ai_provider_credentials(id,organization_id,provider,label,api_key_encrypted,api_key_iv,api_key_tag,is_active,validated_at)
    values('${keyA}','${GOV_ORG}','siliconflow','Synthetic Embedding A','\\x01','\\x02','\\x03',true,now()),
          ('${keyB}','${GOV_ORG}','bailian','Synthetic Embedding B','\\x01','\\x02','\\x03',true,now());
    insert into public.ai_embedding_configurations(organization_id,provider,base_url,model,dimensions,model_revision,fingerprint,credential_id,enabled)
    values('${GOV_ORG}','siliconflow','https://api.siliconflow.cn/v1','BAAI/bge-m3',1024,'1','${fpA}','${keyA}',true);
    insert into public.ai_knowledge_sources(id,organization_id,agent_id,source_type,name,status,is_active)
    values('${source}','${GOV_ORG}',null,'documento','SVC-101 synthetic SQL fixture','ready',true);
    insert into public.ai_knowledge_versions(id,organization_id,knowledge_source_id,agent_id,version_number,status,is_active,embedding_model,embedding_dims,embedding_profile)
    values('${versionA}','${GOV_ORG}','${source}',null,1,'building',false,'${fpA}',1024,'${profile(fpA,1024)}');
    insert into public.ai_embedding_chunks(organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding,embedding_dims,embedding_fingerprint)
    values('${GOV_ORG}','${source}','${versionA}',0,'SVC-101 synthetic excerpt','synthetic-hash',8,${vector(1024)},1024,'${fpA}');
    update public.ai_knowledge_versions set status='ready',total_chunks=1 where id='${versionA}';
    select public.fn_activate_embedding_version('${GOV_ORG}','${source}','${versionA}','${fpA}');`);
});
function count(fp = fpA, dims = 1024): number {
  return Number(sql(`select count(*) from public.fn_search_knowledge_profile('${GOV_ORG}',array['${source}']::uuid[],${vector(dims)},'${fp}',${dims},5,-1)`));
}
describe("0412 — distinct embedding spaces, immutable provenance and atomic publication", () => {
  it("preserves the old vector(1536) NOT NULL column", () => {
    expect(sql("select format_type(atttypid,atttypmod)||':'||attnotnull from pg_attribute where attrelid='public.ai_chunks'::regclass and attname='embedding'")).toBe("vector(1536):true");
    expect(indexExists("embedding_chunks_1024_cosine")).toBe(true);
    expect(indexExists("embedding_chunks_1536_cosine")).toBe(true);
  });
  it("returns only the selected profile with source and version metadata", () => {
    expect(count()).toBe(1);
    expect(sql(`select source_name||':'||index_version_id from public.fn_search_knowledge_profile('${GOV_ORG}',array['${source}']::uuid[],${vector(1024)},'${fpA}',1024,5,-1)`)).toBe(`SVC-101 synthetic SQL fixture:${versionA}`);
  });
  it("permits legitimate own-tenant reads and rejects a foreign org", () => {
    expect(countAs(GOV_VIEWER, `select count(*) from public.fn_search_knowledge_profile('${GOV_ORG}',array['${source}']::uuid[],${vector(1024)},'${fpA}',1024,5,-1)`)).toBe(1);
    expect(() => countAs(GOV_VIEWER, `select count(*) from public.fn_search_knowledge_profile('${otherOrg}',array['${source}']::uuid[],${vector(1024)},'${fpA}',1024,5,-1)`)).toThrow();
  });
  it("never ignores the caller's permitted source list", () => {
    expect(Number(sql(`select count(*) from public.fn_search_knowledge_profile('${GOV_ORG}',array[]::uuid[],${vector(1024)},'${fpA}',1024,5,-1)`))).toBe(0);
  });
  it("rejects invalid dimensions and unapproved endpoints", () => {
    expect(() => sql(`select * from public.fn_search_knowledge_profile('${GOV_ORG}',array['${source}']::uuid[],${vector(1536)},'${fpA}',1024,5,-1)`)).toThrow();
    expect(() => sql(`update public.ai_embedding_configurations set base_url='http://127.0.0.1/v1' where organization_id='${GOV_ORG}'`)).toThrow();
  });
  it("rejects wrong-profile writes and zero or wrong-length stored vectors", () => {
    // The version is immutable/ready, so it cannot accept additional writes.
    expect(() => sql(`insert into public.ai_embedding_chunks(organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding,embedding_dims,embedding_fingerprint)
      values('${GOV_ORG}','${source}','${versionA}',9,'synthetic','hash',1,${vector(1024)},1024,'${fpB}')`)).toThrow();
    expect(() => sql(`select * from public.fn_search_knowledge_profile('${GOV_ORG}',array['${source}']::uuid[],array_fill(0::real,array[1024])::vector,'${fpA}',1024,5,-1)`)).toThrow();
    expect(() => count(fpB)).toThrow();
  });
  it("builds a usable HNSW expression index for the dimension-specific cosine query", () => {
    const plan = sql(`set enable_seqscan=off; explain (format json) select id from public.ai_embedding_chunks
      where embedding_dims=1024 order by embedding::vector(1024) <=> ${vector(1024)}::vector(1024) limit 5;`);
    expect(plan).toContain("embedding_chunks_1024_cosine");
  });
  it("cannot attach a different-tenant credential", () => {
    expect(() => sql(`insert into public.ai_embedding_configurations(organization_id,provider,base_url,model,dimensions,model_revision,fingerprint,credential_id)
      values('${otherOrg}','siliconflow','https://api.siliconflow.cn/v1','BAAI/bge-m3',1024,'1','${fpA}','${keyA}')`)).toThrow();
  });
  it("ready version identities cannot be relabeled as a different model", () => {
    expect(() => sql(`update public.ai_knowledge_versions set embedding_model='${fpB}' where id='${versionA}'`)).toThrow();
    expect(count()).toBe(1);
  });
  it("switches profiles without mixing old vectors; failed activation preserves prior pointer", () => {
    sql(`update public.ai_embedding_configurations set provider='bailian',base_url='https://dashscope.aliyuncs.com/compatible-mode/v1',model='text-embedding-v4',dimensions=1536,fingerprint='${fpB}',credential_id='${keyB}' where organization_id='${GOV_ORG}';
      insert into public.ai_knowledge_versions(id,organization_id,knowledge_source_id,agent_id,version_number,status,is_active,total_chunks,embedding_model,embedding_dims,embedding_profile)
      values('${versionB}','${GOV_ORG}','${source}',null,2,'building',false,2,'${fpB}',1536,'${profile(fpB,1536)}');
      insert into public.ai_embedding_chunks(organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding,embedding_dims,embedding_fingerprint)
      values('${GOV_ORG}','${source}','${versionB}',0,'new-model synthetic excerpt','synthetic-hash-b',8,${vector(1536)},1536,'${fpB}');
      update public.ai_knowledge_versions set status='ready' where id='${versionB}';`);
    expect(() => count()).toThrow();
    expect(count(fpB,1536)).toBe(0);
    expect(() => sql(`select public.fn_activate_embedding_version('${GOV_ORG}','${source}','${versionB}','${fpB}')`)).toThrow();
    expect(sql(`select active_kb_version_id from public.ai_knowledge_sources where id='${source}'`)).toBe(versionA);
    sql(`update public.ai_knowledge_versions set total_chunks=1 where id='${versionB}';select public.fn_activate_embedding_version('${GOV_ORG}','${source}','${versionB}','${fpB}');`);
    expect(count(fpB,1536)).toBe(1);
  });
  it("does not grant the browser embedding writes or anonymous RPC execution", () => {
    expect(sql("select has_table_privilege('authenticated','public.ai_embedding_chunks','INSERT')")).toBe("f");
    expect(sql("select has_table_privilege('authenticated','public.ai_embedding_configurations','UPDATE')")).toBe("f");
    expect(sql("select has_function_privilege('anon','public.fn_search_knowledge_profile(uuid,uuid[],vector,text,integer,integer,real)','EXECUTE')")).toBe("f");
  });
});
