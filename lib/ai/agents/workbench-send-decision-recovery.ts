import type { Pool } from "pg";
import { appendWorkbenchObservation, parseRuntimeMessages } from "@/lib/ai/agents/workbench-state";
import { appendWorkbenchEventTx } from "@/lib/ai/agents/workbench-transaction-events";

type Outcome = "queued" | "awaiting_confirmation" | "partial";
type Decision = "approve" | "reject";

export interface SendDecisionReceipt {
  proposalId: string;
  decision: Decision;
  outcome: Outcome;
  resumeJobId: string | null;
  replayed: boolean;
}

/**
 * The draft/proposal decision is already durable. This transaction records
 * exactly one Pi observation and the next queue job, never re-executes send.
 * Both the HTTP route and the Worker reaper may call it after a crash.
 */
export async function finalizeWorkbenchSendDecision(
  pool: Pool,
  input: { organizationId: string; runId: string; proposalId: string },
): Promise<SendDecisionReceipt | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '5s'");
    const { rows: runs } = await client.query<{ status: string; mission_id: string | null }>(
      `select status,mission_id from public.ai_workbench_runs
       where organization_id=$1 and id=$2 and run_kind='root' for update`,
      [input.organizationId, input.runId],
    );
    const run = runs[0];
    if (!run) {
      await client.query("commit");
      return null;
    }
    const { rows: receipts } = await client.query<{
      decision: Decision; outcome: Outcome; resume_job_id: string | null;
    }>(
      `select decision,outcome,resume_job_id
       from public.ai_workbench_send_decision_receipts
       where organization_id=$1 and run_id=$2 and proposal_id=$3`,
      [input.organizationId, input.runId, input.proposalId],
    );
    if (receipts[0]) {
      await client.query("commit");
      return { proposalId: input.proposalId, decision: receipts[0].decision,
        outcome: receipts[0].outcome, resumeJobId: receipts[0].resume_job_id,
        replayed: true };
    }
    if (run.status !== "running") {
      await client.query("commit");
      return null;
    }
    if (run.mission_id) {
      const { rows: missions } = await client.query<{ status: string }>(
        `select status from public.ai_missions where organization_id=$1 and id=$2`,
        [input.organizationId, run.mission_id],
      );
      if (!missions[0] || ["cancelled", "completed"].includes(missions[0].status)) {
        await client.query("commit");
        return null;
      }
    }
    const { rows: decisions } = await client.query<{
      proposal_status: string; decision_by: string | null; draft_status: string;
      send_job_id: string | null;
    }>(
      `select p.status as proposal_status,p.decision_by,
              d.status as draft_status,d.send_job_id
       from public.ai_agent_action_proposals p
       join public.ai_reply_drafts d
         on d.organization_id=p.organization_id and d.workbench_run_id=p.run_id
        and d.workbench_proposal_id=p.id
       where p.organization_id=$1 and p.run_id=$2 and p.id=$3
         and p.tool_name='send_message'
       for update of p,d`,
      [input.organizationId, input.runId, input.proposalId],
    );
    const decided = decisions[0];
    const decision: Decision | null = decided?.proposal_status === "executed"
      ? "approve" : decided?.proposal_status === "rejected" ? "reject" : null;
    if (!decided || !decision) {
      await client.query("commit");
      return null;
    }
    if (decision === "approve" && !decided.send_job_id)
      throw new Error("workbench_send_decision_job_missing");

    const { rows: states } = await client.query<{ messages: unknown }>(
      `select messages from public.ai_agent_run_states
       where organization_id=$1 and run_id=$2 for update`,
      [input.organizationId, input.runId],
    );
    const messages = parseRuntimeMessages(states[0]?.messages);
    let outcome: Outcome;
    let resumeJobId: string | null = null;
    if (!messages) {
      // The channel decision cannot be undone. Never fabricate Pi context or
      // retry the external action when the private continuation is missing.
      await client.query(
        `update public.ai_workbench_runs
         set status='partial',error_code='resume_state_missing',completed_at=now()
         where organization_id=$1 and id=$2 and status='running'`,
        [input.organizationId, input.runId],
      );
      await appendWorkbenchEventTx(client, input.organizationId, input.runId, "run_partial",
        { status: "partial", reason: "resume_state_missing" });
      outcome = "partial";
    } else {
      const deliveryStatus = decision === "approve" ? decided.draft_status : "not_sent";
      const observation = {
        tool: "send_message", status: decision === "approve" ? "executed" as const : "rejected" as const,
        result: { deliveryStatus, ...(decided.send_job_id ? { jobId: decided.send_job_id } : {}) },
      };
      const continued = appendWorkbenchObservation(messages, observation);
      await client.query(
        `update public.ai_agent_run_states set messages=$3::jsonb
         where organization_id=$1 and run_id=$2`,
        [input.organizationId, input.runId, JSON.stringify(continued)],
      );
      await appendWorkbenchEventTx(client, input.organizationId, input.runId,
        "human_confirmation_received", {
          proposalId: input.proposalId, decision,
          ...(decided.decision_by ? { actorUserId: decided.decision_by } : {}),
        });
      await appendWorkbenchEventTx(client, input.organizationId, input.runId,
        "policy_checked", { proposalId: input.proposalId,
          decision: decision === "approve" ? "approved" : "rejected", tool: "send_message" });
      if (decision === "approve")
        await appendWorkbenchEventTx(client, input.organizationId, input.runId,
          "tool_started", { proposalId: input.proposalId, tool: "send_message" });
      await appendWorkbenchEventTx(client, input.organizationId, input.runId,
        "tool_completed", { proposalId: input.proposalId, tool: "send_message",
          status: decision === "approve" ? "queued" : "rejected" });
      const { rows: pending } = await client.query<{ count: number }>(
        `select count(*)::int as count from public.ai_agent_action_proposals
         where organization_id=$1 and run_id=$2 and status='pending'`,
        [input.organizationId, input.runId],
      );
      if ((pending[0]?.count ?? 0) > 0) {
        await client.query(
          `update public.ai_workbench_runs set status='awaiting_confirmation'
           where organization_id=$1 and id=$2 and status='running'`,
          [input.organizationId, input.runId],
        );
        outcome = "awaiting_confirmation";
      } else {
        const { rows: inserted } = await client.query<{ id: string }>(
          `insert into public.job_queue
           (organization_id,kind,source_event_id,payload,max_attempts)
           values ($1,'workbench_resume',$2,jsonb_build_object('runId',$3::uuid),3)
           on conflict (organization_id,source_event_id)
             where source_event_id is not null do nothing
           returning id`,
          [input.organizationId, input.proposalId, input.runId],
        );
        if (inserted[0]) resumeJobId = inserted[0].id;
        else {
          const { rows: existing } = await client.query<{
            id: string; kind: string; payload: { runId?: string }; status: string;
          }>(
            `select id,kind,payload,status from public.job_queue
             where organization_id=$1 and source_event_id=$2`,
            [input.organizationId, input.proposalId],
          );
          if (existing[0]?.kind !== "workbench_resume" ||
              existing[0].payload?.runId !== input.runId || existing[0].status === "dead")
            throw new Error("workbench_send_decision_queue_conflict");
          resumeJobId = existing[0].id;
        }
        await appendWorkbenchEventTx(client, input.organizationId, input.runId,
          "run_resumed", { proposalId: input.proposalId });
        outcome = "queued";
      }
    }
    await client.query(
      `insert into public.ai_workbench_send_decision_receipts
       (organization_id,proposal_id,run_id,decision,outcome,resume_job_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [input.organizationId, input.proposalId, input.runId, decision, outcome, resumeJobId],
    );
    await client.query("commit");
    return { proposalId: input.proposalId, decision, outcome, resumeJobId, replayed: false };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Repair the gap left if HTTP died after fn_reply_action committed. */
export async function reconcileWorkbenchSendDecisions(
  pool: Pool, limit = 20,
  onError?: (failure: { organizationId: string; runId: string;
    proposalId: string; code: string }) => void,
): Promise<number> {
  const { rows } = await pool.query<{
    organization_id: string; run_id: string; proposal_id: string;
  }>(
    `select p.organization_id,p.run_id,p.id as proposal_id
     from public.ai_agent_action_proposals p
     join public.ai_workbench_runs r
       on r.organization_id=p.organization_id and r.id=p.run_id
     join public.ai_reply_drafts d
       on d.organization_id=p.organization_id and d.workbench_proposal_id=p.id
     where p.tool_name='send_message' and p.status in ('executed','rejected')
       and r.status='running' and p.decision_at < now()-interval '5 seconds'
       and (r.mission_id is null or exists (
         select 1 from public.ai_missions m
         where m.organization_id=r.organization_id and m.id=r.mission_id
           and m.status not in ('completed','cancelled')))
       and not exists (
         select 1 from public.ai_workbench_send_decision_receipts receipt
         where receipt.organization_id=p.organization_id and receipt.proposal_id=p.id)
     order by p.decision_at limit $1`,
    [Math.max(1, Math.min(limit, 100))],
  );
  let repaired = 0;
  for (const row of rows) {
    try {
      const result = await finalizeWorkbenchSendDecision(pool, {
        organizationId: row.organization_id, runId: row.run_id,
        proposalId: row.proposal_id,
      });
      if (result && !result.replayed) repaired += 1;
    } catch (error) {
      onError?.({ organizationId: row.organization_id, runId: row.run_id,
        proposalId: row.proposal_id,
        code: error && typeof error === "object" && "code" in error
          ? String(error.code) : "recovery_failed" });
    }
  }
  return repaired;
}
