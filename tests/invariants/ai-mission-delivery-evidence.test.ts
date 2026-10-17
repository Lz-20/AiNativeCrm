import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { loadMissionDeliveryEvidence } from "@/lib/ai/evals/mission-delivery-evidence";
import { loadCustomerAcceptanceMaterial } from "@/lib/ai/evals/mission-customer-acceptance";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db`");

function sql(script: string): string {
  return execFileSync("docker", [
    "exec", "-i", container!, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
  ], { input: script, encoding: "utf8" }).trim();
}

const ids = {
  org: "a3970000-0000-4000-8000-000000000001",
  otherOrg: "b3970000-0000-4000-8000-000000000002",
  session: "a3970000-1111-4000-8000-000000000001",
  contact: "a3970000-2222-4000-8000-000000000001",
  conversation: "a3970000-3333-4000-8000-000000000001",
  agent: "a3970000-4444-4000-8000-000000000001",
  version: "a3970000-5555-4000-8000-000000000001",
  run: "a3970000-6666-4000-8000-000000000001",
  proposal: "a3970000-7777-4000-8000-000000000001",
  job: "a3970000-8888-4000-8000-000000000001",
  receipt: "a3970000-9999-4000-8000-000000000001",
  message: "a3970000-aaaa-4000-8000-000000000001",
  draft: "a3970000-bbbb-4000-8000-000000000001",
  earlierInbound: "a3970000-cccc-4000-8000-000000000001",
  laterInbound: "a3970000-dddd-4000-8000-000000000001",
};

beforeAll(() => {
  sql(`
    insert into public.organizations(id,slug,legal_name,display_name) values
      ('${ids.org}','mission-receipt-a','Receipt A','Receipt A'),
      ('${ids.otherOrg}','mission-receipt-b','Receipt B','Receipt B');
    insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted)
      values ('${ids.session}','${ids.org}','mission-receipt','\\x00'::bytea);
    insert into public.contacts(id,organization_id,display_name)
      values ('${ids.contact}','${ids.org}','Receipt contact');
    insert into public.conversations(id,organization_id,contact_id,channel_session_id)
      values ('${ids.conversation}','${ids.org}','${ids.contact}','${ids.session}');
    insert into public.ai_agents(id,organization_id,name,system_prompt,operation_mode)
      values ('${ids.agent}','${ids.org}','Receipt agent','Receipt test','assisted');
    insert into public.ai_agent_versions
      (id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status)
      values ('${ids.version}','${ids.org}','${ids.agent}',1,'Receipt test','anthropic','test-model','${ids.session}','published');
    update public.ai_agents set published_version_id='${ids.version}' where id='${ids.agent}';
    insert into public.ai_workbench_runs(id,organization_id,agent_id,task,mode)
      values ('${ids.run}','${ids.org}','${ids.agent}','Send receipt','act');
    insert into public.ai_agent_action_proposals
      (id,organization_id,run_id,sequence,tool_name,status)
      values ('${ids.proposal}','${ids.org}','${ids.run}',1,'send_message','executed');
    insert into public.job_queue(id,organization_id,contact_id,kind)
      values ('${ids.job}','${ids.org}','${ids.contact}','followup_turn');
    insert into public.messages
      (id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at,metadata)
      values ('${ids.message}','${ids.org}','${ids.conversation}','${ids.session}','${ids.contact}',
        'text','outbound','sent','Private body','ai','2026-09-30T00:01:00Z',
        jsonb_build_object('idempotency_key','${ids.receipt}'));
    insert into public.send_ledger
      (id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
      values ('${ids.receipt}','${ids.org}','${ids.contact}','${ids.job}',1,
        encode(sha256(convert_to('Private body','UTF8')),'hex'),'accepted','${ids.message}');
    insert into public.messages
      (id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,external_id)
      values
        ('${ids.earlierInbound}','${ids.org}','${ids.conversation}','${ids.session}','${ids.contact}',
         'text','inbound','received','报价前的问题','2026-09-29T23:59:00Z','waha-before'),
        ('${ids.laterInbound}','${ids.org}','${ids.conversation}','${ids.session}','${ids.contact}',
         'text','inbound','received','我同意报价，但交期还要商量','2026-09-30T00:02:00Z','waha-after');
  `);
  const boundary = sql(`select public.fn_service_begin('${ids.org}','${ids.contact}')::text;`);
  sql(`
    insert into public.ai_reply_drafts
      (id,organization_id,conversation_id,contact_id,agent_id,agent_version_id,channel_session_id,
       service_boundary,context_revision,operation_revision,status,original_body,approved_body,
       approved_at,send_job_id,message_id,workbench_run_id,workbench_proposal_id)
      select '${ids.draft}','${ids.org}','${ids.conversation}','${ids.contact}',
        '${ids.agent}','${ids.version}','${ids.session}','${boundary}'::jsonb,
        c.reply_context_revision,a.operation_revision,'sent','Private draft','Private body',
        '2026-09-30T00:00:00Z','${ids.job}','${ids.message}','${ids.run}','${ids.proposal}'
      from public.conversations c, public.ai_agents a
      where c.id='${ids.conversation}' and a.id='${ids.agent}';
  `);
});

describe("mission delivery evidence on the real schema", () => {
  it("joins the accepted receipt and sent CRM message without exposing bodies or another tenant", async () => {
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 1,
    });
    try {
      const [evidence] = await loadMissionDeliveryEvidence(pool, ids.org, [ids.proposal]);
      expect(evidence).toMatchObject({
        proposalId: ids.proposal, status: "sent", messageId: ids.message,
        approvedBodyMatchesLedger: true,
        ledger: { idempotencyKey: ids.receipt, status: "accepted", messageId: ids.message },
        message: {
          id: ids.message, idempotencyKey: ids.receipt, status: "sent", sentVia: "ai",
          bodyMatchesLedger: true,
        },
      });
      expect(JSON.stringify(evidence)).not.toContain("Private");
      expect(await loadMissionDeliveryEvidence(pool, ids.otherOrg, [ids.proposal])).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it("loads only later customer-authored text for the verified send and tenant", async () => {
    const pool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 1,
    });
    try {
      const evidence = await loadCustomerAcceptanceMaterial(pool, ids.org, ids.contact,
        [ids.message], "客户同意报价和交期");
      expect(evidence.messages).toEqual([{
        id: ids.laterInbound,
        sentAt: "2026-09-30T00:02:00.000Z",
        body: "我同意报价，但交期还要商量",
      }]);
      expect(await loadCustomerAcceptanceMaterial(pool, ids.otherOrg, ids.contact,
        [ids.message], "客户同意报价和交期")).toEqual({
          criteria: "客户同意报价和交期", messages: [],
        });
    } finally {
      await pool.end();
    }
  });
});
