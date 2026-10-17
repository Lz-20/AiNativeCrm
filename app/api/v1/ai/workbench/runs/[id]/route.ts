import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadWorkbenchObservedEvidence } from "@/lib/ai/agents/workbench-observed-evidence";

export const dynamic = "force-dynamic";
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "run id 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  const { data: run, error } = await admin.from("ai_workbench_runs")
    .select("id, organization_id, agent_id, mission_id, actor_user_id, task, mode, scope, status, runtime_state, final_text, result_document, error_code, error_summary, budget, started_at, completed_at, created_at, updated_at")
    .eq("organization_id", authz.org.orgId).eq("id", id).maybeSingle();
  if (error) return fail("internal_error", "无法读取工作台运行。", 500, { requestId });
  if (!run) return fail("not_found", "run 不存在。", 404, { requestId });
  const material = await Promise.all([
    admin.from("ai_agent_run_events").select("id, sequence, event_type, payload, created_at").eq("organization_id", authz.org.orgId).eq("run_id", id).order("sequence", { ascending: true }),
    admin.from("ai_agent_action_proposals").select("id, sequence, tool_name, preview, status, decision_reason, decision_at, result_summary, compensation_args, created_at").eq("organization_id", authz.org.orgId).eq("run_id", id).order("sequence", { ascending: true }),
    admin.from("ai_workbench_runs")
      .select("id, specialist_key, collaboration_key, status, error_code, started_at, completed_at, created_at")
      .eq("organization_id", authz.org.orgId)
      .eq("parent_run_id", id)
      .eq("run_kind", "specialist")
      .order("created_at", { ascending: true }),
    run.mission_id
      ? admin.from("ai_missions")
          .select("id, lead_id, goal, acceptance_criteria, acceptance_contract, customer_send_paused, send_policy_revision, status, blocked_reason, resolution_reason, max_runs, max_total_tokens, max_total_cost_cents, deadline_at, wake_on_customer_reply, created_at, updated_at")
          .eq("organization_id", authz.org.orgId).eq("id", run.mission_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  if (material.some((item) => "error" in item && item.error))
    return fail("internal_error", "运行材料读取不完整，请重试。", 500, { requestId });
  const [{ data: events }, { data: proposals }, { data: specialists }, { data: mission }] = material;
  let observedEvidence;
  try {
    observedEvidence = await loadWorkbenchObservedEvidence(admin, {
      organizationId: authz.org.orgId, agentId: run.agent_id,
      runIds: [id, ...(specialists ?? []).map((child) => child.id)],
    });
  } catch {
    return fail("internal_error", "无法核对本次运行的知识证据，请重试。", 500, { requestId });
  }
  // Reply bodies are read through the authenticated user's conversation RLS,
  // never copied into the manager-readable run or event ledger.
  const userDb = await createClient();
  const { data: replyDrafts } = await userDb
    .from("ai_reply_drafts")
    .select("workbench_proposal_id, original_body")
    .eq("organization_id", authz.org.orgId)
    .eq("workbench_run_id", id)
    .not("workbench_proposal_id", "is", null);
  const draftByProposal = new Map(
    (replyDrafts ?? []).map((draft) => [draft.workbench_proposal_id, draft.original_body]),
  );
  return ok({
    ...run,
    events: events ?? [],
    proposals: (proposals ?? []).map(({ compensation_args, ...proposal }) => ({
      ...proposal,
      can_undo: Boolean(compensation_args),
      ...(draftByProposal.get(proposal.id) ? { draft_body: draftByProposal.get(proposal.id) } : {}),
    })),
    specialists: specialists ?? [],
    observed_evidence: observedEvidence,
    mission,
  }, { requestId });
}
