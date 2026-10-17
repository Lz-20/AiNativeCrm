import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resultDocument } from "@/lib/ai/agents/workbench-result-submission";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 2,
});
const org = randomUUID();
const otherOrg = randomUUID();
const actor = randomUUID();
const agent = randomUUID();
const run = randomUUID();

beforeAll(async () => {
  await pool.query("insert into auth.users(id,email) values($1,$2)", [actor, `structured-${actor}@test.local`]);
  await pool.query(
    "insert into public.organizations(id,slug,legal_name,display_name) values($1,$2,'Structured Result','Structured Result'),($3,$4,'Other','Other')",
    [org, `structured-${org.slice(0, 8)}`, otherOrg, `other-${otherOrg.slice(0, 8)}`],
  );
  await pool.query(
    "insert into public.user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())",
    [actor, org],
  );
  await pool.query(
    "insert into public.ai_agents(id,organization_id,name,system_prompt) values($1,$2,'Agent','Check facts')",
    [agent, org],
  );
  await pool.query(
    "insert into public.ai_workbench_runs(id,organization_id,agent_id,task,mode,status) values($1,$2,$3,'Check quote','inspect','completed')",
    [run, org, agent],
  );
});
afterAll(() => pool.end());

describe("Workbench structured result persistence", () => {
  it("stores a bounded model statement without reclassifying old runs as verified", async () => {
    const result = resultDocument({
      summary: "交期尚未确认",
      evidence: [{ sourceType: "lead", sourceId: randomUUID(), claim: "报价阶段" }],
      missingInformation: ["交付日期"],
      nextStep: "请求交付同事确认",
      wakeCondition: "internal_response",
    });
    await pool.query(
      "update public.ai_workbench_runs set result_document=$1::jsonb where organization_id=$2 and id=$3",
      [JSON.stringify(result), org, run],
    );
    const { rows } = await pool.query<{ result_document: typeof result }>(
      "select result_document from public.ai_workbench_runs where organization_id=$1 and id=$2",
      [org, run],
    );
    expect(rows[0]?.result_document).toEqual(result);
    await expect(pool.query(
      "update public.ai_workbench_runs set result_document=$1::jsonb where organization_id=$2 and id=$3",
      [JSON.stringify({ summary: "unchecked" }), org, run],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps the result inside the same organization RLS boundary as its Run", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: actor, role: "authenticated", aal: "aal1" }),
      ]);
      const visible = await client.query<{ organization_id: string; result_document: unknown }>(
        "select organization_id,result_document from public.ai_workbench_runs where id=$1",
        [run],
      );
      expect(visible.rows[0]).toMatchObject({ organization_id: org });
      expect(visible.rows[0]?.result_document).toBeTruthy();
      const foreign = await client.query(
        "select id from public.ai_workbench_runs where organization_id=$1",
        [otherOrg],
      );
      expect(foreign.rows).toEqual([]);
      await expect(client.query(
        "update public.ai_workbench_runs set result_document=null where id=$1",
        [run],
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});
