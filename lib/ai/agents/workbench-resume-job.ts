import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { Pool } from "pg";
import { appendWorkbenchEvent } from "@/lib/ai/agents/workbench-events";
import { parseRuntimeMessages } from "@/lib/ai/agents/workbench-state";
import { resolveWorkbenchScope } from "@/lib/ai/agents/workbench-scope";
import { runResumedWorkbenchTurn } from "@/lib/ai/agents/run-resumed-workbench-turn";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertWorkbenchJobLease } from "@/lib/ai/agents/workbench-job-lease";

/** Resume a confirmed run from the persisted CRM/Pi message snapshot. */
export async function runWorkbenchResumeJob(
  job: JobRow,
  pool: Pool,
  workerId: string,
): Promise<void> {
  const runId = job.payload.runId;
  if (typeof runId !== "string") throw new Error("workbench_resume_run_id_missing");

  const admin = createAdminClient();
  const beforeSideEffect = () => assertWorkbenchJobLease(pool, job, workerId);
  const { data: run, error: runError } = await admin
    .from("ai_workbench_runs")
    .select("id, agent_id, mission_id, task, mode, status, runtime_state, scope, budget, final_text")
    .eq("organization_id", job.organization_id)
    .eq("id", runId)
    .maybeSingle();
  if (runError) throw new Error("workbench_resume_run_read_failed");
  if (!run || run.status === "cancelled") return;
  if (run.status !== "running") return;
  await beforeSideEffect();

  const { data: state, error: stateError } = await admin
    .from("ai_agent_run_states")
    .select("messages")
    .eq("organization_id", job.organization_id)
    .eq("run_id", runId)
    .maybeSingle();
  const messages = stateError ? null : parseRuntimeMessages(state?.messages);
  const runtime = run.runtime_state as { versionId?: unknown } | null;
  if (!messages || typeof runtime?.versionId !== "string") {
    await beforeSideEffect();
    await admin
      .from("ai_workbench_runs")
      .update({
        status: "partial",
        error_code: "resume_state_missing",
        completed_at: new Date().toISOString(),
      })
      .eq("organization_id", job.organization_id)
      .eq("id", runId)
      .eq("status", "running");
    await appendWorkbenchEvent(admin, {
      organizationId: job.organization_id,
      runId,
      type: "run_partial",
      payload: { status: "partial", reason: "resume_state_missing" },
    });
    return;
  }

  const savedScope =
    run.scope && typeof run.scope === "object" ? (run.scope as Record<string, unknown>) : {};
  const scope = await resolveWorkbenchScope(admin, job.organization_id, {
    ...(typeof savedScope.contactId === "string" ? { contactId: savedScope.contactId } : {}),
    ...(typeof savedScope.leadId === "string" ? { leadId: savedScope.leadId } : {}),
    ...(typeof savedScope.conversationId === "string"
      ? { conversationId: savedScope.conversationId }
      : {}),
    ...(typeof savedScope.pipelineId === "string" ? { pipelineId: savedScope.pipelineId } : {}),
  });
  const budget =
    run.budget && typeof run.budget === "object"
      ? (run.budget as {
          maxSteps?: number | null;
          tokenBudget?: number | null;
          costBudgetCents?: number | null;
        })
      : {};
  await runResumedWorkbenchTurn({
    admin,
    organizationId: job.organization_id,
    runId,
    jobId: job.id,
    agentId: run.agent_id,
      missionId: run.mission_id,
      versionId: runtime.versionId,
      runtimeState: runtime,
    task: run.task,
    mode: run.mode as "inspect" | "act",
    scope,
    messages,
    budget,
    priorFinalText: run.final_text,
    beforeSideEffect,
  });
}
