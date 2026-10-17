import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";
import { decidirElegibilidadeDaConversa } from "@/lib/ai/elegibilidade/consulta-pg";
import { loadMissionBudgetUsage, missionBudgetBlockReason } from "@/lib/ai/agents/mission-budget";
import { loadMissionContinuationAgent } from "@/lib/ai/agents/mission-continuation-agent";

interface WakeInput {
  organizationId: string;
  contactId: string;
  conversationId: string;
  inboundMessageId: string;
  allowlistTtlMs: number;
}

/**
 * Claim a customer's new text message for one unambiguous waiting mission.
 * Run, wake marker, first event and queue job commit together. The caller must
 * skip the ordinary inbound turn when this returns true, avoiding two agents
 * replying to the same customer message.
 */
export async function wakeMissionsFromInbound(pool: Pool, input: WakeInput): Promise<boolean> {
  const { rows: candidates } = await pool.query<{ id: string }>(
    `select m.id from public.ai_missions m
     join public.crm_leads l on l.organization_id=m.organization_id and l.id=m.lead_id
     where m.organization_id=$1 and l.contact_id=$2
       and m.status='waiting_customer' and m.wake_on_customer_reply
       and (m.deadline_at is null or m.deadline_at>now())
     order by m.created_at`,
    [input.organizationId, input.contactId],
  );
  if (candidates.length === 0) return false;
  // Honor the same opt-out, human-assignee, silence and channel allowlist gate
  // as the ordinary inbound turn. An unavailable gate cannot authorize a wake.
  let eligible = false;
  try {
    eligible = (await decidirElegibilidadeDaConversa(pool, {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      agora: new Date(),
      ttlMs: input.allowlistTtlMs,
    }))?.permite === true;
  } catch {
    return false;
  }
  if (!eligible) return false;
  const { rows: messageRows } = await pool.query<{ type: string }>(
    `select type from public.messages
     where organization_id=$1 and id=$2 and contact_id=$3
       and conversation_id=$4 and direction='inbound'`,
    [input.organizationId, input.inboundMessageId, input.contactId, input.conversationId],
  );
  // Media derivation has its own timing contract. Text is the first complete
  // customer-wake path; other kinds stay on the existing inbound engine.
  if (messageRows[0]?.type !== "text") return false;
  if (candidates.length > 1) {
    // One contact can have multiple opportunities. Picking one arbitrarily
    // would silently attach a customer reply to the wrong business outcome;
    // running all would risk duplicate customer contact. Escalate instead.
    await pool.query(
      `update public.ai_missions set status='needs_review',
         blocked_reason='ambiguous_customer_reply',wake_on_customer_reply=false
       where organization_id=$1 and id=any($2::uuid[])
         and status='waiting_customer'`,
      [input.organizationId, candidates.map((candidate) => candidate.id)],
    );
    return false;
  }
  let claimed = false;
  for (const candidate of candidates) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows: locked } = await client.query<{
        id: string;
        lead_id: string;
        actor_user_id: string | null;
        goal: string;
        acceptance_criteria: string;
        current_direction: string | null;
        direction_revision: string | number;
        max_runs: number;
        pipeline_id: string;
        reply_context_revision: number;
      }>(
        `select m.id,m.lead_id,m.actor_user_id,m.goal,m.acceptance_criteria,m.current_direction,m.direction_revision,m.max_runs,
                l.pipeline_id,c.reply_context_revision
         from public.ai_missions m
         join public.crm_leads l on l.organization_id=m.organization_id and l.id=m.lead_id
         join public.conversations c on c.organization_id=m.organization_id
           and c.id=$3 and c.contact_id=l.contact_id
         where m.organization_id=$1 and m.id=$2
           and m.status='waiting_customer' and m.wake_on_customer_reply
           and (m.deadline_at is null or m.deadline_at>now())
         for update of m`,
        [input.organizationId, candidate.id, input.conversationId],
      );
      const mission = locked[0];
      if (!mission) {
        await client.query("commit");
        continue;
      }
      const directionRevision = Number(mission.direction_revision);
      if (!Number.isSafeInteger(directionRevision) || directionRevision < 0)
        throw new Error("mission_direction_revision_invalid");
      claimed = true;
      const { rows: priorWake } = await client.query(
        `select id from public.ai_mission_wakes
         where organization_id=$1 and mission_id=$2 and inbound_message_id=$3`,
        [input.organizationId, mission.id, input.inboundMessageId],
      );
      if (priorWake.length > 0) {
        await client.query("commit");
        continue;
      }
      const { rows: priorRuns } = await client.query<{
        id: string;
        agent_id: string;
        status: string;
        budget: unknown;
        runtime_state: Record<string, unknown>;
      }>(
        `select id,agent_id,status,budget,runtime_state
         from public.ai_workbench_runs
         where organization_id=$1 and mission_id=$2 and run_kind='root'
         order by created_at desc limit 1`,
        [input.organizationId, mission.id],
      );
      const prior = priorRuns[0];
      const { rows: runCounts } = await client.query<{ count: number }>(
        `select count(*)::int as count from public.ai_workbench_runs
         where organization_id=$1 and mission_id=$2 and run_kind='root'`,
        [input.organizationId, mission.id],
      );
      const runCount = runCounts[0]?.count ?? 0;
      if (!prior || typeof prior.runtime_state?.versionId !== "string" ||
          runCount >= mission.max_runs ||
          ["queued", "running", "awaiting_confirmation"].includes(prior.status)) {
        await client.query(
          `update public.ai_missions set status='needs_review',
            blocked_reason=$3, wake_on_customer_reply=false
           where organization_id=$1 and id=$2`,
          [input.organizationId, mission.id,
            runCount >= mission.max_runs ? "mission_run_budget_exhausted" : "mission_continuation_unavailable"],
        );
        await client.query("commit");
        continue;
      }
      const usage = await loadMissionBudgetUsage(client, input.organizationId, mission.id);
      if (!usage) throw new Error("mission_budget_missing");
      const budgetBlock = missionBudgetBlockReason(usage);
      if (budgetBlock) {
        await client.query(
          `update public.ai_missions set status='needs_review',
            blocked_reason=$3, wake_on_customer_reply=false
           where organization_id=$1 and id=$2`,
          [input.organizationId, mission.id, `mission_budget_${budgetBlock}`],
        );
        await client.query("commit");
        continue;
      }
      const agent = await loadMissionContinuationAgent(
        client, input.organizationId, prior.agent_id, prior.runtime_state.versionId,
      );
      if (!agent) {
        await client.query(
          `update public.ai_missions set status='needs_review',
            blocked_reason='mission_agent_unavailable',wake_on_customer_reply=false
           where organization_id=$1 and id=$2`,
          [input.organizationId, mission.id],
        );
        await client.query("commit");
        continue;
      }
      const runId = randomUUID();
      const task = (
        `客户已有新回复（消息 ID ${input.inboundMessageId}）。请先重新读取当前会话和 CRM，` +
        "核对已执行动作，避免重复承诺或触达。\n" +
        `继续商机业务任务：${mission.goal.slice(0, 4000)}\n` +
        `业务验收条件：${mission.acceptance_criteria.slice(0, 3000)}` +
        (mission.current_direction
          ? `\n当前负责人方向（不是对外动作的批准）：${JSON.stringify(mission.current_direction)}` : "")
      );
      const scope = {
        leadId: mission.lead_id,
        contactId: input.contactId,
        conversationId: input.conversationId,
        pipelineId: mission.pipeline_id,
      };
      await client.query(
        `insert into public.ai_workbench_runs
         (id,organization_id,agent_id,mission_id,actor_user_id,task,mode,scope,status,budget,runtime_state)
         values ($1,$2,$3,$4,$5,$6,'act',$7::jsonb,'queued',$8::jsonb,$9::jsonb)`,
        [runId, input.organizationId, prior.agent_id, mission.id, mission.actor_user_id,
          task, JSON.stringify(scope), JSON.stringify(prior.budget), JSON.stringify({
            versionId: prior.runtime_state.versionId,
            runner: "pi_crm_preview",
            replyContextRevision: mission.reply_context_revision,
            agentOperationRevision: agent.operationRevision,
            collaborationMode: "auto",
            directionRevision,
          })],
      );
      await client.query(
        `insert into public.ai_mission_wakes
         (organization_id,mission_id,inbound_message_id,run_id)
         values ($1,$2,$3,$4)`,
        [input.organizationId, mission.id, input.inboundMessageId, runId],
      );
      await client.query(
        `insert into public.ai_agent_run_events
         (organization_id,run_id,sequence,event_type,payload)
         values ($1,$2,1,'run_started',$3::jsonb)`,
        [input.organizationId, runId, JSON.stringify({
          agentId: prior.agent_id,
          mode: "act",
          taskLength: task.length,
        })],
      );
      await enqueueJob(client, input.organizationId, {
        kind: "workbench_start",
        sourceEventId: runId,
        payload: { runId },
        maxAttempts: 3,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  return claimed;
}
