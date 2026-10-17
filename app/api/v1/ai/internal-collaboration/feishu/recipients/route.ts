import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Only explicitly bound, active colleagues appear; external IDs stay server-side. */
export async function GET(_request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const tenantKey = process.env.FEISHU_TENANT_KEY ?? "";
  if (!tenantKey || !process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET)
    return ok({ available: false, recipients: [] }, { requestId });
  try {
    const { rows } = await getRequestPool().query<{
      user_id: string; full_name: string | null;
    }>(
      `select u.user_id,
              nullif(left(a.raw_user_meta_data->>'full_name',120),'') as full_name
       from public.ai_internal_platform_tenants t
       join public.ai_internal_platform_users u
         on u.organization_id=t.organization_id and u.provider=t.provider
        and u.tenant_key=t.tenant_key
       join public.user_organizations member
         on member.organization_id=u.organization_id and member.user_id=u.user_id
       left join auth.users a on a.id=u.user_id
       where t.organization_id=$1 and t.provider='feishu' and t.tenant_key=$2
         and t.active and u.active and member.revoked_at is null
         and member.accepted_at is not null and member.role in ('agent','manager','admin')
       order by full_name nulls last,u.user_id limit 100`,
      [authz.org.orgId, tenantKey],
    );
    return ok({ available: true, recipients: rows }, { requestId });
  } catch {
    return fail("internal_error", "无法读取已绑定的飞书同事。", 500, { requestId });
  }
}
