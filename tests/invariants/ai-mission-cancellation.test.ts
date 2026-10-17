import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertWorkbenchJobLease } from "@/lib/ai/agents/workbench-job-lease";
import {
  finalizeWorkbenchSendDecision, reconcileWorkbenchSendDecisions,
} from "@/lib/ai/agents/workbench-send-decision-recovery";
import { rejectWorkbenchProposal } from "@/lib/ai/agents/workbench-reject-decision";
import { ASK_INTERNAL_COLLEAGUE_TOOL } from "@/lib/ai/agents/internal-question-contract";
import {
  assertWorkbenchApprovedActionCurrent, claimWorkbenchApprovedAction,
  finishWorkbenchApprovedAction,
  markWorkbenchApprovedActionUncertain, reconcileStaleWorkbenchApprovedActions,
} from "@/lib/ai/agents/workbench-approved-action";
import { criarOrigemDeFollowup } from "./followup-service-origin";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 4,
});
const org = randomUUID();
const actor = randomUUID();
const contact = randomUUID();
const lead = randomUUID();
const agent = randomUUID();
const version = randomUUID();
let conversation = "";

beforeAll(async () => {
  await pool.query("insert into auth.users(id,email) values($1,$2)", [actor, `mission-cancel-${actor}@test.local`]);
  await pool.query(
    "insert into public.organizations(id,slug,legal_name,display_name) values($1,$2,'Mission Stop','Mission Stop')",
    [org, `mission-stop-${org.slice(0, 8)}`],
  );
  await pool.query(
    "insert into public.user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())",
    [actor, org],
  );
  const pipeline = randomUUID();
  const stage = randomUUID();
  await pool.query(
    "insert into public.crm_pipelines(id,organization_id,name,slug) values($1,$2,'Pipeline','mission-stop')",
    [pipeline, org],
  );
  await pool.query(
    "insert into public.crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Open','open',100)",
    [stage, org, pipeline],
  );
  await pool.query("insert into public.contacts(id,organization_id,name) values($1,$2,'Customer')", [contact, org]);
  await pool.query(
    "insert into public.crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,$5,'Quote')",
    [lead, org, pipeline, stage, contact],
  );
  conversation = (await criarOrigemDeFollowup(pool, org, contact)).conversation_id;
  const channel = (await pool.query<{ channel_session_id: string }>(
    "select channel_session_id from public.conversations where organization_id=$1 and id=$2",
    [org, conversation],
  )).rows[0]!.channel_session_id;
  await pool.query(
    "insert into public.ai_agents(id,organization_id,name,system_prompt) values($1,$2,'Agent','Read CRM facts')",
    [agent, org],
  );
  await pool.query(
    "insert into public.ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status) values($1,$2,$3,1,'Read CRM facts','anthropic','test-model',$4,'published')",
    [version, org, agent, channel],
  );
  await pool.query(
    "update public.ai_agents set published_version_id=$2 where organization_id=$1 and id=$3",
    [org, version, agent],
  );
});
afterAll(() => pool.end());

async function stagedMission() {
  const missionId = randomUUID();
  const runId = randomUUID();
  const proposalId = randomUUID();
  await pool.query(
    "insert into public.ai_missions(id,organization_id,lead_id,actor_user_id,goal,acceptance_criteria) values($1,$2,$3,$4,'Confirm quote','Customer confirms quote')",
    [missionId, org, lead, actor],
  );
  await pool.query(
    "insert into public.ai_workbench_runs(id,organization_id,agent_id,mission_id,actor_user_id,task,mode,status,scope,runtime_state) values($1,$2,$3,$4,$5,'Confirm quote','act','running',$6::jsonb,$7::jsonb)",
    [runId, org, agent, missionId, actor,
      JSON.stringify({ conversationId: conversation, contactId: contact, leadId: lead }),
      JSON.stringify({ versionId: version })],
  );
  await pool.query(
    "insert into public.ai_agent_action_proposals(id,organization_id,run_id,sequence,tool_name,tool_args) values($1,$2,$3,1,'send_message',$4::jsonb)",
    [proposalId, org, runId, JSON.stringify({ body: "Approved quote" })],
  );
  // The CRM permits only one draft per conversation/agent/context revision.
  // A separate delegated mission is a new customer context, not a duplicate
  // attempt to stage a second draft against the old revision.
  await pool.query(
    "update public.conversations set reply_context_revision=reply_context_revision+1 where organization_id=$1 and id=$2",
    [org, conversation],
  );
  const contextRevision = (await pool.query<{ reply_context_revision: number }>(
    "select reply_context_revision from public.conversations where organization_id=$1 and id=$2",
    [org, conversation],
  )).rows[0]!.reply_context_revision;
  const operationRevision = (await pool.query<{ operation_revision: number }>(
    "select operation_revision from public.ai_agents where organization_id=$1 and id=$2",
    [org, agent],
  )).rows[0]!.operation_revision;
  const { rows } = await pool.query<{ draft_id: string }>(
    "select public.fn_reply_workbench_stage($1,$2,$3,$4,$5,$6,$7) as draft_id",
    [org, runId, proposalId, version, contextRevision, operationRevision, "Approved quote"],
  );
  await pool.query(
    "update public.ai_workbench_runs set status='awaiting_confirmation' where organization_id=$1 and id=$2",
    [org, runId],
  );
  await pool.query(
    `insert into public.ai_agent_run_states(organization_id,run_id,messages)
     values ($1,$2,$3::jsonb)`,
    [org, runId, JSON.stringify([
      { role: "user", content: "请核对报价并准备客户回复" },
      { role: "assistant", content: "草稿已提出，等待人工确认" },
    ])],
  );
  return { missionId, runId, proposalId, draftId: rows[0]!.draft_id };
}

async function stagedNonSendMission(toolName = "crm_request_human_handoff") {
  const f = await stagedMission();
  await pool.query(
    "delete from public.ai_reply_drafts where organization_id=$1 and id=$2",
    [org, f.draftId],
  );
  await pool.query(
    `update public.ai_agent_action_proposals
     set tool_name=$3,tool_args=$4::jsonb,preview=$5::jsonb
     where organization_id=$1 and id=$2`,
    [org, f.proposalId, toolName,
      JSON.stringify({ question: "Sensitive CRM customer context" }),
      JSON.stringify({ summary: "Sensitive CRM customer context" })],
  );
  return f;
}

async function current(draftId: string): Promise<boolean> {
  const { rows } = await pool.query<{ current: boolean }>(
    "select public.fn_reply_context_current($1,$2) as current", [org, draftId],
  );
  return rows[0]!.current;
}

async function cancel(missionId: string, organizationId = org) {
  const { rows } = await pool.query<{ result: string }>(
    "select public.fn_cancel_ai_mission($1,$2,$3,$4) as result",
    [organizationId, missionId, actor, "Sales owner took over"],
  );
  return rows[0]!.result;
}

async function sendCommand(missionId: string, key: string, kind: string,
  reason = "Verify revised quote before sending", organizationId = org, userId = actor) {
  const { rows } = await pool.query<{ result: {
    result: string; paused?: boolean; revision?: number; commandId?: number;
  } }>(
    "select public.fn_set_ai_mission_send_policy($1,$2,$3,$4,$5,$6) as result",
    [organizationId, missionId, userId, key, kind, reason],
  );
  return rows[0]!.result;
}

describe("Mission cancellation fences customer delivery", () => {
  it("commits a known approved-tool result with its Pi observation and resume job", async () => {
    const f = await stagedNonSendMission();
    const input = { organizationId: org, runId: f.runId, proposalId: f.proposalId,
      toolName: "crm_request_human_handoff", actorUserId: actor };
    try {
      expect(await claimWorkbenchApprovedAction(pool, input)).toBe(true);
      expect(await claimWorkbenchApprovedAction(pool, input)).toBe(false);
      expect(await finishWorkbenchApprovedAction(pool, {
        ...input, result: { kind: "success", output: { handoff_recorded: true } },
      })).toBe("queued");
      const { rows } = await pool.query<{
        proposal_status: string; run_status: string; resume_count: number;
        observation: string; event_count: number;
      }>(
        `select p.status as proposal_status,r.status as run_status,
                (select count(*)::int from public.job_queue j
                 where j.organization_id=$1 and j.kind='workbench_resume'
                   and j.source_event_id=$2) as resume_count,
                (select messages->-1->>'content' from public.ai_agent_run_states s
                 where s.organization_id=$1 and s.run_id=$3) as observation,
                (select count(*)::int from public.ai_agent_run_events e
                 where e.organization_id=$1 and e.run_id=$3) as event_count
         from public.ai_agent_action_proposals p
         join public.ai_workbench_runs r on r.id=p.run_id
         where p.organization_id=$1 and p.id=$2`,
        [org, f.proposalId, f.runId],
      );
      expect(rows[0]).toMatchObject({ proposal_status: "executed", run_status: "running",
        resume_count: 1, event_count: 6 });
      expect(rows[0]?.observation).toContain('"handoff_recorded":true');
      expect(await finishWorkbenchApprovedAction(pool, {
        ...input, result: { kind: "success", output: { handoff_recorded: true } },
      })).toBeNull();
    } finally {
      await cancel(f.missionId);
    }
  });

  it("does not guess a tool result when HTTP dies after approval claim", async () => {
    const f = await stagedNonSendMission();
    const input = { organizationId: org, runId: f.runId, proposalId: f.proposalId,
      toolName: "crm_request_human_handoff", actorUserId: actor };
    try {
      expect(await claimWorkbenchApprovedAction(pool, input)).toBe(true);
      await pool.query(
        `update public.ai_agent_action_proposals
         set decision_at=now()-interval '7 minutes'
         where organization_id=$1 and id=$2`,
        [org, f.proposalId],
      );
      expect(await reconcileStaleWorkbenchApprovedActions(pool)).toBeGreaterThanOrEqual(1);
      const { rows } = await pool.query<{
        proposal_status: string; result_summary: { outcome: string; code: string };
        run_status: string; error_code: string; resume_count: number;
        event_status: string;
      }>(
        `select p.status as proposal_status,p.result_summary,r.status as run_status,r.error_code,
                (select count(*)::int from public.job_queue j
                 where j.organization_id=$1 and j.kind='workbench_resume'
                   and j.source_event_id=$2) as resume_count,
                (select payload->>'status' from public.ai_agent_run_events e
                 where e.organization_id=$1 and e.run_id=$3
                   and e.event_type='tool_completed' order by e.sequence desc limit 1)
                   as event_status
         from public.ai_agent_action_proposals p
         join public.ai_workbench_runs r on r.id=p.run_id
         where p.organization_id=$1 and p.id=$2`,
        [org, f.proposalId, f.runId],
      );
      expect(rows[0]).toMatchObject({ proposal_status: "failed",
        result_summary: { outcome: "reconciliation_required", code: "effect_may_have_completed" },
        run_status: "partial", error_code: "approved_action_outcome_unknown",
        resume_count: 0, event_status: "unknown" });
      expect(await reconcileStaleWorkbenchApprovedActions(pool)).toBe(0);
      expect(await markWorkbenchApprovedActionUncertain(pool, {
        organizationId: randomUUID(), runId: f.runId, proposalId: f.proposalId,
      })).toBe(false);
    } finally {
      await cancel(f.missionId);
    }
  });

  it("rolls back the known result when enqueueing Pi continuation fails", async () => {
    const f = await stagedNonSendMission();
    const input = { organizationId: org, runId: f.runId, proposalId: f.proposalId,
      toolName: "crm_request_human_handoff", actorUserId: actor };
    try {
      expect(await claimWorkbenchApprovedAction(pool, input)).toBe(true);
      await pool.query(
        `insert into public.job_queue
         (organization_id,kind,source_event_id,payload,max_attempts)
         values ($1,'workbench_resume',$2,jsonb_build_object('runId',$3::uuid),3)`,
        [org, f.proposalId, randomUUID()],
      );
      await expect(finishWorkbenchApprovedAction(pool, {
        ...input, result: { kind: "success", output: { handoff_recorded: true } },
      })).rejects.toThrow();
      const { rows } = await pool.query<{
        proposal_status: string; run_status: string; event_count: number;
        messages_count: number;
      }>(
        `select p.status as proposal_status,r.status as run_status,
                (select count(*)::int from public.ai_agent_run_events e
                 where e.organization_id=$1 and e.run_id=$2) as event_count,
                (select jsonb_array_length(messages) from public.ai_agent_run_states s
                 where s.organization_id=$1 and s.run_id=$2) as messages_count
         from public.ai_agent_action_proposals p
         join public.ai_workbench_runs r on r.id=p.run_id
         where p.organization_id=$1 and p.id=$3`,
        [org, f.runId, f.proposalId],
      );
      expect(rows[0]).toEqual({ proposal_status: "approved", run_status: "running",
        event_count: 3, messages_count: 2 });
      expect(await markWorkbenchApprovedActionUncertain(pool, input)).toBe(true);
    } finally {
      await cancel(f.missionId);
    }
  });

  it("continues Pi after a proven pre-effect failure without claiming CRM success", async () => {
    const f = await stagedNonSendMission();
    const input = { organizationId: org, runId: f.runId, proposalId: f.proposalId,
      toolName: "crm_request_human_handoff", actorUserId: actor };
    try {
      expect(await claimWorkbenchApprovedAction(pool, input)).toBe(true);
      expect(await finishWorkbenchApprovedAction(pool, {
        ...input, result: { kind: "safe_failure", code: "approval_no_longer_current" },
      })).toBe("queued");
      const { rows } = await pool.query<{ status: string; observation: string;
        resume_count: number }>(
        `select p.status,
                (select messages->-1->>'content' from public.ai_agent_run_states s
                 where s.organization_id=$1 and s.run_id=$2) as observation,
                (select count(*)::int from public.job_queue j
                 where j.organization_id=$1 and j.source_event_id=$3
                   and j.kind='workbench_resume') as resume_count
         from public.ai_agent_action_proposals p
         where p.organization_id=$1 and p.id=$3`,
        [org, f.runId, f.proposalId],
      );
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.observation).toContain("approval_no_longer_current");
      expect(rows[0]?.resume_count).toBe(1);
    } finally {
      await cancel(f.missionId);
    }
  });

  it("closes other pending actions and drafts when an approved effect is unknown", async () => {
    const f = await stagedMission();
    const approvedProposalId = randomUUID();
    await pool.query(
      `insert into public.ai_agent_action_proposals
       (id,organization_id,run_id,sequence,tool_name,tool_args)
       values ($1,$2,$3,2,'crm_request_human_handoff','{}'::jsonb)`,
      [approvedProposalId, org, f.runId],
    );
    try {
      expect(await claimWorkbenchApprovedAction(pool, {
        organizationId: org, runId: f.runId, proposalId: approvedProposalId,
        toolName: "crm_request_human_handoff", actorUserId: actor,
      })).toBe(true);
      expect(await markWorkbenchApprovedActionUncertain(pool, {
        organizationId: org, runId: f.runId, proposalId: approvedProposalId,
      })).toBe(true);
      const { rows } = await pool.query<{ pending_status: string; draft_status: string;
        run_status: string }>(
        `select p.status as pending_status,d.status as draft_status,r.status as run_status
         from public.ai_agent_action_proposals p
         join public.ai_reply_drafts d
           on d.organization_id=p.organization_id and d.workbench_proposal_id=p.id
         join public.ai_workbench_runs r on r.id=p.run_id
         where p.organization_id=$1 and p.id=$2`,
        [org, f.proposalId],
      );
      expect(rows[0]).toEqual({ pending_status: "cancelled", draft_status: "stale",
        run_status: "partial" });
    } finally {
      await cancel(f.missionId);
    }
  });

  it("records a known in-flight effect without reviving a cancelled Mission", async () => {
    const f = await stagedNonSendMission();
    const input = { organizationId: org, runId: f.runId, proposalId: f.proposalId,
      toolName: "crm_request_human_handoff", actorUserId: actor };
    expect(await claimWorkbenchApprovedAction(pool, input)).toBe(true);
    expect(await cancel(f.missionId)).toBe("cancelled");
    await expect(assertWorkbenchApprovedActionCurrent(pool, input))
      .rejects.toThrow("workbench_approved_action_no_longer_current");
    expect(await finishWorkbenchApprovedAction(pool, {
      ...input, result: { kind: "success", output: { handoff_recorded: true } },
    })).toBe("cancelled");
    const { rows } = await pool.query<{ proposal_status: string; run_status: string;
      resume_count: number }>(
      `select p.status as proposal_status,r.status as run_status,
              (select count(*)::int from public.job_queue j
               where j.organization_id=$1 and j.kind='workbench_resume'
                 and j.source_event_id=$2) as resume_count
       from public.ai_agent_action_proposals p
       join public.ai_workbench_runs r on r.id=p.run_id
       where p.organization_id=$1 and p.id=$2`,
      [org, f.proposalId],
    );
    expect(rows[0]).toEqual({ proposal_status: "executed", run_status: "cancelled",
      resume_count: 0 });
  });

  it("does not commit a customer send when the Run is no longer awaiting confirmation", async () => {
    const f = await stagedMission();
    await pool.query(
      "update public.ai_workbench_runs set status='running' where organization_id=$1 and id=$2",
      [org, f.runId],
    );
    const userDb = await pool.connect();
    try {
      await userDb.query("begin");
      await userDb.query("set local role authenticated");
      await userDb.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: actor, role: "authenticated", aal: "aal1" }),
      ]);
      await expect(userDb.query(
        "select public.fn_reply_action($1,$2,'1','approve',$3,null)",
        [org, f.draftId, "Approved quote"],
      )).rejects.toThrow(/workbench_reply_run_stale/);
      await userDb.query("rollback");
      const { rows } = await pool.query<{
        draft_status: string; proposal_status: string; send_job_id: string | null;
      }>(
        `select d.status as draft_status,p.status as proposal_status,d.send_job_id
         from public.ai_reply_drafts d
         join public.ai_agent_action_proposals p
           on p.organization_id=d.organization_id and p.id=d.workbench_proposal_id
         where d.organization_id=$1 and d.id=$2`,
        [org, f.draftId],
      );
      expect(rows[0]).toEqual({ draft_status: "pending", proposal_status: "pending",
        send_job_id: null });
    } finally {
      userDb.release();
      await cancel(f.missionId);
    }
  });

  it("rejects a non-send proposal, observes it and queues Pi resume atomically", async () => {
    const f = await stagedNonSendMission();
    try {
      expect(await rejectWorkbenchProposal(pool, {
        organizationId: org, runId: f.runId, proposalId: f.proposalId,
        actorUserId: actor, reason: "客户明确要求人工接管",
      })).toMatchObject({ outcome: "queued", toolName: "crm_request_human_handoff" });
      const { rows } = await pool.query<{
        proposal_status: string; run_status: string; resume_count: number;
        observation: string; event_count: number;
      }>(
        `select p.status as proposal_status,r.status as run_status,
                (select count(*)::int from public.job_queue j
                 where j.organization_id=$1 and j.kind='workbench_resume'
                   and j.source_event_id=$2) as resume_count,
                (select messages->-1->>'content' from public.ai_agent_run_states s
                 where s.organization_id=$1 and s.run_id=$3) as observation,
                (select count(*)::int from public.ai_agent_run_events e
                 where e.organization_id=$1 and e.run_id=$3) as event_count
         from public.ai_agent_action_proposals p
         join public.ai_workbench_runs r on r.id=p.run_id
         where p.organization_id=$1 and p.id=$2`,
        [org, f.proposalId, f.runId],
      );
      expect(rows[0]).toMatchObject({ proposal_status: "rejected", run_status: "running",
        resume_count: 1, event_count: 3 });
      expect(rows[0]?.observation).toContain('"status":"rejected"');
      expect(await rejectWorkbenchProposal(pool, {
        organizationId: org, runId: f.runId, proposalId: f.proposalId,
        actorUserId: actor,
      })).toBeNull();
      expect(await rejectWorkbenchProposal(pool, {
        organizationId: randomUUID(), runId: f.runId, proposalId: f.proposalId,
        actorUserId: actor,
      })).toBeNull();
    } finally {
      await cancel(f.missionId);
    }
  });

  it("keeps another proposal pending and redacts a rejected internal question", async () => {
    const f = await stagedNonSendMission(ASK_INTERNAL_COLLEAGUE_TOOL);
    await pool.query(
      `insert into public.ai_agent_action_proposals
       (id,organization_id,run_id,sequence,tool_name,tool_args)
       values ($1,$2,$3,2,'crm_request_human_handoff','{}'::jsonb)`,
      [randomUUID(), org, f.runId],
    );
    try {
      expect(await rejectWorkbenchProposal(pool, {
        organizationId: org, runId: f.runId, proposalId: f.proposalId,
        actorUserId: actor,
      })).toMatchObject({ outcome: "awaiting_confirmation" });
      const { rows } = await pool.query<{
        status: string; tool_args: object; preview: { redacted: boolean }; run_status: string;
        resume_count: number;
      }>(
        `select p.status,p.tool_args,p.preview,r.status as run_status,
                (select count(*)::int from public.job_queue j
                 where j.organization_id=$1 and j.kind='workbench_resume'
                   and j.source_event_id=$2) as resume_count
         from public.ai_agent_action_proposals p
         join public.ai_workbench_runs r on r.id=p.run_id
         where p.organization_id=$1 and p.id=$2`,
        [org, f.proposalId],
      );
      expect(rows[0]).toMatchObject({ status: "rejected", tool_args: {},
        preview: { redacted: true }, run_status: "awaiting_confirmation", resume_count: 0 });
    } finally {
      await cancel(f.missionId);
    }
  });

  it("rolls back rejection if its durable resume job cannot be inserted", async () => {
    const f = await stagedNonSendMission();
    await pool.query(
      `insert into public.job_queue
       (organization_id,kind,source_event_id,payload,max_attempts)
       values ($1,'workbench_resume',$2,jsonb_build_object('runId',$3::uuid),3)`,
      [org, f.proposalId, randomUUID()],
    );
    try {
      await expect(rejectWorkbenchProposal(pool, {
        organizationId: org, runId: f.runId, proposalId: f.proposalId,
        actorUserId: actor,
      })).rejects.toThrow();
      const { rows } = await pool.query<{ proposal_status: string; run_status: string;
        event_count: number; messages_count: number }>(
        `select p.status as proposal_status,r.status as run_status,
                (select count(*)::int from public.ai_agent_run_events e
                 where e.organization_id=$1 and e.run_id=$2) as event_count,
                (select jsonb_array_length(messages) from public.ai_agent_run_states s
                 where s.organization_id=$1 and s.run_id=$2) as messages_count
         from public.ai_agent_action_proposals p
         join public.ai_workbench_runs r on r.id=p.run_id
         where p.organization_id=$1 and p.id=$3`,
        [org, f.runId, f.proposalId],
      );
      expect(rows[0]).toEqual({ proposal_status: "pending",
        run_status: "awaiting_confirmation", event_count: 0, messages_count: 2 });
    } finally {
      await cancel(f.missionId);
    }
  });

  it("ends partial without a resume job when rejection finds no Pi state", async () => {
    const f = await stagedNonSendMission();
    await pool.query(
      "delete from public.ai_agent_run_states where organization_id=$1 and run_id=$2",
      [org, f.runId],
    );
    try {
      expect(await rejectWorkbenchProposal(pool, {
        organizationId: org, runId: f.runId, proposalId: f.proposalId,
        actorUserId: actor,
      })).toMatchObject({ outcome: "partial" });
      const { rows } = await pool.query<{ proposal_status: string; run_status: string;
        error_code: string; resume_count: number }>(
        `select p.status as proposal_status,r.status as run_status,r.error_code,
                (select count(*)::int from public.job_queue j
                 where j.organization_id=$1 and j.kind='workbench_resume'
                   and j.source_event_id=$2) as resume_count
         from public.ai_agent_action_proposals p
         join public.ai_workbench_runs r on r.id=p.run_id
         where p.organization_id=$1 and p.id=$2`,
        [org, f.proposalId],
      );
      expect(rows[0]).toEqual({ proposal_status: "rejected", run_status: "partial",
        error_code: "resume_state_missing", resume_count: 0 });
    } finally {
      await cancel(f.missionId);
    }
  });

  it("keeps send-decision recovery receipts service-only", async () => {
    const { rows } = await pool.query<{
      anon_select: boolean; user_select: boolean; user_insert: boolean; service_insert: boolean;
    }>(
      `select
         has_table_privilege('anon','public.ai_workbench_send_decision_receipts','select') as anon_select,
         has_table_privilege('authenticated','public.ai_workbench_send_decision_receipts','select') as user_select,
         has_table_privilege('authenticated','public.ai_workbench_send_decision_receipts','insert') as user_insert,
         has_table_privilege('service_role','public.ai_workbench_send_decision_receipts','insert') as service_insert`,
    );
    expect(rows[0]).toEqual({ anon_select: false, user_select: false,
      user_insert: false, service_insert: true });
  });

  it("recovers a committed reply approval after the HTTP process dies before Pi resume", async () => {
    const f = await stagedMission();
    const userDb = await pool.connect();
    let sendJobId = "";
    try {
      await userDb.query("begin");
      await userDb.query("set local role authenticated");
      await userDb.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: actor, role: "authenticated", aal: "aal1" }),
      ]);
      const { rows } = await userDb.query<{ job_id: string }>(
        "select public.fn_reply_action($1,$2,'1','approve',$3,null) as job_id",
        [org, f.draftId, "Approved quote"],
      );
      sendJobId = rows[0]!.job_id;
      await userDb.query("commit");
    } catch (error) {
      await userDb.query("rollback");
      throw error;
    } finally {
      userDb.release();
    }
    try {
      // Simulate the HTTP process disappearing immediately after the RPC.
      await pool.query(
        `update public.ai_agent_action_proposals
         set decision_at=now()-interval '10 seconds'
         where organization_id=$1 and id=$2`,
        [org, f.proposalId],
      );
      expect(await reconcileWorkbenchSendDecisions(pool)).toBeGreaterThanOrEqual(1);
      const { rows } = await pool.query<{
        receipt_count: number; resume_count: number; send_count: number;
        messages: Array<{ role: string; content: string }>;
        event_count: number; resume_job_id: string;
      }>(
        `select
          (select count(*)::int from public.ai_workbench_send_decision_receipts
           where organization_id=$1 and proposal_id=$2) as receipt_count,
          (select count(*)::int from public.job_queue
           where organization_id=$1 and kind='workbench_resume'
             and source_event_id=$2) as resume_count,
          (select count(*)::int from public.job_queue
           where organization_id=$1 and kind='approved_reply' and id=$3) as send_count,
          (select messages from public.ai_agent_run_states
           where organization_id=$1 and run_id=$4) as messages,
          (select count(*)::int from public.ai_agent_run_events
           where organization_id=$1 and run_id=$4
             and event_type='human_confirmation_received') as event_count,
          (select resume_job_id::text from public.ai_workbench_send_decision_receipts
           where organization_id=$1 and proposal_id=$2) as resume_job_id`,
        [org, f.proposalId, sendJobId, f.runId],
      );
      expect(rows[0]).toMatchObject({ receipt_count: 1, resume_count: 1,
        send_count: 1, event_count: 1 });
      expect(rows[0]?.resume_job_id).toBeTruthy();
      expect(rows[0]?.messages.at(-1)?.content).toContain("CRM Harness 执行动作后的观察结果");
      expect(rows[0]?.messages.at(-1)?.content).toContain(sendJobId);
      expect(await finalizeWorkbenchSendDecision(pool, {
        organizationId: org, runId: f.runId, proposalId: f.proposalId,
      })).toMatchObject({ replayed: true, outcome: "queued" });
      expect(await finalizeWorkbenchSendDecision(pool, {
        organizationId: randomUUID(), runId: f.runId, proposalId: f.proposalId,
      })).toBeNull();
      expect(await reconcileWorkbenchSendDecisions(pool)).toBe(0);
    } finally {
      await cancel(f.missionId);
    }
  });

  it("records partial instead of inventing a Pi continuation when private state is lost", async () => {
    const f = await stagedMission();
    await pool.query(
      "delete from public.ai_agent_run_states where organization_id=$1 and run_id=$2",
      [org, f.runId],
    );
    const userDb = await pool.connect();
    try {
      await userDb.query("begin");
      await userDb.query("set local role authenticated");
      await userDb.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: actor, role: "authenticated", aal: "aal1" }),
      ]);
      await userDb.query(
        "select public.fn_reply_action($1,$2,'1','approve',$3,null)",
        [org, f.draftId, "Approved quote"],
      );
      await userDb.query("commit");
    } catch (error) {
      await userDb.query("rollback");
      throw error;
    } finally {
      userDb.release();
    }
    try {
      expect(await finalizeWorkbenchSendDecision(pool, {
        organizationId: org, runId: f.runId, proposalId: f.proposalId,
      })).toMatchObject({ outcome: "partial", resumeJobId: null });
      const { rows } = await pool.query<{ status: string; error_code: string; resume_count: number }>(
        `select r.status,r.error_code,
                (select count(*)::int from public.job_queue j
                 where j.organization_id=$1 and j.source_event_id=$2
                   and j.kind='workbench_resume') as resume_count
         from public.ai_workbench_runs r
         where r.organization_id=$1 and r.id=$3`,
        [org, f.proposalId, f.runId],
      );
      expect(rows[0]).toEqual({ status: "partial", error_code: "resume_state_missing",
        resume_count: 0 });
    } finally {
      await cancel(f.missionId);
    }
  });

  it("resumes from a rejected reply without creating a customer send", async () => {
    const f = await stagedMission();
    const userDb = await pool.connect();
    try {
      await userDb.query("begin");
      await userDb.query("set local role authenticated");
      await userDb.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: actor, role: "authenticated", aal: "aal1" }),
      ]);
      await userDb.query(
        "select public.fn_reply_action($1,$2,'1','reject',null,$3)",
        [org, f.draftId, "报价依据不足"],
      );
      await userDb.query("commit");
    } catch (error) {
      await userDb.query("rollback");
      throw error;
    } finally {
      userDb.release();
    }
    try {
      expect(await finalizeWorkbenchSendDecision(pool, {
        organizationId: org, runId: f.runId, proposalId: f.proposalId,
      })).toMatchObject({ decision: "reject", outcome: "queued" });
      const { rows } = await pool.query<{
        send_count: number; resume_count: number; observation: string;
      }>(
        `select
          (select count(*)::int from public.job_queue j
           join public.ai_reply_drafts d on d.organization_id=j.organization_id
             and d.send_job_id=j.id
           where d.organization_id=$1 and d.id=$2) as send_count,
          (select count(*)::int from public.job_queue
           where organization_id=$1 and kind='workbench_resume'
             and source_event_id=$3) as resume_count,
          (select messages->-1->>'content' from public.ai_agent_run_states
           where organization_id=$1 and run_id=$4) as observation`,
        [org, f.draftId, f.proposalId, f.runId],
      );
      expect(rows[0]).toMatchObject({ send_count: 0, resume_count: 1 });
      expect(rows[0]?.observation).toContain('"status":"rejected"');
    } finally {
      await cancel(f.missionId);
    }
  });

  it("keeps the run waiting when another proposal still needs a human decision", async () => {
    const f = await stagedMission();
    const otherProposal = randomUUID();
    await pool.query(
      `insert into public.ai_agent_action_proposals
       (id,organization_id,run_id,sequence,tool_name,tool_args)
       values ($1,$2,$3,2,'crm_request_human_handoff','{}'::jsonb)`,
      [otherProposal, org, f.runId],
    );
    const userDb = await pool.connect();
    try {
      await userDb.query("begin");
      await userDb.query("set local role authenticated");
      await userDb.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: actor, role: "authenticated", aal: "aal1" }),
      ]);
      await userDb.query(
        "select public.fn_reply_action($1,$2,'1','reject',null,$3)",
        [org, f.draftId, "稍后再回复客户"],
      );
      await userDb.query("commit");
    } catch (error) {
      await userDb.query("rollback");
      throw error;
    } finally {
      userDb.release();
    }
    try {
      expect(await finalizeWorkbenchSendDecision(pool, {
        organizationId: org, runId: f.runId, proposalId: f.proposalId,
      })).toMatchObject({ outcome: "awaiting_confirmation", resumeJobId: null });
      const { rows } = await pool.query<{ run_status: string; resume_count: number }>(
        `select r.status as run_status,
                (select count(*)::int from public.job_queue
                 where organization_id=$1 and source_event_id=$2
                   and kind='workbench_resume') as resume_count
         from public.ai_workbench_runs r where r.organization_id=$1 and r.id=$3`,
        [org, f.proposalId, f.runId],
      );
      expect(rows[0]).toEqual({ run_status: "awaiting_confirmation", resume_count: 0 });
    } finally {
      await cancel(f.missionId);
    }
  });

  it("persists an idempotent send pause and resumes policy without replaying commands", async () => {
    const f = await stagedMission();
    const pauseKey = randomUUID();
    const resumeKey = randomUUID();
    try {
      expect(await current(f.draftId)).toBe(true);
      expect(await sendCommand(randomUUID(), randomUUID(), "pause_customer_send"))
        .toMatchObject({ result: "not_found" });
      expect(await sendCommand(f.missionId, randomUUID(), "pause_customer_send",
        undefined, org, randomUUID())).toMatchObject({ result: "unauthorized" });
      expect(await sendCommand(f.missionId, pauseKey, "pause_customer_send"))
        .toMatchObject({ result: "changed", paused: true, revision: 1 });
      expect(await current(f.draftId)).toBe(false);
      expect(await sendCommand(f.missionId, pauseKey, "pause_customer_send"))
        .toMatchObject({ result: "replayed", paused: true, revision: 1 });
      expect(await sendCommand(f.missionId, pauseKey, "resume_customer_send"))
        .toMatchObject({ result: "source_conflict" });
      expect(await sendCommand(f.missionId, resumeKey, "resume_customer_send"))
        .toMatchObject({ result: "changed", paused: false, revision: 2 });
      expect(await current(f.draftId)).toBe(true); // still pending, requires human approval
      expect(await sendCommand(f.missionId, pauseKey, "pause_customer_send"))
        .toMatchObject({ result: "replayed", paused: false, revision: 2 });
      const { rows } = await pool.query<{ kind: string; paused_after: boolean; policy_revision: string }>(
        `select kind,paused_after,policy_revision from public.ai_mission_commands
         where organization_id=$1 and mission_id=$2 order by id`,
        [org, f.missionId],
      );
      expect(rows).toMatchObject([
        { kind: "pause_customer_send", paused_after: true },
        { kind: "resume_customer_send", paused_after: false },
      ]);
    } finally {
      await cancel(f.missionId);
    }
  });

  it("revokes an approved queued send so resume cannot resurrect old approval", async () => {
    const f = await stagedMission();
    const userDb = await pool.connect();
    let jobId = "";
    try {
      await userDb.query("begin");
      await userDb.query("set local role authenticated");
      await userDb.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: actor, role: "authenticated", aal: "aal1" }),
      ]);
      const { rows } = await userDb.query<{ job_id: string }>(
        "select public.fn_reply_action($1,$2,'1','approve',$3,null) as job_id",
        [org, f.draftId, "Approved quote"],
      );
      jobId = rows[0]!.job_id;
      await userDb.query("commit");
    } catch (error) {
      await userDb.query("rollback");
      throw error;
    } finally {
      userDb.release();
    }
    try {
      expect(await current(f.draftId)).toBe(true);
      expect(await sendCommand(f.missionId, randomUUID(), "pause_customer_send"))
        .toMatchObject({ result: "changed", paused: true });
      const { rows } = await pool.query<{ draft_status: string; job_status: string }>(
        `select d.status as draft_status,j.status as job_status
         from public.ai_reply_drafts d join public.job_queue j
           on j.organization_id=d.organization_id and j.id=d.send_job_id
         where d.organization_id=$1 and d.id=$2 and j.id=$3`,
        [org, f.draftId, jobId],
      );
      expect(rows[0]).toEqual({ draft_status: "stale", job_status: "failed" });
      expect(await sendCommand(f.missionId, randomUUID(), "resume_customer_send"))
        .toMatchObject({ result: "changed", paused: false });
      expect(await current(f.draftId)).toBe(false);
    } finally {
      await cancel(f.missionId);
    }
  });

  it("keeps an in-flight draft reconcilable but never reauthorizes it after resume", async () => {
    const f = await stagedMission();
    const userDb = await pool.connect();
    let jobId = "";
    try {
      await userDb.query("begin");
      await userDb.query("set local role authenticated");
      await userDb.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: actor, role: "authenticated", aal: "aal1" }),
      ]);
      const { rows } = await userDb.query<{ job_id: string }>(
        "select public.fn_reply_action($1,$2,'1','approve',$3,null) as job_id",
        [org, f.draftId, "Approved quote"],
      );
      jobId = rows[0]!.job_id;
      await userDb.query("commit");
    } catch (error) {
      await userDb.query("rollback");
      throw error;
    } finally {
      userDb.release();
    }
    try {
      await pool.query(
        "update public.ai_reply_drafts set status='sending' where organization_id=$1 and id=$2",
        [org, f.draftId],
      );
      await pool.query(
        "update public.job_queue set status='running',locked_by='test',locked_at=now() where organization_id=$1 and id=$2",
        [org, jobId],
      );
      expect(await current(f.draftId)).toBe(true);
      expect(await sendCommand(f.missionId, randomUUID(), "pause_customer_send"))
        .toMatchObject({ result: "changed", paused: true });
      const { rows } = await pool.query<{ draft_status: string; job_status: string }>(
        `select d.status as draft_status,j.status as job_status
         from public.ai_reply_drafts d join public.job_queue j
           on j.organization_id=d.organization_id and j.id=d.send_job_id
         where d.organization_id=$1 and d.id=$2`,
        [org, f.draftId],
      );
      expect(rows[0]).toEqual({ draft_status: "sending", job_status: "running" });
      expect(await current(f.draftId)).toBe(false);
      expect(await sendCommand(f.missionId, randomUUID(), "resume_customer_send"))
        .toMatchObject({ result: "changed", paused: false });
      expect(await current(f.draftId)).toBe(false); // approval predates last pause
    } finally {
      if (jobId) await pool.query(
        "update public.job_queue set status='failed',locked_by=null,locked_at=null where organization_id=$1 and id=$2",
        [org, jobId],
      );
      await cancel(f.missionId);
    }
  });

  it("does not grant send-policy commands to authenticated clients", async () => {
    const { rows } = await pool.query<{ auth: boolean; service: boolean; table_read: boolean; table_write: boolean }>(
      `select has_function_privilege('authenticated',
         'public.fn_set_ai_mission_send_policy(uuid,uuid,uuid,uuid,text,text)','execute') as auth,
              has_function_privilege('service_role',
         'public.fn_set_ai_mission_send_policy(uuid,uuid,uuid,uuid,text,text)','execute') as service,
              has_table_privilege('authenticated','public.ai_mission_commands','select') as table_read,
              has_table_privilege('service_role','public.ai_mission_commands','insert') as table_write`,
    );
    expect(rows[0]).toEqual({ auth: false, service: true, table_read: false, table_write: false });
  });

  it("vetoes a queued Mission reply when its Agent is disabled without changing the approval", async () => {
    const f = await stagedMission();
    expect(await current(f.draftId)).toBe(true);
    await pool.query(
      "update public.ai_agents set is_active=false where organization_id=$1 and id=$2",
      [org, agent],
    );
    try {
      expect(await current(f.draftId)).toBe(false);
      const { rows } = await pool.query<{ status: string }>(
        "select status from public.ai_agent_action_proposals where organization_id=$1 and id=$2",
        [org, f.proposalId],
      );
      expect(rows[0]?.status).toBe("pending");
    } finally {
      await pool.query(
        "update public.ai_agents set is_active=true where organization_id=$1 and id=$2",
        [org, agent],
      );
      await cancel(f.missionId);
    }
  });

  it("atomically cancels an awaiting run, specialist, proposal and pending draft", async () => {
    const f = await stagedMission();
    const child = randomUUID();
    const jobId = randomUUID();
    const claimAt = "2026-09-29 12:00:00.123456+00";
    await pool.query(
      "insert into public.job_queue(id,organization_id,kind,payload,status,locked_by,locked_at,attempts) values($1,$2,'workbench_start',$3::jsonb,'running','mission-test',$4::timestamptz,1)",
      [jobId, org, JSON.stringify({ runId: f.runId }), claimAt],
    );
    const job = {
      id: jobId, organization_id: org, locked_by: "mission-test",
      claim_acquired_at: claimAt,
    } as never;
    await pool.query(
      "insert into public.ai_workbench_runs(id,organization_id,agent_id,parent_run_id,run_kind,specialist_key,collaboration_key,task,mode,status) values($1,$2,$3,$4,'specialist','evidence','mission-stop','Read evidence','inspect','queued')",
      [child, org, agent, f.runId],
    );
    expect(await current(f.draftId)).toBe(true);
    await expect(assertWorkbenchJobLease(pool, job, "mission-test")).resolves.toBeUndefined();
    expect(await cancel(f.missionId, randomUUID())).toBe("not_found");
    expect(await cancel(f.missionId)).toBe("cancelled");
    expect(await cancel(f.missionId)).toBe("terminal");
    expect(await current(f.draftId)).toBe(false);
    await expect(assertWorkbenchJobLease(pool, job, "mission-test")).rejects.toThrow(
      "workbench_job_lease_lost",
    );
    const { rows } = await pool.query<{
      mission_status: string; run_status: string; child_status: string;
      proposal_status: string; draft_status: string;
    }>(
      `select m.status mission_status,r.status run_status,child.status child_status,
              p.status proposal_status,d.status draft_status
       from public.ai_missions m
       join public.ai_workbench_runs r on r.mission_id=m.id
       join public.ai_workbench_runs child on child.parent_run_id=r.id
       join public.ai_agent_action_proposals p on p.run_id=r.id
       join public.ai_reply_drafts d on d.workbench_proposal_id=p.id
       where m.organization_id=$1 and m.id=$2`,
      [org, f.missionId],
    );
    expect(rows[0]).toEqual({
      mission_status: "cancelled", run_status: "cancelled", child_status: "cancelled",
      proposal_status: "cancelled", draft_status: "stale",
    });
    const events = (await pool.query<{ run_id: string; event_type: string }>(
      "select run_id,event_type from public.ai_agent_run_events where organization_id=$1 and run_id=any($2::uuid[]) order by run_id,sequence",
      [org, [f.runId, child]],
    )).rows;
    expect(events).toEqual([
      { run_id: f.runId, event_type: "run_cancelled" },
      { run_id: child, event_type: "run_cancelled" },
    ].sort((a, b) => a.run_id.localeCompare(b.run_id)));
  });

  it("blocks an approved but queued customer message at the final delivery policy", async () => {
    const f = await stagedMission();
    const userDb = await pool.connect();
    let jobId = "";
    try {
      await userDb.query("begin");
      await userDb.query("set local role authenticated");
      await userDb.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: actor, role: "authenticated", aal: "aal1" }),
      ]);
      const { rows } = await userDb.query<{ job_id: string }>(
        "select public.fn_reply_action($1,$2,'1','approve',$3,null) as job_id",
        [org, f.draftId, "Approved quote"],
      );
      jobId = rows[0]!.job_id;
      await userDb.query("commit");
    } catch (error) {
      await userDb.query("rollback");
      throw error;
    } finally {
      userDb.release();
    }
    await pool.query(
      "update public.ai_workbench_runs set status='completed' where organization_id=$1 and id=$2",
      [org, f.runId],
    );
    const claimAt = "2026-09-29 12:00:00.123456+00";
    await pool.query(
      "update public.job_queue set status='running',locked_by='mission-test',locked_at=$2::timestamptz,attempts=1 where organization_id=$1 and id=$3",
      [org, claimAt, jobId],
    );
    const policy = async () => (await pool.query<{ policy: { current: boolean; context_current: boolean } }>(
      "select public.fn_reply_delivery_policy($1,$2,$3,$4::timestamptz) as policy",
      [org, jobId, "mission-test", claimAt],
    )).rows[0]!.policy;
    expect(await policy()).toMatchObject({ current: true, context_current: true });
    expect(await cancel(f.missionId)).toBe("cancelled");
    const draft = (await pool.query<{ status: string }>(
      "select status from public.ai_reply_drafts where organization_id=$1 and id=$2",
      [org, f.draftId],
    )).rows[0];
    expect(draft?.status).toBe("approved"); // preserve uncertain receipt reconciliation
    const run = (await pool.query<{ status: string }>(
      "select status from public.ai_workbench_runs where organization_id=$1 and id=$2",
      [org, f.runId],
    )).rows[0];
    expect(run?.status).toBe("completed"); // Mission state, not Run status, fences send
    expect(await current(f.draftId)).toBe(false);
    expect(await policy()).toMatchObject({ current: true, context_current: false });
  });

  it("does not grant Mission cancellation to authenticated clients", async () => {
    const { rows } = await pool.query<{ auth: boolean; service: boolean }>(
      `select has_function_privilege('authenticated',
         'public.fn_cancel_ai_mission(uuid,uuid,uuid,text)','execute') as auth,
              has_function_privilege('service_role',
         'public.fn_cancel_ai_mission(uuid,uuid,uuid,text)','execute') as service`,
    );
    expect(rows[0]).toEqual({ auth: false, service: true });
  });
});
