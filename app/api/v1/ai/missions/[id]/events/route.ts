import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "任务 ID 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const after = Number(request.nextUrl.searchParams.get("after") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0)
    return fail("validation_failed", "事件游标无效。", 422, { requestId });
  const admin = createAdminClient();
  const { data: mission, error: missionError } = await admin.from("ai_missions")
    .select("id").eq("organization_id", authz.org.orgId).eq("id", id).maybeSingle();
  if (missionError) return fail("internal_error", "无法读取任务。", 500, { requestId });
  if (!mission) return fail("not_found", "任务不存在。", 404, { requestId });
  const { data, error } = await admin.from("ai_mission_events")
    .select("id, event_type, from_status, to_status, created_at")
    .eq("organization_id", authz.org.orgId).eq("mission_id", id)
    .gt("id", after).order("id", { ascending: true }).limit(100);
  if (error) return fail("internal_error", "无法读取任务事件。", 500, { requestId });
  return ok(data ?? [], { requestId });
}
