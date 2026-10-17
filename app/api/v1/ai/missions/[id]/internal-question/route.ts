import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import {
  askFeishuColleague, InternalQuestionError,
} from "@/lib/ai/internal-collaboration/feishu-question";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type RouteCtx = { params: Promise<{ id: string }> };

const schema = z.object({
  recipientUserId: z.string().uuid(),
  requestKey: z.string().uuid(),
  question: z.string().trim().min(5).max(1_000),
}).strict();

/** A manager explicitly authorizes the exact employee and question text. */
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
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fail("validation_failed", "内部提问参数无效。", 422, { requestId });
  try {
    const result = await askFeishuColleague(getRequestPool(), {
      organizationId: authz.org.orgId, missionId: id,
      requesterUserId: authz.user.id,
      recipientUserId: parsed.data.recipientUserId,
      requestKey: parsed.data.requestKey,
      question: parsed.data.question,
    });
    if (!result.replayed) void audit({
      action: "ai_mission.internal_question_queued",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "ai_mission",
      resourceId: id,
      requestId,
      metadata: { questionId: result.questionId },
    });
    return ok(result, { requestId });
  } catch (error) {
    if (error instanceof InternalQuestionError) {
      const status = error.code === "not_found" ? 404
        : error.code === "input_invalid" ? 422
          : error.code === "channel_unavailable" ? 503 : 409;
      return fail(error.code, "无法安全提交内部提问，请核对任务、收件人和渠道配置。", status, { requestId });
    }
    return fail("internal_error", "内部提问暂不可用。", 500, { requestId });
  }
}
