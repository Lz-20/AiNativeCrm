import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";
import { encryptQuestionText } from "@/lib/ai/internal-collaboration/inbox-crypto";
import { ASK_INTERNAL_COLLEAGUE_TOOL, internalQuestionArgsSchema } from "@/lib/ai/agents/internal-question-contract";
import { loadMissionContinuationAgent } from "@/lib/ai/agents/mission-continuation-agent";
import { appendWorkbenchObservation, parseRuntimeMessages } from "@/lib/ai/agents/workbench-state";
import { redactEventPayload, type CrmAgentEventType } from "@/lib/ai/agents/workbench-events";

export type InternalQuestionErrorCode =
  | "input_invalid" | "not_found" | "state_conflict" | "deadline_expired"
  | "channel_unavailable" | "recipient_unavailable" | "source_conflict"
  | "proposal_invalid" | "agent_unavailable";

export class InternalQuestionError extends Error {
  constructor(readonly code: InternalQuestionErrorCode) {
    super(code);
    this.name = "InternalQuestionError";
  }
}

export interface AskFeishuColleagueInput {
  organizationId: string;
  missionId: string;
  requesterUserId: string;
  recipientUserId: string;
  requestKey: string;
  question: string;
}

export interface AskFeishuColleagueResult {
  questionId: string;
  status: "pending" | "sent" | "needs_review" | "expired";
  replayed: boolean;
}

async function enqueueQuestionLocked(
  client: PoolClient,
  input: AskFeishuColleagueInput,
  question: string,
  tenantKey: string,
  digest: string,
): Promise<string> {
  const { rows: recipients } = await client.query<{ external_user_id: string }>(
    `select u.external_user_id from public.ai_internal_platform_tenants t
     join public.ai_internal_platform_users u
       on u.organization_id=t.organization_id and u.provider=t.provider
      and u.tenant_key=t.tenant_key
     join public.user_organizations member
       on member.organization_id=u.organization_id and member.user_id=u.user_id
     where t.organization_id=$1 and t.provider='feishu' and t.tenant_key=$2
       and t.active and u.active and u.user_id=$3
       and member.revoked_at is null and member.accepted_at is not null
       and member.role in ('agent','manager','admin')
     for share of t,u,member`,
    [input.organizationId, tenantKey, input.recipientUserId],
  );
  if (recipients.length !== 1) throw new InternalQuestionError("recipient_unavailable");
  const questionId = randomUUID();
  const text = `${question}\n\n请直接回复此消息。补充事实不等于报价或对外发送的批准。`;
  const encrypted = encryptQuestionText(text, {
    organizationId: input.organizationId, tenantKey, eventId: questionId,
  });
  await client.query(
    `insert into public.ai_internal_question_outbox
     (id,organization_id,mission_id,requester_user_id,recipient_user_id,
      tenant_key,recipient_open_id,request_key,question_digest,
      question_ciphertext,question_iv,question_tag)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [questionId, input.organizationId, input.missionId, input.requesterUserId,
      input.recipientUserId, tenantKey, recipients[0]!.external_user_id,
      input.requestKey, digest, encrypted.ciphertext, encrypted.iv, encrypted.tag],
  );
  await enqueueJob(client, input.organizationId, {
    kind: "internal_im_question", sourceEventId: questionId,
    payload: { questionId }, maxAttempts: 5,
  });
  return questionId;
}

/** Explicit manager approval creates the external effect; the model cannot call this directly. */
export async function askFeishuColleague(
  pool: Pool,
  input: AskFeishuColleagueInput,
): Promise<AskFeishuColleagueResult> {
  const question = input.question.trim();
  if (question.length < 5 || question.length > 1_000 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestKey))
    throw new InternalQuestionError("input_invalid");
  const tenantKey = process.env.FEISHU_TENANT_KEY ?? "";
  const digest = createHash("sha256").update(question).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: missions } = await client.query<{
      id: string; status: string; deadline_at: Date | null;
    }>(
      `select id,status,deadline_at from public.ai_missions
       where organization_id=$1 and id=$2 for update`,
      [input.organizationId, input.missionId],
    );
    const mission = missions[0];
    if (!mission) throw new InternalQuestionError("not_found");
    const { rows: managers } = await client.query(
      `select 1 from public.user_organizations
       where organization_id=$1 and user_id=$2 and revoked_at is null
         and accepted_at is not null and role in ('manager','admin') for share`,
      [input.organizationId, input.requesterUserId],
    );
    if (!managers[0]) throw new InternalQuestionError("not_found");
    const { rows: existing } = await client.query<{
      id: string; recipient_user_id: string; question_digest: string;
      status: AskFeishuColleagueResult["status"];
    }>(
      `select id,recipient_user_id,question_digest,status
       from public.ai_internal_question_outbox
       where organization_id=$1 and mission_id=$2 and request_key=$3`,
      [input.organizationId, input.missionId, input.requestKey],
    );
    if (existing[0]) {
      if (existing[0].recipient_user_id !== input.recipientUserId ||
          existing[0].question_digest !== digest)
        throw new InternalQuestionError("source_conflict");
      await client.query("commit");
      return { questionId: existing[0].id, status: existing[0].status, replayed: true };
    }
    if (!tenantKey || !process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET)
      throw new InternalQuestionError("channel_unavailable");
    if (mission.status !== "waiting_internal") throw new InternalQuestionError("state_conflict");
    if (mission.deadline_at && new Date(mission.deadline_at).getTime() <= Date.now())
      throw new InternalQuestionError("deadline_expired");
    const questionId = await enqueueQuestionLocked(client, input, question, tenantKey, digest);
    await client.query("commit");
    return { questionId, status: "pending", replayed: false };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Approval is a terminal Pi milestone: queue the question and wait for an authenticated reply. */
export async function approveProposedFeishuQuestion(
  pool: Pool,
  input: { organizationId: string; missionId: string; runId: string;
    proposalId: string; approverUserId: string; reason?: string },
): Promise<{ questionId: string; status: "pending" }> {
  const tenantKey = process.env.FEISHU_TENANT_KEY ?? "";
  if (!tenantKey || !process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET)
    throw new InternalQuestionError("channel_unavailable");
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Mission → Run → Proposal is the same lock order as cancellation.
    const { rows: missions } = await client.query<{
      lead_id: string; status: string; deadline_at: Date | null;
    }>(
      `select lead_id,status,deadline_at from public.ai_missions
       where organization_id=$1 and id=$2 for update`,
      [input.organizationId, input.missionId],
    );
    const mission = missions[0];
    if (!mission) throw new InternalQuestionError("not_found");
    if (mission.status !== "waiting_approval") throw new InternalQuestionError("state_conflict");
    if (mission.deadline_at && new Date(mission.deadline_at).getTime() <= Date.now())
      throw new InternalQuestionError("deadline_expired");
    const { rows: managers } = await client.query(
      `select 1 from public.user_organizations
       where organization_id=$1 and user_id=$2 and revoked_at is null
         and accepted_at is not null and role in ('manager','admin') for share`,
      [input.organizationId, input.approverUserId],
    );
    if (!managers[0]) throw new InternalQuestionError("not_found");
    const { rows: runs } = await client.query<{
      agent_id: string; status: string; mode: string; scope: Record<string, unknown>;
      runtime_state: Record<string, unknown>;
    }>(
      `select agent_id,status,mode,scope,runtime_state from public.ai_workbench_runs
       where organization_id=$1 and id=$2 and mission_id=$3 and run_kind='root'
       for update`,
      [input.organizationId, input.runId, input.missionId],
    );
    const run = runs[0];
    if (!run || run.status !== "awaiting_confirmation" || run.mode !== "act" ||
        run.scope?.leadId !== mission.lead_id)
      throw new InternalQuestionError("state_conflict");
    const { rows: competing } = await client.query<{ count: string }>(
      `select count(*)::text as count from public.ai_workbench_runs
       where organization_id=$1 and mission_id=$2 and id<>$3
         and status in ('queued','running','awaiting_confirmation')`,
      [input.organizationId, input.missionId, input.runId],
    );
    if (competing[0]?.count !== "0") throw new InternalQuestionError("state_conflict");
    const { rows: outstanding } = await client.query<{ count: string }>(
      `select count(*)::text as count from public.ai_internal_question_outbox
       where organization_id=$1 and mission_id=$2 and status='pending'`,
      [input.organizationId, input.missionId],
    );
    if (outstanding[0]?.count !== "0") throw new InternalQuestionError("state_conflict");
    const versionId = run.runtime_state?.versionId;
    if (typeof versionId !== "string" ||
        !await loadMissionContinuationAgent(client, input.organizationId, run.agent_id, versionId))
      throw new InternalQuestionError("agent_unavailable");
    const { rows: agents } = await client.query<{ builtin_key: string | null }>(
      `select builtin_key from public.ai_agents
       where organization_id=$1 and id=$2 for share`,
      [input.organizationId, run.agent_id],
    );
    if (agents[0]?.builtin_key !== "crm_supervisor")
      throw new InternalQuestionError("agent_unavailable");
    const { rows: proposals } = await client.query<{
      tool_name: string; tool_args: unknown; status: string;
    }>(
      `select tool_name,tool_args,status from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and id=$3 for update`,
      [input.organizationId, input.runId, input.proposalId],
    );
    const proposal = proposals[0];
    const parsed = internalQuestionArgsSchema.safeParse(proposal?.tool_args);
    if (!proposal || proposal.status !== "pending" ||
        proposal.tool_name !== ASK_INTERNAL_COLLEAGUE_TOOL || !parsed.success)
      throw new InternalQuestionError("proposal_invalid");
    const { rows: pending } = await client.query<{ count: string }>(
      `select count(*)::text as count from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and status='pending'`,
      [input.organizationId, input.runId],
    );
    if (pending[0]?.count !== "1") throw new InternalQuestionError("state_conflict");
    const { rows: savedState } = await client.query<{ messages: unknown }>(
      `select messages from public.ai_agent_run_states
       where organization_id=$1 and run_id=$2 for update`,
      [input.organizationId, input.runId],
    );
    const messages = parseRuntimeMessages(savedState[0]?.messages);
    if (!messages) throw new InternalQuestionError("state_conflict");
    const question = parsed.data.question;
    const digest = createHash("sha256").update(question).digest("hex");
    const questionId = await enqueueQuestionLocked(client, {
      organizationId: input.organizationId,
      missionId: input.missionId,
      requesterUserId: input.approverUserId,
      recipientUserId: parsed.data.recipientUserId,
      requestKey: input.proposalId,
      question,
    }, question, tenantKey, digest);
    const { rowCount: decided } = await client.query(
      `update public.ai_agent_action_proposals
       set status='executed',decision_by=$4,decision_reason=$5,decision_at=now(),
           tool_args=$6::jsonb,preview=$7::jsonb,result_summary=$8::jsonb
       where organization_id=$1 and run_id=$2 and id=$3 and status='pending'`,
      [input.organizationId, input.runId, input.proposalId,
        input.approverUserId, input.reason ?? null,
        JSON.stringify({ recipientUserId: parsed.data.recipientUserId, questionDigest: digest }),
        JSON.stringify({ externalEffect: "feishu_internal_question", requiresHumanConfirmation: true,
          recipientUserId: parsed.data.recipientUserId, questionDigest: digest }),
        JSON.stringify({ outcome: "queued", questionId })],
    );
    if (decided !== 1) throw new InternalQuestionError("state_conflict");
    const continued = appendWorkbenchObservation(messages, {
      tool: ASK_INTERNAL_COLLEAGUE_TOOL,
      status: "executed",
      result: { delivery: "queued", questionId },
    });
    await client.query(
      `update public.ai_agent_run_states set messages=$3::jsonb
       where organization_id=$1 and run_id=$2`,
      [input.organizationId, input.runId, JSON.stringify(continued)],
    );
    const { rowCount: finished } = await client.query(
      `update public.ai_workbench_runs
       set status='completed',completed_at=now(),
           final_text='内部提问已获批准并排队，任务等待同事回复；尚未确认送达，也未完成业务目标。'
       where organization_id=$1 and id=$2 and status='awaiting_confirmation'`,
      [input.organizationId, input.runId],
    );
    if (finished !== 1) throw new InternalQuestionError("state_conflict");
    const { rowCount: waiting } = await client.query(
      `update public.ai_missions
       set status='waiting_internal',blocked_reason='awaiting_internal_colleague',
           wake_on_customer_reply=false
       where organization_id=$1 and id=$2 and status='needs_review'`,
      [input.organizationId, input.missionId],
    );
    if (waiting !== 1) throw new InternalQuestionError("state_conflict");
    const { rows: sequences } = await client.query<{ sequence: number }>(
      `select coalesce(max(sequence),0)::integer as sequence
       from public.ai_agent_run_events where organization_id=$1 and run_id=$2`,
      [input.organizationId, input.runId],
    );
    let sequence = sequences[0]?.sequence ?? 0;
    for (const [type, payload] of [
      ["human_confirmation_received", { proposalId: input.proposalId, decision: "approve",
        actorUserId: input.approverUserId }],
      ["policy_checked", { proposalId: input.proposalId, tool: ASK_INTERNAL_COLLEAGUE_TOOL,
        decision: "approved" }],
      ["tool_started", { proposalId: input.proposalId, tool: ASK_INTERNAL_COLLEAGUE_TOOL }],
      ["tool_completed", { proposalId: input.proposalId, tool: ASK_INTERNAL_COLLEAGUE_TOOL,
        status: "queued" }],
      ["run_completed", { status: "completed" }],
    ] as const) {
      await client.query(
        `insert into public.ai_agent_run_events
         (organization_id,run_id,sequence,event_type,payload)
         values ($1,$2,$3,$4,$5::jsonb)`,
        [input.organizationId, input.runId, ++sequence, type,
          JSON.stringify(redactEventPayload(type as CrmAgentEventType, payload))],
      );
    }
    await client.query("commit");
    return { questionId, status: "pending" };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
