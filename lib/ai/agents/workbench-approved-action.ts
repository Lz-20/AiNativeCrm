import type { Pool, PoolClient } from "pg";
import { appendWorkbenchObservation, parseRuntimeMessages } from "@/lib/ai/agents/workbench-state";
import { appendWorkbenchEventTx } from "@/lib/ai/agents/workbench-transaction-events";

type ActionOutcome = "queued" | "awaiting_confirmation" | "partial" | "cancelled";
type ActionResult =
  | { kind: "success"; output: unknown; compensationArgs?: Record<string, unknown>;
      preview?: { resourceUuid: string; changedFields: string[] } }
  | { kind: "safe_failure"; code: string };

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '5s'");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Claim exactly one reviewed action before entering its CRM tool adapter. */
export async function claimWorkbenchApprovedAction(pool: Pool, input: {
  organizationId: string; runId: string; proposalId: string;
  toolName: string; actorUserId: string; reason?: string;
}): Promise<boolean> {
  return transaction(pool, async (client) => {
    const { rows: runs } = await client.query<{ status: string; mission_id: string | null }>(
      `select status,mission_id from public.ai_workbench_runs
       where organization_id=$1 and id=$2 and run_kind='root' for update`,
      [input.organizationId, input.runId],
    );
    const run = runs[0];
    if (!run || run.status !== "awaiting_confirmation") return false;
    if (run.mission_id) {
      const { rows: missions } = await client.query<{ status: string }>(
        `select status from public.ai_missions
         where organization_id=$1 and id=$2 for share`,
        [input.organizationId, run.mission_id],
      );
      if (!missions[0] || ["cancelled", "completed"].includes(missions[0].status)) return false;
    }
    const { rows: proposals } = await client.query<{ status: string; tool_name: string }>(
      `select status,tool_name from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and id=$3 for update`,
      [input.organizationId, input.runId, input.proposalId],
    );
    if (proposals[0]?.status !== "pending" ||
        proposals[0].tool_name !== input.toolName || input.toolName === "send_message")
      return false;
    await client.query(
      `update public.ai_workbench_runs set status='running'
       where organization_id=$1 and id=$2 and status='awaiting_confirmation'`,
      [input.organizationId, input.runId],
    );
    await client.query(
      `update public.ai_agent_action_proposals
       set status='approved',decision_by=$4,decision_reason=$5,decision_at=now(),
           result_summary='{"outcome":"executing"}'::jsonb
       where organization_id=$1 and run_id=$2 and id=$3 and status='pending'`,
      [input.organizationId, input.runId, input.proposalId,
        input.actorUserId, input.reason ?? null],
    );
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "human_confirmation_received", {
        proposalId: input.proposalId, decision: "approve", actorUserId: input.actorUserId,
      });
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "policy_checked", { proposalId: input.proposalId,
        decision: "approved", tool: input.toolName });
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "tool_started", { proposalId: input.proposalId, tool: input.toolName });
    return true;
  });
}

/** Never enter a tool after a cancellation or stale decision is already visible. */
export async function assertWorkbenchApprovedActionCurrent(pool: Pool, input: {
  organizationId: string; runId: string; proposalId: string;
}): Promise<void> {
  const { rows } = await pool.query<{ current: boolean }>(
    `select exists (
       select 1 from public.ai_workbench_runs r
       join public.ai_agent_action_proposals p
         on p.organization_id=r.organization_id and p.run_id=r.id
       where r.organization_id=$1 and r.id=$2 and r.status='running'
         and p.id=$3 and p.status='approved'
         and (r.mission_id is null or exists (
           select 1 from public.ai_missions m
           where m.organization_id=r.organization_id and m.id=r.mission_id
             and m.status not in ('cancelled','completed')))
     ) as current`,
    [input.organizationId, input.runId, input.proposalId],
  );
  if (!rows[0]?.current) throw new Error("workbench_approved_action_no_longer_current");
}

/** Commit one known tool result with the private Pi observation and next job. */
export async function finishWorkbenchApprovedAction(pool: Pool, input: {
  organizationId: string; runId: string; proposalId: string; toolName: string;
  result: ActionResult;
}): Promise<ActionOutcome | null> {
  return transaction(pool, async (client) => {
    const { rows: runs } = await client.query<{ status: string }>(
      `select status from public.ai_workbench_runs
       where organization_id=$1 and id=$2 and run_kind='root' for update`,
      [input.organizationId, input.runId],
    );
    const run = runs[0];
    if (!run) return null;
    const { rows: proposals } = await client.query<{ status: string; tool_name: string }>(
      `select status,tool_name from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and id=$3 for update`,
      [input.organizationId, input.runId, input.proposalId],
    );
    if (proposals[0]?.status !== "approved" || proposals[0].tool_name !== input.toolName)
      return null;
    if (!["running", "cancelled"].includes(run.status))
      throw new Error("workbench_approved_action_run_state_conflict");
    if (input.result.kind === "success" && input.toolName === "crm_update_lead" &&
        (!input.result.compensationArgs || !input.result.preview))
      throw new Error("workbench_approved_lead_compensation_missing");
    await client.query(
      `update public.ai_agent_action_proposals
       set status=$4,
           result_summary=jsonb_build_object('outcome',$5::text,'tool',$6::text),
           compensation_args=case when $7::jsonb is null then compensation_args else $7::jsonb end,
           preview=case when $8::jsonb is null then preview else $8::jsonb end
       where organization_id=$1 and run_id=$2 and id=$3 and status='approved'`,
      [input.organizationId, input.runId, input.proposalId,
        input.result.kind === "success" ? "executed" : "failed",
        input.result.kind === "success" ? "executed" : "failed",
        input.toolName,
        input.result.kind === "success" && input.result.compensationArgs
          ? JSON.stringify(input.result.compensationArgs) : null,
        input.result.kind === "success" && input.result.preview
          ? JSON.stringify(input.result.preview) : null],
    );
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "tool_completed", { proposalId: input.proposalId, tool: input.toolName,
        status: input.result.kind === "success" ? "success" : "error" });
    if (input.result.kind === "success")
      await appendWorkbenchEventTx(client, input.organizationId, input.runId,
        "crm_state_changed", { proposalId: input.proposalId, tool: input.toolName,
          ...(input.result.preview ? {
            targetId: input.result.preview.resourceUuid,
            changedFields: input.result.preview.changedFields,
          } : {}) });
    if (run.status === "cancelled") return "cancelled";

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
         where organization_id=$1 and id=$2 and status='running'`,
        [input.organizationId, input.runId],
      );
      await client.query(
        `update public.ai_agent_action_proposals set status='cancelled'
         where organization_id=$1 and run_id=$2 and status='pending'`,
        [input.organizationId, input.runId],
      );
      await client.query(
        `update public.ai_reply_drafts
         set status='stale',error_code='resume_state_missing'
         where organization_id=$1 and workbench_run_id=$2 and status='pending'`,
        [input.organizationId, input.runId],
      );
      await appendWorkbenchEventTx(client, input.organizationId, input.runId,
        "run_partial", { status: "partial", reason: "resume_state_missing",
          pendingProposals: 0 });
      return "partial";
    }
    const observation = input.result.kind === "success"
      ? { tool: input.toolName, status: "executed" as const, result: input.result.output }
      : { tool: input.toolName, status: "failed" as const,
          result: { error: input.result.code } };
    await client.query(
      `update public.ai_agent_run_states set messages=$3::jsonb
       where organization_id=$1 and run_id=$2`,
      [input.organizationId, input.runId,
        JSON.stringify(appendWorkbenchObservation(messages, observation))],
    );
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
      return "awaiting_confirmation";
    }
    await client.query(
      `insert into public.job_queue
       (organization_id,kind,source_event_id,payload,max_attempts)
       values ($1,'workbench_resume',$2,jsonb_build_object('runId',$3::uuid),3)`,
      [input.organizationId, input.proposalId, input.runId],
    );
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "run_resumed", { proposalId: input.proposalId });
    return "queued";
  });
}

/** A started non-idempotent tool cannot be replayed after an uncertain crash. */
export async function markWorkbenchApprovedActionUncertain(pool: Pool, input: {
  organizationId: string; runId: string; proposalId: string;
}): Promise<boolean> {
  return transaction(pool, async (client) => {
    const { rows: runs } = await client.query<{ status: string }>(
      `select status from public.ai_workbench_runs
       where organization_id=$1 and id=$2 and run_kind='root' for update`,
      [input.organizationId, input.runId],
    );
    if (!runs[0]) return false;
    const { rows: proposals } = await client.query<{ status: string; tool_name: string }>(
      `select status,tool_name from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and id=$3 for update`,
      [input.organizationId, input.runId, input.proposalId],
    );
    if (proposals[0]?.status !== "approved") return false;
    await client.query(
      `update public.ai_agent_action_proposals
       set status='failed',result_summary=$4::jsonb
       where organization_id=$1 and run_id=$2 and id=$3 and status='approved'`,
      [input.organizationId, input.runId, input.proposalId,
        JSON.stringify({ outcome: "reconciliation_required", code: "effect_may_have_completed" })],
    );
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "tool_completed", { proposalId: input.proposalId,
        tool: proposals[0].tool_name, status: "unknown" });
    if (runs[0].status === "running") {
      await client.query(
        `update public.ai_workbench_runs
         set status='partial',error_code='approved_action_outcome_unknown',completed_at=now()
         where organization_id=$1 and id=$2 and status='running'`,
        [input.organizationId, input.runId],
      );
      await client.query(
        `update public.ai_agent_action_proposals set status='cancelled'
         where organization_id=$1 and run_id=$2 and status='pending'`,
        [input.organizationId, input.runId],
      );
      await client.query(
        `update public.ai_reply_drafts
         set status='stale',error_code='approved_action_outcome_unknown'
         where organization_id=$1 and workbench_run_id=$2 and status='pending'`,
        [input.organizationId, input.runId],
      );
      await appendWorkbenchEventTx(client, input.organizationId, input.runId,
        "run_partial", { status: "partial", pendingProposals: 0,
          reason: "approved_action_outcome_unknown" });
    }
    return true;
  });
}

/** Repair abandoned HTTP approvals without re-entering the CRM tool. */
export async function reconcileStaleWorkbenchApprovedActions(
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
     where p.status='approved' and p.tool_name<>'send_message'
       and p.decision_at < now()-interval '6 minutes'
       and r.run_kind='root'
     order by p.decision_at limit $1`,
    [Math.max(1, Math.min(limit, 100))],
  );
  let marked = 0;
  for (const row of rows) {
    try {
      if (await markWorkbenchApprovedActionUncertain(pool, {
        organizationId: row.organization_id, runId: row.run_id,
        proposalId: row.proposal_id,
      })) marked += 1;
    } catch (error) {
      onError?.({ organizationId: row.organization_id,
        runId: row.run_id, proposalId: row.proposal_id,
        code: error && typeof error === "object" && "code" in error
          ? String(error.code) : "recovery_failed" });
    }
  }
  return marked;
}
