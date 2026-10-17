import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { explicitOfferTermsSchema } from "@/lib/ai/evals/mission-explicit-offer";
import { evaluateExplicitOffer } from "@/lib/ai/evals/mission-explicit-offer-evidence";
import {
  ExplicitOfferError, issueMissionExplicitOffer,
} from "@/lib/ai/evals/mission-explicit-offer-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type RouteCtx = { params: Promise<{ id: string }> };
const bodySchema = z.object({
  conversationId: z.string().uuid(),
  terms: explicitOfferTermsSchema,
}).strict();
const privateHeaders = { "Cache-Control": "private, no-store" };

/** Reads channel evidence for normalized terms; never trusts the Agent's own completion claim. */
export async function GET(_request: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "任务 ID 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  try {
    const pool = getRequestPool();
    const { rows } = await pool.query<{ id: string; contact_id: string | null }>(
      `select m.id,l.contact_id from public.ai_missions m
       join public.crm_leads l on l.organization_id=m.organization_id and l.id=m.lead_id
       where m.organization_id=$1 and m.id=$2`,
      [authz.org.orgId, id],
    );
    if (!rows[0]) return fail("not_found", "任务不存在。", 404, { requestId });
    const { rows: conversations } = rows[0].contact_id
      ? await pool.query<{ id: string; last_message_preview: string | null }>(
        `select id,last_message_preview from public.conversations
         where organization_id=$1 and contact_id=$2 and channel='whatsapp'
           and is_group=false
         order by last_message_at desc nulls last,id desc limit 30`,
        [authz.org.orgId, rows[0].contact_id],
      ) : { rows: [] };
    const evidence = await evaluateExplicitOffer(pool, authz.org.orgId, id);
    return ok({ ...evidence, eligibleConversations: conversations.map((item) => ({
      id: item.id, label: item.last_message_preview?.slice(0, 60) || "WhatsApp 会话",
    })) }, { requestId, headers: privateHeaders });
  } catch {
    return fail("explicit_offer_evidence_unavailable", "无法核对报价确认凭证。", 503,
      { requestId });
  }
}

/** Fixing an offer is not sending it. The existing Agent proposal and human send gate remain mandatory. */
export async function POST(request: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "任务 ID 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite(authz.org.orgId);
  if (supportDenied) return supportDenied;
  const key = request.headers.get("Idempotency-Key");
  if (!z.string().uuid().safeParse(key).success)
    return fail("invalid_request", "需要有效的幂等请求 ID。", 400, { requestId });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success)
    return fail("validation_failed", "报价、交期或会话无效。", 422, { requestId });
  try {
    const issued = await issueMissionExplicitOffer(getRequestPool(), {
      organizationId: authz.org.orgId, missionId: id, actorUserId: authz.user.id,
      conversationId: body.data.conversationId, requestKey: key!, terms: body.data.terms,
    });
    if (!issued.replayed) void audit({
      action: "ai_mission.explicit_offer_issued",
      actorUserId: authz.user.id, organizationId: authz.org.orgId,
      resourceType: "ai_mission", resourceId: id, requestId,
      metadata: { offer_id: issued.id },
    });
    return ok(issued, { requestId, headers: privateHeaders,
      status: issued.replayed ? 200 : 201 });
  } catch (error) {
    if (error instanceof ExplicitOfferError) {
      const code = error.code;
      return fail(`explicit_offer_${code}`,
        code === "not_found" ? "任务不存在。" : code === "forbidden" ? "负责人权限已失效。"
          : code === "conversation_invalid" ? "会话不属于商机客户或不是一对一 WhatsApp 会话。"
            : code === "request_conflict" ? "相同请求 ID 对应不同报价内容。"
              : "任务已结束、截止或客户发送已暂停。",
        code === "not_found" ? 404 : code === "forbidden" ? 403 : 409,
        { requestId });
    }
    return fail("explicit_offer_unavailable", "无法固定报价与交期，请重试。", 503,
      { requestId });
  }
}
