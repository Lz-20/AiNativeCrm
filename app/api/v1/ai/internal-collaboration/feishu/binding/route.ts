import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import {
  FeishuBindingError, getFeishuBindingStatus, issueFeishuBinding,
} from "@/lib/ai/internal-collaboration/feishu-binding";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({ kind: z.enum(["tenant_owner", "member"]) }).strict();
const privateHeaders = { "Cache-Control": "private, no-store" };

function configured(): boolean {
  return Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET &&
    process.env.FEISHU_TENANT_KEY && process.env.FEISHU_EVENT_ENCRYPT_KEY &&
    process.env.FEISHU_EVENT_VERIFICATION_TOKEN);
}

export async function GET(_request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  if (!configured())
    return ok({ available: false, tenantBound: false, userBound: false,
      canClaimTenant: false }, { requestId, headers: privateHeaders });
  try {
    const status = await getFeishuBindingStatus(getRequestPool(), authz.org.orgId,
      authz.user.id, process.env.FEISHU_TENANT_KEY!);
    return ok({ available: true, ...status,
      canClaimTenant: !status.tenantBound &&
        process.env.FEISHU_TENANT_ORGANIZATION_ID === authz.org.orgId &&
        ["manager", "admin"].includes(authz.org.role),
    }, { requestId, headers: privateHeaders });
  } catch {
    return fail("internal_error", "无法读取飞书绑定状态。", 500, { requestId });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success)
    return fail("invalid_request", "绑定类型无效。", 400, { requestId });
  const authz = await requireRole(body.data.kind === "tenant_owner" ? "manager" : "agent",
    { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite(authz.org.orgId);
  if (supportDenied) return supportDenied;
  if (!configured())
    return fail("feishu_not_configured", "请先配置飞书应用和事件回调。", 503,
      { requestId });
  try {
    const result = await issueFeishuBinding(getRequestPool(), {
      organizationId: authz.org.orgId, userId: authz.user.id, kind: body.data.kind,
      tenantKey: process.env.FEISHU_TENANT_KEY!,
      ownerOrganizationId: process.env.FEISHU_TENANT_ORGANIZATION_ID ?? "",
    });
    void audit({
      action: "ai_internal.feishu_binding_started", actorUserId: authz.user.id,
      organizationId: authz.org.orgId, resourceType: "ai_internal_identity",
      requestId, metadata: { kind: body.data.kind },
    });
    return ok({ instruction: "请在飞书中私聊已安装的应用机器人，并发送以下整行口令。",
      message: `CRM-BIND ${result.token}`, expiresAt: result.expiresAt },
    { requestId, headers: privateHeaders });
  } catch (error) {
    if (error instanceof FeishuBindingError) {
      const status = error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : 503;
      const message = error.code === "forbidden" ? "此组织不能绑定该飞书租户。"
        : error.code === "conflict" ? "飞书租户已被其他组织绑定。"
          : "请先完成飞书租户安装与绑定。";
      return fail(`feishu_binding_${error.code}`, message, status, { requestId });
    }
    return fail("internal_error", "无法创建飞书绑定口令。", 500, { requestId });
  }
}
