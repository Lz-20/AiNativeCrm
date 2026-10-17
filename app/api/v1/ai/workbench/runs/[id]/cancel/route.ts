import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { appendWorkbenchEvent } from "@/lib/ai/agents/workbench-events";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "run id 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite(authz.org.orgId);
  if (supportDenied) return supportDenied;
  const admin = createAdminClient();
  const { data: run } = await admin.from("ai_workbench_runs").select("id, status").eq("organization_id", authz.org.orgId).eq("id", id).maybeSingle();
  if (!run) return fail("not_found", "run 不存在。", 404, { requestId });
  if (["completed", "partial", "failed", "cancelled"].includes(run.status)) return fail("state_conflict", "run 已进入终态。", 409, { requestId });
  const { data: cancelled, error } = await admin.from("ai_workbench_runs").update({ status: "cancelled", completed_at: new Date().toISOString(), error_code: "user_cancelled" }).eq("organization_id", authz.org.orgId).eq("id", id).in("status", ["queued", "running", "awaiting_confirmation"]).select("id").maybeSingle();
  if (error) return fail("internal_error", "无法取消 run。", 500, { requestId });
  if (!cancelled) return fail("state_conflict", "run 已进入终态。", 409, { requestId });
  const { data: activeChildren } = await admin
    .from("ai_workbench_runs")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("parent_run_id", id)
    .eq("run_kind", "specialist")
    .in("status", ["queued", "running"]);
  for (const child of activeChildren ?? []) {
    const { data: childCancelled } = await admin
      .from("ai_workbench_runs")
      .update({
        status: "cancelled",
        completed_at: new Date().toISOString(),
        error_code: "parent_cancelled",
      })
      .eq("organization_id", authz.org.orgId)
      .eq("id", child.id)
      .in("status", ["queued", "running"])
      .select("id")
      .maybeSingle();
    if (childCancelled)
      await appendWorkbenchEvent(admin, {
        organizationId: authz.org.orgId,
        runId: child.id,
        type: "run_cancelled",
        payload: { actorUserId: authz.user.id },
      });
  }
  await admin.from("ai_agent_action_proposals").update({ status: "cancelled" }).eq("organization_id", authz.org.orgId).eq("run_id", id).eq("status", "pending");
  await appendWorkbenchEvent(admin, { organizationId: authz.org.orgId, runId: id, type: "run_cancelled", payload: { actorUserId: authz.user.id } });
  void audit({ action: "ai_workbench.run_cancelled", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "ai_workbench_run", resourceId: id, requestId });
  return ok({ id, status: "cancelled" }, { requestId });
}
