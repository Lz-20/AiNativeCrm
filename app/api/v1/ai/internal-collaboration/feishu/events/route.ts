import type { NextRequest } from "next/server";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import { MissionInternalResponseError } from "@/lib/ai/agents/mission-internal-response";
import { consumeFeishuBinding } from "@/lib/ai/internal-collaboration/feishu-binding";
import { persistFeishuMissionEvent } from "@/lib/ai/internal-collaboration/feishu-mission";
import { FeishuWebhookError, parseFeishuWebhook } from "@/lib/ai/internal-collaboration/feishu-webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** This endpoint accepts facts only. Card approval has a separate trust path. */
export async function POST(request: NextRequest): Promise<Response> {
  if (Number(request.headers.get("content-length")) > 65_536)
    return Response.json({ code: 400, msg: "payload_too_large" }, { status: 413 });
  let body: string;
  try { body = await request.text(); }
  catch { return Response.json({ code: 400, msg: "invalid_payload" }, { status: 400 }); }
  let event;
  try {
    event = parseFeishuWebhook(body, request.headers, {
      appId: process.env.FEISHU_APP_ID ?? "",
      encryptKey: process.env.FEISHU_EVENT_ENCRYPT_KEY ?? "",
      verificationToken: process.env.FEISHU_EVENT_VERIFICATION_TOKEN ?? "",
    });
  } catch (error) {
    if (error instanceof FeishuWebhookError)
      return Response.json({ code: 1, msg: error.code }, {
        status: error.code === "invalid_config" ? 503
          : error.code === "invalid_signature" ? 401 : 400,
      });
    return Response.json({ code: 1, msg: "invalid_payload" }, { status: 400 });
  }
  if (event.kind === "challenge") return Response.json({ challenge: event.challenge });
  if (event.kind === "ignored") return Response.json({ code: 0, msg: "ignored" });
  if (event.kind === "binding_request") {
    try {
      const result = await consumeFeishuBinding(getRequestPool(), event,
        process.env.FEISHU_TENANT_KEY ?? "",
        process.env.FEISHU_TENANT_ORGANIZATION_ID ?? "");
      if (result.status === "bound") {
        void audit({
          action: "ai_internal.feishu_binding_completed",
          actorUserId: result.userId!, organizationId: result.organizationId!,
          resourceType: "ai_internal_identity",
          metadata: { provider: "feishu" },
        });
      }
      return Response.json({ code: 0, msg: result.status });
    } catch {
      return Response.json({ code: 1, msg: "unavailable" }, { status: 503 });
    }
  }
  try {
    const result = await persistFeishuMissionEvent(getRequestPool(), event);
    return Response.json({ code: 0, msg: result ? "accepted" : "unbound" });
  } catch (error) {
    // Never echo event content or a CRM identifier to the external caller.
    if (error instanceof MissionInternalResponseError)
      return Response.json({ code: 1, msg: error.code }, { status: 409 });
    return Response.json({ code: 1, msg: "unavailable" }, { status: 503 });
  }
}
