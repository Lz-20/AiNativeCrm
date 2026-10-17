import type { Pool } from "pg";
import { ASK_INTERNAL_COLLEAGUE_TOOL } from "@/lib/ai/agents/internal-question-contract";
import { appendWorkbenchObservation, parseRuntimeMessages } from "@/lib/ai/agents/workbench-state";
import { appendWorkbenchEventTx } from "@/lib/ai/agents/workbench-transaction-events";

export type RejectedProposalOutcome = "queued" | "awaiting_confirmation" | "partial";

/**
 * A rejection has no tool side effect. Commit the decision, Pi observation,
 * event log and next durable job together, so an HTTP crash cannot strand it.
 */
export async function rejectWorkbenchProposal(
  pool: Pool,
  input: {
    organizationId: string;
    runId: string;
    proposalId: string;
    actorUserId: string;
    reason?: string;
  },
): Promise<{ outcome: RejectedProposalOutcome; toolName: string } | null> {
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
    if (!run || run.status !== "awaiting_confirmation") {
      await client.query("commit");
      return null;
    }
    if (run.mission_id) {
      const { rows: missions } = await client.query<{ status: string }>(
        `select status from public.ai_missions
         where organization_id=$1 and id=$2 for share`,
        [input.organizationId, run.mission_id],
      );
      if (!missions[0] || ["cancelled", "completed"].includes(missions[0].status)) {
        await client.query("commit");
        return null;
      }
    }
    const { rows: proposals } = await client.query<{ tool_name: string; status: string }>(
      `select tool_name,status from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and id=$3 for update`,
      [input.organizationId, input.runId, input.proposalId],
    );
    const proposal = proposals[0];
    if (!proposal || proposal.status !== "pending" || proposal.tool_name === "send_message") {
      await client.query("commit");
      return null;
    }
    await client.query(
      `update public.ai_agent_action_proposals
       set status='rejected',decision_by=$4,decision_reason=$5,decision_at=now(),
           result_summary='{"outcome":"rejected"}'::jsonb,
           tool_args=case when tool_name=$6 then '{}'::jsonb else tool_args end,
           preview=case when tool_name=$6 then
             '{"externalEffect":"feishu_internal_question","requiresHumanConfirmation":true,"redacted":true}'::jsonb
             else preview end
       where organization_id=$1 and run_id=$2 and id=$3 and status='pending'`,
      [input.organizationId, input.runId, input.proposalId,
        input.actorUserId, input.reason ?? null, ASK_INTERNAL_COLLEAGUE_TOOL],
    );
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "human_confirmation_received", {
        proposalId: input.proposalId, decision: "reject", actorUserId: input.actorUserId,
      });
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "policy_checked", { proposalId: input.proposalId,
        decision: "rejected", tool: proposal.tool_name });
    const { rows: states } = await client.query<{ messages: unknown }>(
      `select messages from public.ai_agent_run_states
       where organization_id=$1 and run_id=$2 for update`,
      [input.organizationId, input.runId],
    );
    const messages = parseRuntimeMessages(states[0]?.messages);
    if (!messages) {
      await client.query(
        `update public.ai_workbench_runs
         set status='partial',error_code='resume_state_missing',completed_at=now()
         where organization_id=$1 and id=$2 and status='awaiting_confirmation'`,
        [input.organizationId, input.runId],
      );
      await client.query(
        `update public.ai_agent_action_proposals set status='cancelled'
         where organization_id=$1 and run_id=$2 and status='pending'`,
        [input.organizationId, input.runId],
      );
      await appendWorkbenchEventTx(client, input.organizationId, input.runId,
        "run_partial", { status: "partial", pendingProposals: 0,
          reason: "resume_state_missing" });
      await client.query("commit");
      return { outcome: "partial", toolName: proposal.tool_name };
    }
    const continued = appendWorkbenchObservation(messages,
      { tool: proposal.tool_name, status: "rejected" });
    await client.query(
      `update public.ai_agent_run_states set messages=$3::jsonb
       where organization_id=$1 and run_id=$2`,
      [input.organizationId, input.runId, JSON.stringify(continued)],
    );
    const { rows: pending } = await client.query<{ count: number }>(
      `select count(*)::int as count from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and status='pending'`,
      [input.organizationId, input.runId],
    );
    if ((pending[0]?.count ?? 0) > 0) {
      await client.query("commit");
      return { outcome: "awaiting_confirmation", toolName: proposal.tool_name };
    }
    await client.query(
      `update public.ai_workbench_runs set status='running'
       where organization_id=$1 and id=$2 and status='awaiting_confirmation'`,
      [input.organizationId, input.runId],
    );
    await client.query(
      `insert into public.job_queue
       (organization_id,kind,source_event_id,payload,max_attempts)
       values ($1,'workbench_resume',$2,jsonb_build_object('runId',$3::uuid),3)`,
      [input.organizationId, input.proposalId, input.runId],
    );
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "run_resumed", { proposalId: input.proposalId });
    await client.query("commit");
    return { outcome: "queued", toolName: proposal.tool_name };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
