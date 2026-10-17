import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { loadMissionBudgetUsage, missionBudgetBlockReason } from "@/lib/ai/agents/mission-budget";

export const dynamic = "force-dynamic";
type RouteCtx = { params: Promise<{ id: string }> };
const decisionSchema = z.object({
  action: z.enum(["complete", "wait_for_customer", "wait_for_internal", "cancel"]),
  reason: z.string().trim().min(5).max(2000),
}).strict();

/** A human decision changes the business task, never an external channel directly. */
export async function POST(request: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "任务 ID 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite(authz.org.orgId);
  if (supportDenied) return supportDenied;
  let raw: unknown;
  try { raw = await request.json(); }
  catch { return fail("invalid_request", "请求体必须是 JSON。", 400, { requestId }); }
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success)
    return fail("validation_failed", "任务决定无效。", 422, { requestId });

  const admin = createAdminClient();
  const { data: mission, error: readError } = await admin.from("ai_missions")
    .select("id, lead_id, status, deadline_at")
    .eq("organization_id", authz.org.orgId).eq("id", id).maybeSingle();
  if (readError) return fail("internal_error", "无法读取任务状态。", 500, { requestId });
  if (!mission) return fail("not_found", "任务不存在。", 404, { requestId });
  if (["completed", "cancelled"].includes(mission.status))
    return fail("state_conflict", "任务已结束。", 409, { requestId });
  if (
    (parsed.data.action === "wait_for_customer" || parsed.data.action === "wait_for_internal") &&
    mission.deadline_at && new Date(mission.deadline_at).getTime() <= Date.now()
  ) return fail("mission_deadline_expired", "任务截止时间已过，不能继续等待。", 409, { requestId });
  if (parsed.data.action === "wait_for_customer") {
    const { data: lead, error: leadError } = await admin.from("crm_leads")
      .select("contact_id")
      .eq("organization_id", authz.org.orgId).eq("id", mission.lead_id)
      .maybeSingle();
    if (leadError) return fail("internal_error", "无法核对商机联系人。", 500, { requestId });
    if (!lead?.contact_id)
      return fail("mission_customer_unavailable", "商机没有关联客户，不能等待客户消息唤醒。", 409, { requestId });
  }
  if (parsed.data.action === "wait_for_customer" || parsed.data.action === "wait_for_internal") {
    try {
      const usage = await loadMissionBudgetUsage(getRequestPool(), authz.org.orgId, id);
      if (!usage) return fail("mission_budget_unavailable", "无法核对任务预算。", 503, { requestId });
      const budgetBlock = missionBudgetBlockReason(usage);
      if (budgetBlock)
        return fail("mission_budget_exhausted", "任务累计模型预算已用尽或成本未知，不能继续自动等待。", 409, { requestId });
    } catch {
      return fail("mission_budget_unavailable", "无法核对任务预算。", 503, { requestId });
    }
  }

  if (parsed.data.action === "cancel") {
    // One database transaction fences the Mission, active Pi runs and pending
    // approvals together. A browser-side sequence of updates would leave a
    // window in which the already-approved reply could still leave the queue.
    let result: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { rows } = await getRequestPool().query<{ result: string }>(
          "select public.fn_cancel_ai_mission($1,$2,$3,$4) as result",
          [authz.org.orgId, id, authz.user.id, parsed.data.reason],
        );
        result = rows[0]?.result;
        break;
      } catch (error) {
        // An approval can be committing at the same time; PostgreSQL may
        // choose either transaction as a deadlock victim. Retry the whole
        // atomic cancellation, never a partial sequence of row updates.
        const code = error && typeof error === "object" && "code" in error
          ? error.code : null;
        if (attempt === 2 || (code !== "40P01" && code !== "40001"))
          return fail("internal_error", "无法安全取消任务，请重试。", 500, { requestId });
      }
    }
    if (result === "not_found") return fail("not_found", "任务不存在。", 404, { requestId });
    if (result !== "cancelled")
      return fail("state_conflict", "任务已结束或状态已变化。", 409, { requestId });
    void audit({
      action: "ai_mission.cancel",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "ai_mission",
      resourceId: id,
      requestId,
    });
    return ok({
      id, status: "cancelled", blocked_reason: parsed.data.reason,
      resolution_reason: parsed.data.reason,
    }, { requestId });
  }

  const { data: activeRun, error: runError } = await admin.from("ai_workbench_runs")
    .select("id")
    .eq("organization_id", authz.org.orgId).eq("mission_id", id)
    .in("status", ["queued", "running", "awaiting_confirmation"])
    .limit(1).maybeSingle();
  if (runError) return fail("internal_error", "无法核对任务执行状态。", 500, { requestId });
  if (activeRun)
    return fail("state_conflict", "关联运行仍在执行或等待审批，请先处理该运行。", 409, { requestId });

  const status = parsed.data.action === "complete"
    ? "completed"
    : parsed.data.action === "wait_for_customer"
      ? "waiting_customer"
      : parsed.data.action === "wait_for_internal"
        ? "waiting_internal"
        : "cancelled";
  const { data: updated, error: updateError } = await admin.from("ai_missions")
    .update({
      status,
      blocked_reason: status === "completed" ? null : parsed.data.reason,
      wake_on_customer_reply: status === "waiting_customer",
      completed_at: status === "completed" || status === "cancelled" ? new Date().toISOString() : null,
      resolution_reason: status === "completed" || status === "cancelled" ? parsed.data.reason : null,
      resolved_by_user_id: status === "completed" || status === "cancelled" ? authz.user.id : null,
    })
    .eq("organization_id", authz.org.orgId).eq("id", id).eq("status", mission.status)
    .select("id, status, blocked_reason, resolution_reason, updated_at").maybeSingle();
  if (updateError) return fail("internal_error", "无法更新任务状态。", 500, { requestId });
  if (!updated) return fail("state_conflict", "任务状态已变化，请刷新后重试。", 409, { requestId });
  void audit({
    action: `ai_mission.${parsed.data.action}`,
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ai_mission",
    resourceId: id,
    requestId,
  });
  return ok(updated, { requestId });
}
