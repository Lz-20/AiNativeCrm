import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

// Acceptance uses only the disposable database managed by scripts/test-db.sh.
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("Run via pnpm test:db, never against the CRM database");
const org = "a4100000-0000-4000-8000-000000000001";
const otherOrg = "b4100000-0000-4000-8000-000000000001";
const contact = "a4100000-0000-4000-8000-000000000002";
const otherContact = "b4100000-0000-4000-8000-000000000002";
const memory = "a4100000-0000-4000-8000-000000000003";
const otherMemory = "b4100000-0000-4000-8000-000000000003";

function sql(input: string) {
  return execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "postgres",
    "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA", "-f", "-"], {
    input, encoding: "utf8",
  }).trim();
}

beforeAll(() => {
  sql(`insert into organizations(id,slug,legal_name,display_name) values
    ('${org}','memory-privacy-acceptance-a','Synthetic A','Synthetic A'),
    ('${otherOrg}','memory-privacy-acceptance-b','Synthetic B','Synthetic B');
    insert into contacts(id,organization_id,display_name) values
    ('${contact}','${org}','Synthetic A'),('${otherContact}','${otherOrg}','Synthetic B');
    insert into ai_customer_memories(id,organization_id,contact_id,subject_key,request_key,
      category,body,content_hash,sync_state,write_outcome) values
    ('${memory}','${org}','${contact}',repeat('a',64),'${memory}',
      'preference','Synthetic private A',repeat('c',64),'synced','confirmed'),
    ('${otherMemory}','${otherOrg}','${otherContact}',repeat('b',64),'${otherMemory}',
      'preference','Synthetic private B',repeat('d',64),'synced','confirmed');`);
});

describe("actual LGPD cascade reaches confirmed memory through its privacy trigger", () => {
  it("begins with two readable, live synthetic memories (positive control)", () => {
    expect(sql("select count(*) from ai_customer_memories where deleted_at is null and body <> ''"))
      .toBe("2");
  });

  it("anonymizes local content, retains the external cleanup receipt and isolates the other tenant", () => {
    sql(`set role service_role;
      select public.fn_lgpd_cascade_redact_contact('${org}','${contact}',gen_random_uuid());`);
    expect(sql(`select (body='')::text||':'||sync_state||':'||(deleted_at is not null)::text||':'||
      (remote_deleted_at is null)::text from ai_customer_memories where id='${memory}'`))
      .toBe("true:deleted:true:true");
    expect(sql(`select body||':'||sync_state||':'||(deleted_at is null)::text
      from ai_customer_memories where id='${otherMemory}'`))
      .toBe("Synthetic private B:synced:true");
    expect(sql(`select count(*) from event_log where organization_id='${org}'
      and entity_id='${memory}' and event_type='ai_integration.mem0_sync'`)).toBe("1");
  });

  it("does not duplicate the cleanup event on repeated anonymization", () => {
    const result = JSON.parse(sql(`set role service_role;
      select public.fn_lgpd_cascade_redact_contact('${org}','${contact}',gen_random_uuid());`));
    expect(result.already_anonymized).toBe(true);
    expect(sql(`select count(*) from event_log where organization_id='${org}'
      and entity_id='${memory}' and event_type='ai_integration.mem0_sync'`)).toBe("1");
  });

  it("rejects a foreign contact and preserves its memory", () => {
    expect(() => sql(`set role service_role;
      select public.fn_lgpd_cascade_redact_contact('${org}','${otherContact}',gen_random_uuid());`))
      .toThrow();
    expect(sql(`select body from ai_customer_memories where id='${otherMemory}'`))
      .toBe("Synthetic private B");
  });
});
