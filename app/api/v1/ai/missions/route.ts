import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

export const dynamic = "force-dynamic";

const querySchema = z.object({ leadId: z.string().uuid() }).strict();

/** List delegated business outcomes beside the CRM opportunity that owns them. */
export async function GET(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const parsed = querySchema.safeParse({ leadId: request.nextUrl.searchParams.get("leadId") });
  if (!parsed.success) return fail("validation_failed", "商机 ID 无效。", 422, { requestId });
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_missions")
    .select("id, lead_id, goal, acceptance_criteria, current_direction, direction_revision, direction_consumed_revision, acceptance_contract, customer_send_paused, send_policy_revision, status, blocked_reason, resolution_reason, max_runs, max_total_tokens, max_total_cost_cents, wake_on_customer_reply, deadline_at, completed_at, created_at, updated_at")
    .eq("organization_id", authz.org.orgId)
    .eq("lead_id", parsed.data.leadId)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return fail("internal_error", "无法读取商机业务任务。", 500, { requestId });
  const missions = data ?? [];
  if (missions.length === 0) return ok([], { requestId });
  const { data: runs, error: runsError, count: runsCount } = await admin.from("ai_workbench_runs")
    .select("id, mission_id", { count: "exact" })
    .eq("organization_id", authz.org.orgId)
    .eq("run_kind", "root")
    .in("mission_id", missions.map((mission) => mission.id))
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(300);
  if (runsError) return fail("internal_error", "无法读取任务执行记录。", 500, { requestId });
  if (runsCount !== (runs?.length ?? 0))
    return fail("mission_history_incomplete", "任务执行历史超过单次读取上限，无法确定最近一次执行。", 409, { requestId });
  const latestRunByMission = new Map<string, string>();
  for (const run of runs ?? []) {
    if (run.mission_id && !latestRunByMission.has(run.mission_id))
      latestRunByMission.set(run.mission_id, run.id);
  }
  let latestQuestionByMission: Map<string, string>;
  try {
    const { rows } = await getRequestPool().query<{
      mission_id: string; status: string;
    }>(
      `select distinct on (mission_id) mission_id,status
       from public.ai_internal_question_outbox
       where organization_id=$1 and mission_id=any($2::uuid[])
       order by mission_id,created_at desc,id desc`,
      [authz.org.orgId, missions.map((mission) => mission.id)],
    );
    latestQuestionByMission = new Map(rows.map((row) => [row.mission_id, row.status]));
  } catch {
    return fail("internal_error", "无法读取内部提问状态。", 500, { requestId });
  }
  return ok(missions.map((mission) => ({
    ...mission,
    latest_run_id: latestRunByMission.get(mission.id) ?? null,
    latest_question_status: latestQuestionByMission.get(mission.id) ?? null,
  })), { requestId });
}
