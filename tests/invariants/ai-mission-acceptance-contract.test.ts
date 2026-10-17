import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db`");

function sql(script: string): string {
  return execFileSync("docker", [
    "exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
  ], { input: script, encoding: "utf8" }).trim();
}

describe("Mission observable acceptance contract database invariant", () => {
  it("stores valid contracts and rejects malformed or unknown checks", () => {
    const result = sql(`
      insert into public.organizations(id,slug,legal_name,display_name)
      values ('a3950000-0000-4000-8000-000000000001','acceptance-contract','Acceptance','Acceptance');
      insert into public.crm_pipelines(id,organization_id,name,slug)
      values ('a3950000-1111-4000-8000-000000000001','a3950000-0000-4000-8000-000000000001','Pipeline','acceptance');
      insert into public.crm_stages(id,organization_id,pipeline_id,name,slug,position)
      values ('a3950000-2222-4000-8000-000000000001','a3950000-0000-4000-8000-000000000001',
              'a3950000-1111-4000-8000-000000000001','Open','open',100);
      insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,title)
      values ('a3950000-3333-4000-8000-000000000001','a3950000-0000-4000-8000-000000000001',
              'a3950000-1111-4000-8000-000000000001','a3950000-2222-4000-8000-000000000001','Deal');
      insert into public.ai_missions(id,organization_id,lead_id,goal,acceptance_criteria,acceptance_contract)
      values ('a3950000-4444-4000-8000-000000000001','a3950000-0000-4000-8000-000000000001',
              'a3950000-3333-4000-8000-000000000001','推进商机','客户确认报价',
              '{"revision":1,"checks":[{"kind":"lead_status","equals":"won"},{"kind":"customer_inbound_after_verified_send"}]}'::jsonb);
      select acceptance_contract->>'revision' from public.ai_missions
      where id='a3950000-4444-4000-8000-000000000001';
      select public.fn_valid_ai_mission_acceptance_contract(null);
      select public.fn_valid_ai_mission_acceptance_contract('{"revision":1,"checks":[]}'::jsonb);
      select public.fn_valid_ai_mission_acceptance_contract('{"revision":"1","checks":[{"kind":"lead_status","equals":"won"}]}'::jsonb);
      select public.fn_valid_ai_mission_acceptance_contract('{"revision":1,"checks":[{"kind":"lead_status","foo":"won"}]}'::jsonb);
      select public.fn_valid_ai_mission_acceptance_contract('{"revision":1,"checks":[{"kind":"lead_status","equals":"won"},{"kind":"lead_status","equals":"lost"}]}'::jsonb);
      select public.fn_valid_ai_mission_acceptance_contract('{"revision":1,"checks":[{"kind":"customer_accepted_quote"}]}'::jsonb);
      do $$ begin
        begin
          update public.ai_missions set acceptance_contract='{"revision":1,"checks":[]}'::jsonb
          where id='a3950000-4444-4000-8000-000000000001';
          raise exception 'invalid contract accepted';
        exception when check_violation then null; end;
      end $$;
      select acceptance_contract->>'revision' from public.ai_missions
      where id='a3950000-4444-4000-8000-000000000001';
    `);
    expect(result.split("\n").filter((line) => ["1", "t", "f"].includes(line)))
      .toEqual(["1", "t", "f", "f", "f", "f", "f", "1"]);
  });
});
