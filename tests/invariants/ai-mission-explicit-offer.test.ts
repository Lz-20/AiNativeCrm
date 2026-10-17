import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { evaluateExplicitOffer } from "@/lib/ai/evals/mission-explicit-offer-evidence";
import { issueMissionExplicitOffer } from "@/lib/ai/evals/mission-explicit-offer-service";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — run via `pnpm test:db`");
function sql(script: string): string {
  return execFileSync("docker", ["exec", "-i", container!, "psql", "-U", "postgres",
    "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
  { input: script, encoding: "utf8" }).trim();
}

const a = {
  org: "a4030000-0000-4000-8000-000000000001",
  user: "a4030000-1111-4000-8000-000000000001",
  session: "a4030000-2222-4000-8000-000000000001",
  contact: "a4030000-3333-4000-8000-000000000001",
  conversation: "a4030000-4444-4000-8000-000000000001",
  pipeline: "a4030000-5555-4000-8000-000000000001",
  stage: "a4030000-6666-4000-8000-000000000001",
  lead: "a4030000-7777-4000-8000-000000000001",
  agent: "a4030000-8888-4000-8000-000000000001",
  version: "a4030000-9999-4000-8000-000000000001",
  mission: "a4030000-aaaa-4000-8000-000000000001",
  run: "a4030000-bbbb-4000-8000-000000000001",
  proposal: "a4030000-cccc-4000-8000-000000000001",
  job: "a4030000-dddd-4000-8000-000000000001",
  ledger: "a4030000-eeee-4000-8000-000000000001",
  message: "a4030000-ffff-4000-8000-000000000001",
  draft: "a4030000-0000-4000-8000-000000000002",
  ambiguous: "a4030000-0000-4000-8000-000000000003",
  unattributed: "a4030000-0000-4000-8000-000000000004",
  accepted: "a4030000-0000-4000-8000-000000000005",
  request: "a4030000-0000-4000-8000-000000000006",
};
const b = {
  org: "b4030000-0000-4000-8000-000000000002",
  user: "b4030000-1111-4000-8000-000000000002",
};
const terms = { description: "500 件设备", amountMinor: 123450,
  currency: "CNY" as const, deliveryDate: "2026-10-15" };
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 2,
});

beforeAll(() => {
  sql(`
    insert into auth.users(id,email) values
      ('${a.user}','offer-a@invariant.test'),('${b.user}','offer-b@invariant.test');
    insert into public.organizations(id,slug,legal_name,display_name) values
      ('${a.org}','explicit-offer-a','Offer A','Offer A'),
      ('${b.org}','explicit-offer-b','Offer B','Offer B');
    insert into public.user_organizations(user_id,organization_id,role,accepted_at) values
      ('${a.user}','${a.org}','manager',now()),('${b.user}','${b.org}','manager',now());
    insert into public.channel_sessions
      (id,organization_id,waha_session_name,webhook_secret_encrypted)
      values ('${a.session}','${a.org}','offer-session','\\x00'::bytea);
    insert into public.contacts(id,organization_id,display_name)
      values ('${a.contact}','${a.org}','Offer contact');
    insert into public.conversations(id,organization_id,contact_id,channel_session_id)
      values ('${a.conversation}','${a.org}','${a.contact}','${a.session}');
    insert into public.crm_pipelines(id,organization_id,name,slug)
      values ('${a.pipeline}','${a.org}','Offers','offers');
    insert into public.crm_stages(id,organization_id,pipeline_id,name,slug,position)
      values ('${a.stage}','${a.org}','${a.pipeline}','Open','open',100);
    insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title)
      values ('${a.lead}','${a.org}','${a.pipeline}','${a.stage}','${a.contact}','Offer lead');
    insert into public.ai_agents(id,organization_id,name,system_prompt,operation_mode)
      values ('${a.agent}','${a.org}','Offer agent','Offer test','assisted');
    insert into public.ai_agent_versions
      (id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status)
      values ('${a.version}','${a.org}','${a.agent}',1,'Offer test','anthropic','test-model',
        '${a.session}','published');
    update public.ai_agents set published_version_id='${a.version}' where id='${a.agent}';
    insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria)
      values ('${a.mission}','${a.org}','${a.lead}','${a.user}',
        'Confirm offer','Customer confirms exact quote and delivery date');
    insert into public.ai_workbench_runs(id,organization_id,agent_id,mission_id,task,mode)
      values ('${a.run}','${a.org}','${a.agent}','${a.mission}','Send offer','act');
    insert into public.ai_agent_action_proposals
      (id,organization_id,run_id,sequence,tool_name,status)
      values ('${a.proposal}','${a.org}','${a.run}',1,'send_message','executed');
    insert into public.job_queue(id,organization_id,contact_id,kind)
      values ('${a.job}','${a.org}','${a.contact}','followup_turn');
  `);
});
afterAll(async () => { await pool.end(); });

describe("explicit offer acceptance on real CRM tables", () => {
  it("fixes terms and rejects cross-org, cross-conversation and conflicting retries", async () => {
    await expect(issueMissionExplicitOffer(pool, {
      organizationId: b.org, missionId: a.mission, actorUserId: b.user,
      conversationId: a.conversation, requestKey: a.request, terms,
    })).rejects.toMatchObject({ code: "not_found" });
    await expect(issueMissionExplicitOffer(pool, {
      organizationId: a.org, missionId: a.mission, actorUserId: a.user,
      conversationId: b.user, requestKey: a.request, terms,
    })).rejects.toMatchObject({ code: "conversation_invalid" });
    const issued = await issueMissionExplicitOffer(pool, {
      organizationId: a.org, missionId: a.mission, actorUserId: a.user,
      conversationId: a.conversation, requestKey: a.request, terms,
    });
    expect(issued.offerText).toContain("报价：CNY 1234.50");
    expect(issued.offerText).toContain("交期：2026-10-15");
    expect((await issueMissionExplicitOffer(pool, {
      organizationId: a.org, missionId: a.mission, actorUserId: a.user,
      conversationId: a.conversation, requestKey: a.request, terms,
    })).id).toBe(issued.id);
    await expect(issueMissionExplicitOffer(pool, {
      organizationId: a.org, missionId: a.mission, actorUserId: a.user,
      conversationId: a.conversation, requestKey: a.request,
      terms: { ...terms, amountMinor: 123451 },
    })).rejects.toMatchObject({ code: "request_conflict" });
    expect((await evaluateExplicitOffer(pool, a.org, a.mission)).verdict).toBe("not_sent");
    expect((await evaluateExplicitOffer(pool, b.org, a.mission)).verdict).toBe("not_issued");
  });

  it("requires exact approved delivery and a later channel-authored whole reply", async () => {
    const { rows: offers } = await pool.query<{ id: string; offer_text: string;
      acceptance_text: string }>(
      `select id,offer_text,acceptance_text from public.ai_mission_explicit_offers
       where organization_id=$1 and mission_id=$2`, [a.org, a.mission],
    );
    const offer = offers[0]!;
    await pool.query(
      `update public.ai_mission_explicit_offers
       set issued_at=now()-interval '10 minutes',
           expires_at=now()+interval '6 days'
       where id=$1`, [offer.id],
    );
    const { rows: boundaryRows } = await pool.query<{ boundary: unknown }>(
      `select public.fn_service_begin($1,$2) as boundary`, [a.org, a.contact],
    );
    await pool.query(
      `insert into public.messages
       (id,organization_id,conversation_id,channel_session_id,contact_id,type,
        direction,status,body,sent_via,sent_at,metadata)
       values ($1,$2,$3,$4,$5,'text','outbound','sent',$6,'ai',
         now()-interval '5 minutes',jsonb_build_object('idempotency_key',$7::text))`,
      [a.message, a.org, a.conversation, a.session, a.contact,
        offer.offer_text, a.ledger],
    );
    await pool.query(
      `insert into public.send_ledger
       (id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
       values ($1,$2,$3,$4,1,encode(sha256(convert_to($5,'UTF8')),'hex'),
         'accepted',$6)`,
      [a.ledger, a.org, a.contact, a.job, offer.offer_text, a.message],
    );
    await pool.query(
      `insert into public.ai_reply_drafts
       (id,organization_id,conversation_id,contact_id,agent_id,agent_version_id,
        channel_session_id,service_boundary,context_revision,operation_revision,
        status,original_body,approved_body,approved_at,send_job_id,message_id,
        workbench_run_id,workbench_proposal_id)
       select $1,$2,$3,$4,$5,$6,$7,$8::jsonb,c.reply_context_revision,
         agent.operation_revision,'sent',$9,$9,now()-interval '6 minutes',
         $10,$11,$12,$13
       from public.conversations c,public.ai_agents agent
       where c.id=$3 and agent.id=$5`,
      [a.draft, a.org, a.conversation, a.contact, a.agent, a.version,
        a.session, JSON.stringify(boundaryRows[0]!.boundary), offer.offer_text,
        a.job, a.message, a.run, a.proposal],
    );
    expect((await evaluateExplicitOffer(pool, a.org, a.mission)).verdict).toBe("awaiting_reply");
    await pool.query(
      `insert into public.messages
       (id,organization_id,conversation_id,channel_session_id,contact_id,type,
        direction,status,body,sent_at,external_id)
       values
       ($1,$3,$4,$5,$6,'text','inbound','received',$7,
         now()-interval '4 minutes','waha-ambiguous'),
       ($2,$3,$4,$5,$6,'text','inbound','received',$8,
         now()-interval '3 minutes',null)`,
      [a.ambiguous, a.unattributed, a.org, a.conversation, a.session,
        a.contact, `${offer.acceptance_text}，但交期另议`, offer.acceptance_text],
    );
    expect((await evaluateExplicitOffer(pool, a.org, a.mission)).verdict).toBe("awaiting_reply");
    await pool.query(
      `insert into public.messages
       (id,organization_id,conversation_id,channel_session_id,contact_id,type,
        direction,status,body,sent_at,external_id)
       values ($1,$2,$3,$4,$5,'text','inbound','received',$6,
         now()-interval '2 minutes','waha-accepted')`,
      [a.accepted, a.org, a.conversation, a.session, a.contact,
        offer.acceptance_text],
    );
    expect((await evaluateExplicitOffer(pool, a.org, a.mission)).verdict).toBe("unverified");
    await expect(pool.query(
      `insert into public.webhook_events_log
       (organization_id,channel_session_id,provider,raw_body,valid_signature,
        event_type,external_id,crm_inbound_message_id,received_at)
       values ($1,$2,'waha','{}',false,'message','waha-accepted',$3,now())`,
      [a.org, a.session, a.accepted],
    )).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `insert into public.webhook_events_log
       (organization_id,channel_session_id,provider,raw_body,valid_signature,
        event_type,external_id,received_at)
       values ($1,$2,'waha','{}',false,'message','waha-accepted',now())`,
      [a.org, a.session],
    );
    expect((await evaluateExplicitOffer(pool, a.org, a.mission)).verdict).toBe("unverified");
    await pool.query(
      `insert into public.webhook_events_log
       (organization_id,channel_session_id,provider,raw_body,valid_signature,
        event_type,external_id,received_at)
       values ($1,$2,'waha','{}',true,'message','waha-accepted',now())`,
      [b.org, a.session],
    );
    expect((await evaluateExplicitOffer(pool, a.org, a.mission)).verdict).toBe("unverified");
    await pool.query(
      `insert into public.webhook_events_log
       (organization_id,channel_session_id,provider,raw_body,valid_signature,
        event_type,external_id,received_at)
       values ($1,$2,'waha','{}',true,'message','waha-accepted',now())`,
      [a.org, a.session],
    );
    expect((await evaluateExplicitOffer(pool, a.org, a.mission)).verdict).toBe("unverified");
    await pool.query(
      `insert into public.webhook_events_log
       (organization_id,channel_session_id,provider,raw_body,valid_signature,
        event_type,external_id,crm_inbound_message_id,received_at)
       values ($1,$2,'waha','{}',true,'message','waha-accepted',$3,now())`,
      [a.org, a.session, a.accepted],
    );
    expect(await evaluateExplicitOffer(pool, a.org, a.mission)).toMatchObject({
      offerId: offer.id, verdict: "verified", structuredTermsAccepted: true,
      outboundMessageId: a.message, inboundMessageId: a.accepted,
      legalIdentityVerified: false, businessOutcomeVerified: false,
      terms,
    });
    await pool.query(`update public.messages set revoked_at=now() where id=$1`, [a.accepted]);
    expect((await evaluateExplicitOffer(pool, a.org, a.mission)).verdict).toBe("awaiting_reply");
    await pool.query(`update public.messages set revoked_at=null where id=$1`, [a.accepted]);
    await pool.query(`update public.ai_missions set direction_revision=direction_revision+1
      where id=$1`, [a.mission]);
    expect((await evaluateExplicitOffer(pool, a.org, a.mission)).verdict).toBe("superseded");
    expect(sql(`select has_table_privilege('authenticated',
      'public.ai_mission_explicit_offers','select')::text`)).toBe("false");
  });
});
