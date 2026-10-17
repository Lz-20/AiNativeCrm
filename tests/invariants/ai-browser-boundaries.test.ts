import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Deny-all is a stronger contract than row filtering. Exercise actual SQL as
// both browsers, not just has_table_privilege() or a superuser row count.
// Ownership/FK and scoped server APIs are separately covered by the mission,
// identity, service integration, explicit-offer and cancellation invariants.
const SERVICE_ONLY = [
  "ai_customer_memories",
  "ai_internal_event_inbox",
  "ai_internal_identity_challenges",
  "ai_internal_platform_tenants",
  "ai_internal_platform_users",
  "ai_internal_question_outbox",
  "ai_mission_commands",
  "ai_mission_explicit_offers",
  "ai_mission_internal_inputs",
  "ai_mission_internal_threads",
  "ai_mission_wakes",
  "ai_wiki_evidence",
  "ai_workbench_send_decision_receipts"
] as const;
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 2,
});
const orgs = [randomUUID(), randomUUID()];
const users = [randomUUID(), randomUUID()];
beforeAll(async () => {
  for (let i=0;i<2;i++) {
    await pool.query("insert into auth.users(id,email) values($1,$2)", [users[i], `ai-boundary-${users[i]}@test.invalid`]);
    await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Boundary','Boundary')", [orgs[i]]);
    await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())", [users[i],orgs[i]]);
    await pool.query("insert into ai_integration_settings(organization_id,provider,enabled) values($1,'mem0',false)", [orgs[i]]);
  }
});
afterAll(() => pool.end());

async function asRole<T>(role: "authenticated" | "anon" | "service_role", user: string | null, query: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims',$1,true)",
      [JSON.stringify({sub:user,role,aal:"aal1"})]);
    return await client.query<T & pg.QueryResultRow>(query);
  } finally {
    await client.query("rollback");
    client.release();
  }
}
describe("AI browser privilege and two-tenant isolation proofs", () => {
  it.each(SERVICE_ONLY)("%s denies actual browser SQL independently of data volume", async (table) => {
    // Positive control: the intended server can read. A missing table or a
    // database that refuses everyone cannot make this test green.
    await expect(asRole("service_role", null, `select count(*) from public.${table}`)).resolves.toBeDefined();
    for (const user of users)
      await expect(asRole("authenticated", user!, `select * from public.${table} limit 1`))
        .rejects.toMatchObject({code:"42501"});
    await expect(asRole("anon", null, `select * from public.${table} limit 1`))
      .rejects.toMatchObject({code:"42501"});
  });
  it("integration settings are visible only to their real member, in both directions", async () => {
    for (let i=0;i<2;i++) {
      const visible=await asRole<{organization_id:string}>("authenticated", users[i]!,
        "select organization_id from public.ai_integration_settings");
      expect(visible.rows).toEqual([{organization_id:orgs[i]}]);
      await expect(asRole("authenticated", users[i]!, "update public.ai_integration_settings set enabled=true"))
        .rejects.toMatchObject({code:"42501"});
    }
  });
});
