import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

export const dynamic = "force-dynamic";
type RouteCtx = { params: Promise<{ id: string }> };

const commandSchema = z.object({
  command: z.enum(["pause_customer_send", "resume_customer_send"]),
  reason: z.string().trim().min(5).max(2000),
  requestKey: z.string().uuid(),
}).strict();

/** A trusted Mission command updates policy in the same transaction as its audit row. */
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
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success)
    return fail("validation_failed", "任务命令无效。", 422, { requestId });
  let result: {
    result: string;
    paused?: boolean;
    revision?: number;
    commandId?: number;
  } | undefined;
  try {
    const { rows } = await getRequestPool().query<{ result: typeof result }>(
      "select public.fn_set_ai_mission_send_policy($1,$2,$3,$4,$5,$6) as result",
      [authz.org.orgId, id, authz.user.id, parsed.data.requestKey,
        parsed.data.command, parsed.data.reason],
    );
    result = rows[0]?.result;
  } catch {
    return fail("internal_error", "无法安全保存任务命令，请重试。", 500, { requestId });
  }
  if (!result) return fail("internal_error", "任务命令没有返回结果。", 500, { requestId });
  if (result.result === "not_found") return fail("not_found", "任务不存在。", 404, { requestId });
  if (result.result === "terminal") return fail("state_conflict", "任务已结束。", 409, { requestId });
  if (result.result === "source_conflict")
    return fail("idempotency_conflict", "同一请求 ID 已用于不同命令。", 409, { requestId });
  if (result.result === "unauthorized")
    return fail("forbidden", "当前成员无权修改任务发送策略。", 403, { requestId });
  if (!["changed", "unchanged", "replayed"].includes(result.result) ||
      typeof result.paused !== "boolean" || typeof result.revision !== "number")
    return fail("internal_error", "任务命令返回值无效。", 500, { requestId });
  return ok({ missionId: id, customerSendPaused: result.paused,
    policyRevision: result.revision, commandId: result.commandId ?? null,
    replayed: result.result === "replayed", changed: result.result === "changed" }, { requestId });
}

/** Manager-only replay of policy commands; no model or customer text is exposed. */
export async function GET(request: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "任务 ID 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const after = Number(request.nextUrl.searchParams.get("after") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0)
    return fail("validation_failed", "命令游标无效。", 422, { requestId });
  const admin = createAdminClient();
  const { data: mission, error: missionError } = await admin.from("ai_missions")
    .select("id").eq("organization_id", authz.org.orgId).eq("id", id).maybeSingle();
  if (missionError) return fail("internal_error", "无法读取任务。", 500, { requestId });
  if (!mission) return fail("not_found", "任务不存在。", 404, { requestId });
  const { data, error } = await admin.from("ai_mission_commands")
    .select("id, kind, reason, actor_user_id, changed, paused_after, policy_revision, created_at")
    .eq("organization_id", authz.org.orgId).eq("mission_id", id)
    .gt("id", after).order("id", { ascending: true }).limit(50);
  if (error) return fail("internal_error", "无法读取任务命令记录。", 500, { requestId });
  return ok(data ?? [], { requestId });
}
