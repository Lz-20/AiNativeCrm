import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import {
  MissionInternalResponseError,
  submitMissionManagerDirection,
} from "@/lib/ai/agents/mission-internal-response";

export const dynamic = "force-dynamic";
type RouteCtx = { params: Promise<{ id: string }> };
const inputSchema = z.object({ direction: z.string().trim().min(5).max(2000) }).strict();

/** Manager direction atomically supersedes an active or waiting Run. */
export async function POST(request: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "任务 ID 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite(authz.org.orgId);
  if (supportDenied) return supportDenied;
  const requestKey = request.headers.get("Idempotency-Key");
  if (!requestKey || !z.string().uuid().safeParse(requestKey).success)
    return fail("invalid_request", "需要有效的幂等请求 ID。", 400, { requestId });
  let raw: unknown;
  try { raw = await request.json(); }
  catch { return fail("invalid_request", "请求体必须是 JSON。", 400, { requestId }); }
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success)
    return fail("validation_failed", "补充方向需要 5 至 2000 个字符。", 422, { requestId });

  try {
    const result = await submitMissionManagerDirection(getRequestPool(), {
      organizationId: authz.org.orgId,
      missionId: id,
      actorUserId: authz.user.id,
      requestKey,
      content: parsed.data.direction,
    });
    if (!result.replayed) void audit({
      action: "ai_mission.manager_direction",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "ai_mission",
      resourceId: id,
      requestId,
    });
    return ok(result,
      { status: result.replayed ? 200 : 201, requestId });
  } catch (error) {
    if (error instanceof MissionInternalResponseError) {
      const messages: Record<typeof error.code, string> = {
        not_found: "任务不存在。",
        state_conflict: "当前任务状态不允许改方向，或旧运行正在处理关键操作；请刷新后重试。",
        deadline_expired: "任务截止时间已过，需人工复核。",
        continuation_unavailable: "运行状态或任务次数不允许续跑，请人工复核。",
        budget_unavailable: "无法核对任务预算，请稍后重试。",
        budget_exhausted: "任务累计预算已用尽，需人工复核。",
        agent_unavailable: "智能体版本或运行配置已变化，需人工复核。",
        source_conflict: "同一请求 ID 已提交不同内容，请刷新后重试。",
        source_unauthorized: "当前成员无权补充任务方向。",
        scope_conflict: "商机与会话的关联已变化，需人工复核。",
        input_invalid: "补充方向需要 5 至 2000 个字符。",
        send_policy_unavailable: "无法暂停旧客户发送，请稍后重试。",
      };
      const status = error.code === "not_found" ? 404
        : error.code === "source_unauthorized" ? 403
          : error.code === "input_invalid" ? 422
            : ["budget_unavailable", "send_policy_unavailable"].includes(error.code) ? 503 : 409;
      return fail(error.code, messages[error.code], status, { requestId });
    }
    return fail("internal_error", "无法安全保存方向并续跑任务，请重试。", 500, { requestId });
  }
}
