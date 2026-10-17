import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run via pnpm test:db");
const org = "a4060000-0000-4000-8000-000000000001";
const other = "b4060000-0000-4000-8000-000000000001";
const contact = "a4060000-0000-4000-8000-000000000002";
const memory = "a4060000-0000-4000-8000-000000000003";
function sql(input: string) {
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
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input, encoding: "utf8" },
  ).trim();
}
beforeAll(() => {
  sql(`insert into organizations(id,slug,legal_name,display_name) values
    ('${org}','integration-invariant-a','Integration A','Integration A'),('${other}','integration-invariant-b','Integration B','Integration B');
    insert into contacts(id,organization_id,display_name) values ('${contact}','${org}','Synthetic customer');
    insert into ai_customer_memories(id,organization_id,contact_id,subject_key,request_key,category,body,content_hash,sync_state,write_outcome)
      values('${memory}','${org}','${contact}',repeat('a',64),'${memory}','preference','Private fixture',repeat('b',64),'sending','in_flight');`);
});
describe("optional AI service SQL privacy and ownership", () => {
  it("keeps confirmed local facts queryable without any optional provider activation", () => {
    expect(sql(`select count(*) from ai_integration_settings where organization_id='${org}' and enabled`)).toBe("0");
    expect(sql(`select count(*) from ai_customer_memories m join contacts c
      on c.organization_id=m.organization_id and c.id=m.contact_id
      where m.organization_id='${org}' and m.contact_id='${contact}' and m.deleted_at is null
        and c.is_anonymized=false and c.is_merged_into is null`)).toBe("1");
    expect(sql(`select count(*) from ai_customer_memories where organization_id='${other}' and contact_id='${contact}'`)).toBe("0");
  });
  it("denies direct browser writes/reads to memory and manifest storage", () => {
    expect(sql("select has_table_privilege('authenticated','ai_customer_memories','SELECT')")).toBe(
      "f",
    );
    expect(
      sql("select has_table_privilege('authenticated','ai_integration_settings','UPDATE')"),
    ).toBe("f");
    expect(sql("select has_table_privilege('service_role','ai_wiki_evidence','UPDATE')")).toBe("f");
    expect(sql("select has_table_privilege('service_role','ai_wiki_evidence','DELETE')")).toBe("f");
  });
  it("enforces the contact-to-organization composite FK", () => {
    expect(() =>
      sql(`insert into ai_customer_memories(organization_id,contact_id,subject_key,request_key,category,body,content_hash)
      values('${other}','${contact}',repeat('a',64),gen_random_uuid(),'preference','Wrong tenant',repeat('b',64));`),
    ).toThrow();
  });
  it("retains a content-free cleanup receipt on physical deletion and blocks unsafe org deletion", () => {
    sql(`delete from contacts where id='${contact}';`);
    expect(
      sql(
        `select (contact_id is null)::text||':'||(body='')::text||':'||sync_state||':'||write_outcome from ai_customer_memories where id='${memory}'`,
      ),
    ).toBe("true:true:deleted:in_flight");
    expect(
      sql(
        `select count(*) from event_log where organization_id='${org}' and event_type='ai_integration.mem0_sync' and entity_id='${memory}'`,
      ),
    ).toBe("1");
    expect(() => sql(`delete from organizations where id='${org}'`)).toThrow();
  });
});
