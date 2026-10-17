import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db`");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
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
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG_A = "a8400000-0000-4000-8000-000000000001";
const ORG_B = "b8400000-0000-4000-8000-000000000002";
const USER_A = "a8400000-1111-4000-8000-000000000001";
const USER_B = "b8400000-1111-4000-8000-000000000002";
const AGENT_A = "a8400000-2222-4000-8000-000000000001";
const AGENT_B = "b8400000-2222-4000-8000-000000000002";
const ROOT_A = "a8400000-3333-4000-8000-000000000001";
const ROOT_B = "b8400000-3333-4000-8000-000000000002";
const CHILD_A = "a8400000-4444-4000-8000-000000000001";
const CHILD_LEASE = "a8400000-4444-4000-8000-000000000002";
const ATTEMPT_1 = "a8400000-5555-4000-8000-000000000001";
const ATTEMPT_2 = "a8400000-5555-4000-8000-000000000002";

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values
      ('${USER_A}','duo-a@invariant.test'),('${USER_B}','duo-b@invariant.test');
    insert into public.organizations(id,slug,legal_name,display_name) values
      ('${ORG_A}','duo-invariant-a','Duo Invariant A','Duo A'),
      ('${ORG_B}','duo-invariant-b','Duo Invariant B','Duo B');
    insert into public.user_organizations(user_id,organization_id,role,accepted_at) values
      ('${USER_A}','${ORG_A}','manager',now()),('${USER_B}','${ORG_B}','manager',now());
    insert into public.ai_agents(id,organization_id,name,system_prompt) values
      ('${AGENT_A}','${ORG_A}','Duo A','Synthetic invariant agent A'),
      ('${AGENT_B}','${ORG_B}','Duo B','Synthetic invariant agent B');
    insert into public.ai_workbench_runs(id,organization_id,agent_id,task,mode) values
      ('${ROOT_A}','${ORG_A}','${AGENT_A}','root A','inspect'),
      ('${ROOT_B}','${ORG_B}','${AGENT_B}','root B','inspect');
  `);
});

describe("duoagent durable database boundary", () => {
  it("enforces inspect-only children, same-org parentage and one child per specialist", () => {
    const count = sql(`
        do $$ begin
          begin
            insert into public.ai_workbench_runs
              (organization_id,agent_id,task,mode,run_kind,parent_run_id,specialist_key,collaboration_key)
            values ('${ORG_A}','${AGENT_A}','invalid act child','act','specialist','${ROOT_A}','invalid','review');
            raise exception 'inspect-only constraint did not fire';
          exception when check_violation then null; end;
          begin
            insert into public.ai_workbench_runs
              (organization_id,agent_id,task,mode,run_kind,parent_run_id,specialist_key,collaboration_key)
            values ('${ORG_B}','${AGENT_B}','cross tenant child','inspect','specialist','${ROOT_A}','cross','review');
            raise exception 'same-org parent constraint did not fire';
          exception when foreign_key_violation then null; end;
          insert into public.ai_workbench_runs
            (id,organization_id,agent_id,task,mode,run_kind,parent_run_id,specialist_key,collaboration_key)
          values ('${CHILD_A}','${ORG_A}','${AGENT_A}','valid child','inspect','specialist','${ROOT_A}','customer_evidence','review');
          begin
            insert into public.ai_workbench_runs
              (organization_id,agent_id,task,mode,run_kind,parent_run_id,specialist_key,collaboration_key)
            values ('${ORG_A}','${AGENT_A}','duplicate child','inspect','specialist','${ROOT_A}','customer_evidence','review');
            raise exception 'specialist dedup constraint did not fire';
          exception when unique_violation then null; end;
        end $$;
        select count(*) from public.ai_workbench_runs where parent_run_id='${ROOT_A}';
      `)
      .split("\n")
      .at(-1);
    expect(count).toBe("1");
  });

  it("binds model-call attribution and eval reports to the same tenant as the run", () => {
    const count = sql(`
        do $$ begin
          begin
            insert into public.llm_calls(organization_id,workbench_run_id,provider,model)
            values('${ORG_B}','${ROOT_A}','invariant','model');
            raise exception 'llm attribution same-org constraint did not fire';
          exception when foreign_key_violation then null; end;
          begin
            insert into public.ai_agent_eval_reports
              (organization_id,run_id,profile_key,profile_revision,input_fingerprint,verdict,score,report)
            values('${ORG_B}','${ROOT_A}','duo_v1',1,repeat('b',64),'pass',100,'{}');
            raise exception 'eval same-org constraint did not fire';
          exception when foreign_key_violation then null; end;
          insert into public.ai_agent_eval_reports
            (organization_id,run_id,profile_key,profile_revision,input_fingerprint,verdict,score,report)
          values
            ('${ORG_A}','${ROOT_A}','duo_v1',1,repeat('a',64),'pass',100,'{}'),
            ('${ORG_B}','${ROOT_B}','duo_v1',1,repeat('b',64),'pass',100,'{}');
          begin
            insert into public.ai_agent_eval_reports
              (organization_id,run_id,profile_key,profile_revision,input_fingerprint,verdict,score,report)
            values('${ORG_A}','${ROOT_A}','duo_v1',1,repeat('a',64),'pass',100,'{}');
            raise exception 'eval fingerprint dedup constraint did not fire';
          exception when unique_violation then null; end;
        end $$;
        select count(*) from public.ai_agent_eval_reports;
      `)
      .split("\n")
      .at(-1);
    expect(count).toBe("2");
  });

  it("atomically leases specialists and fences a stale worker completion", () => {
    const result = sql(`
      insert into public.ai_workbench_runs
        (id,organization_id,agent_id,task,mode,run_kind,parent_run_id,specialist_key,collaboration_key)
      values
        ('${CHILD_LEASE}','${ORG_A}','${AGENT_A}','leased child','inspect','specialist','${ROOT_A}','lease_test','review');

      select execution_attempt_id from public.fn_claim_ai_specialist_run(
        '${ORG_A}','${ROOT_A}','${CHILD_LEASE}','${ATTEMPT_1}',30
      );
      select count(*) from public.fn_claim_ai_specialist_run(
        '${ORG_A}','${ROOT_A}','${CHILD_LEASE}','${ATTEMPT_2}',30
      );

      update public.ai_workbench_runs
      set execution_lease_expires_at=clock_timestamp()-interval '1 second'
      where organization_id='${ORG_A}' and id='${CHILD_LEASE}';
      select execution_attempt_id from public.fn_claim_ai_specialist_run(
        '${ORG_A}','${ROOT_A}','${CHILD_LEASE}','${ATTEMPT_2}',30
      );

      with stale_write as (
        update public.ai_workbench_runs
        set status='completed',execution_lease_expires_at=null
        where organization_id='${ORG_A}' and id='${CHILD_LEASE}'
          and status='running' and execution_attempt_id='${ATTEMPT_1}'
        returning id
      ) select count(*) from stale_write;

      with current_write as (
        update public.ai_workbench_runs
        set status='completed',execution_lease_expires_at=null
        where organization_id='${ORG_A}' and id='${CHILD_LEASE}'
          and status='running' and execution_attempt_id='${ATTEMPT_2}'
        returning id
      ) select count(*) from current_write;
    `).split("\n");

    expect(
      result.filter((line) => line === ATTEMPT_1 || line === ATTEMPT_2 || /^[01]$/.test(line)),
    ).toEqual([ATTEMPT_1, "0", ATTEMPT_2, "0", "1"]);
  });

  it("keeps the claim RPC service-only and execution fields off root runs", () => {
    const result = sql(`
      do $$ begin
        begin
          update public.ai_workbench_runs
          set execution_attempt_id='${ATTEMPT_1}',execution_lease_expires_at=now()+interval '1 minute'
          where id='${ROOT_A}';
          raise exception 'root execution-shape constraint did not fire';
        exception when check_violation then null; end;
      end $$;
      select
        has_function_privilege('anon','public.fn_claim_ai_specialist_run(uuid,uuid,uuid,uuid,integer)','execute')::int || ',' ||
        has_function_privilege('authenticated','public.fn_claim_ai_specialist_run(uuid,uuid,uuid,uuid,integer)','execute')::int || ',' ||
        has_function_privilege('service_role','public.fn_claim_ai_specialist_run(uuid,uuid,uuid,uuid,integer)','execute')::int;
    `)
      .split("\n")
      .at(-1);
    expect(result).toBe("0,0,1");
  });

  it("lets each manager read only their own persisted evaluation and never mutate it", () => {
    const visibility = sql(`
      set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${USER_A}"}',false);
      select
        (select count(*) from public.ai_agent_eval_reports where organization_id='${ORG_A}') || ',' ||
        (select count(*) from public.ai_agent_eval_reports where organization_id='${ORG_B}') || ',' ||
        has_table_privilege('authenticated','public.ai_agent_eval_reports','select')::int || ',' ||
        has_table_privilege('authenticated','public.ai_agent_eval_reports','insert')::int;
    `)
      .split("\n")
      .at(-1);
    expect(visibility).toBe("1,0,1,0");
  });
});
