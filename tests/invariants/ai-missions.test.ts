import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { loadMissionBudgetUsage } from "@/lib/ai/agents/mission-budget";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db`");

function sql(script: string): string {
  return execFileSync("docker", [
    "exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
  ], { input: script, encoding: "utf8" }).trim();
}

const ORG_A = "a3860000-0000-4000-8000-000000000001";
const ORG_B = "b3860000-0000-4000-8000-000000000002";
const USER_A = "a3860000-1111-4000-8000-000000000001";
const USER_B = "b3860000-1111-4000-8000-000000000002";
const LEAD_A = "a3860000-2222-4000-8000-000000000001";
const LEAD_B = "b3860000-2222-4000-8000-000000000002";
const MISSION_A = "a3860000-3333-4000-8000-000000000001";
const MISSION_B = "b3860000-3333-4000-8000-000000000002";
const AGENT_A = "a3860000-4444-4000-8000-000000000001";
const AGENT_B = "b3860000-4444-4000-8000-000000000002";
const RUN_A = "a3860000-5555-4000-8000-000000000001";
const CHILD_A = "a3860000-5555-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values
      ('${USER_A}','mission-a@invariant.test'),('${USER_B}','mission-b@invariant.test');
    insert into public.organizations(id,slug,legal_name,display_name) values
      ('${ORG_A}','mission-invariant-a','Mission A','Mission A'),
      ('${ORG_B}','mission-invariant-b','Mission B','Mission B');
    insert into public.user_organizations(user_id,organization_id,role,accepted_at) values
      ('${USER_A}','${ORG_A}','manager',now()),('${USER_B}','${ORG_B}','manager',now());
    insert into public.crm_pipelines(id,organization_id,name,slug) values
      ('a3860000-6666-4000-8000-000000000001','${ORG_A}','Pipeline A','mission-a'),
      ('b3860000-6666-4000-8000-000000000002','${ORG_B}','Pipeline B','mission-b');
    insert into public.crm_stages(id,organization_id,pipeline_id,name,slug,position) values
      ('a3860000-7777-4000-8000-000000000001','${ORG_A}','a3860000-6666-4000-8000-000000000001','Open','open',100),
      ('b3860000-7777-4000-8000-000000000002','${ORG_B}','b3860000-6666-4000-8000-000000000002','Open','open',100);
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title) values
      ('${LEAD_A}','${ORG_A}','a3860000-6666-4000-8000-000000000001','a3860000-7777-4000-8000-000000000001','Opportunity A'),
      ('${LEAD_B}','${ORG_B}','b3860000-6666-4000-8000-000000000002','b3860000-7777-4000-8000-000000000002','Opportunity B');
    insert into public.ai_agents(id,organization_id,name,system_prompt) values
      ('${AGENT_A}','${ORG_A}','Agent A','Mission invariant'),
      ('${AGENT_B}','${ORG_B}','Agent B','Mission invariant');
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria) values
      ('${MISSION_A}','${ORG_A}','${LEAD_A}','${USER_A}','推进报价','客户确认报价与交期'),
      ('${MISSION_B}','${ORG_B}','${LEAD_B}','${USER_B}','推进报价','客户确认报价与交期');
  `);
});

describe("tenant-scoped durable business missions", () => {
  it("rejects cross-tenant lead and run links", () => {
    const result = sql(`
      do $$ begin
        begin
          insert into public.ai_missions(organization_id,lead_id,goal,acceptance_criteria)
          values ('${ORG_B}','${LEAD_A}','wrong tenant','must fail');
          raise exception 'cross-tenant lead accepted';
        exception when foreign_key_violation then null; end;
        begin
          insert into public.ai_workbench_runs(organization_id,agent_id,mission_id,task,mode)
          values ('${ORG_B}','${AGENT_B}','${MISSION_A}','wrong tenant','act');
          raise exception 'cross-tenant mission accepted';
        exception when foreign_key_violation then null; end;
      end $$;
      select count(*) from public.ai_missions;
    `).split("\n").at(-1);
    expect(result).toBe("2");
  });

  it("tracks run progress but requires a separate business completion decision", () => {
    const states = sql(`
      insert into public.ai_workbench_runs(id,organization_id,agent_id,mission_id,task,mode)
      values ('${RUN_A}','${ORG_A}','${AGENT_A}','${MISSION_A}','推进报价','act');
      update public.ai_workbench_runs set status='running' where id='${RUN_A}';
      select status from public.ai_missions where id='${MISSION_A}';
      update public.ai_workbench_runs set status='awaiting_confirmation' where id='${RUN_A}';
      select status from public.ai_missions where id='${MISSION_A}';
      update public.ai_workbench_runs set status='completed' where id='${RUN_A}';
      select status || ':' || blocked_reason from public.ai_missions where id='${MISSION_A}';
      update public.ai_missions set status='completed',completed_at=now(),
        resolution_reason='客户已确认报价',resolved_by_user_id='${USER_A}'
      where id='${MISSION_A}';
      update public.ai_workbench_runs set status='running' where id='${RUN_A}';
      select status from public.ai_missions where id='${MISSION_A}';
    `).split("\n");
    expect(states.filter((line) => line === "running" || line === "waiting_approval" || line.startsWith("needs_review:") || line === "completed"))
      .toEqual(["running", "waiting_approval", "needs_review:business_outcome_unverified", "completed"]);
  });

  it("replays mission state transitions without copying human evidence into events", () => {
    const transitions = sql(`
      select event_type || ':' || coalesce(from_status,'-') || '>' || to_status
      from public.ai_mission_events
      where organization_id='${ORG_A}' and mission_id='${MISSION_A}'
      order by id;
    `).split("\n");
    expect(transitions).toEqual([
      "created:->queued",
      "state_changed:queued>running",
      "state_changed:running>waiting_approval",
      "state_changed:waiting_approval>needs_review",
      "state_changed:needs_review>completed",
    ]);
    const resolution = sql(`
      select resolution_reason || ':' || resolved_by_user_id
      from public.ai_missions where organization_id='${ORG_A}' and id='${MISSION_A}';
    `);
    expect(resolution).toContain("客户已确认报价");
    const eventColumns = sql(`
      select string_agg(column_name, ',') from information_schema.columns
      where table_schema='public' and table_name='ai_mission_events';
    `);
    expect(eventColumns).not.toContain("resolution_reason");
  });

  it("enforces one cumulative budget across the root and specialist model calls", async () => {
    sql(`
      insert into public.ai_workbench_runs
        (id,organization_id,agent_id,parent_run_id,run_kind,specialist_key,collaboration_key,task,mode,status)
      values ('${CHILD_A}','${ORG_A}','${AGENT_A}','${RUN_A}','specialist','evidence','mission-eval','读取证据','inspect','queued');
      insert into public.llm_calls
        (organization_id,workbench_run_id,provider,model,input_tokens,output_tokens,cost_cents)
      values
        ('${ORG_A}','${RUN_A}','test','test-model',300,100,5),
        ('${ORG_A}','${CHILD_A}','test','test-model',500,200,10);
    `);
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 1,
    });
    try {
      const usage = await loadMissionBudgetUsage(pool, ORG_A, MISSION_A);
      expect(usage).toMatchObject({ usedTokens: 1100, usedCostCents: 15, unknownCostCalls: 0 });
      expect(await loadMissionBudgetUsage(pool, ORG_B, MISSION_A)).toBeNull();
    } finally {
      await pool.end();
    }
  });

  it("allows manager reads only within their tenant and disallows client writes", () => {
    const visibility = sql(`
      set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${USER_A}"}',false);
      select
        (select count(*) from public.ai_missions where organization_id='${ORG_A}') || ',' ||
        (select count(*) from public.ai_missions where organization_id='${ORG_B}') || ',' ||
        has_table_privilege('authenticated','public.ai_missions','select')::int || ',' ||
        has_table_privilege('authenticated','public.ai_missions','update')::int;
    `).split("\n").at(-1);
    expect(visibility).toBe("1,0,1,0");
    const eventVisibility = sql(`
      set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${USER_A}"}',false);
      select
        (select count(*) from public.ai_mission_events where organization_id='${ORG_A}') || ',' ||
        (select count(*) from public.ai_mission_events where organization_id='${ORG_B}') || ',' ||
        has_table_privilege('authenticated','public.ai_mission_events','select')::int || ',' ||
        has_table_privilege('authenticated','public.ai_mission_events','insert')::int;
    `).split("\n").at(-1);
    expect(eventVisibility).toBe("5,0,1,0");
  });
});
