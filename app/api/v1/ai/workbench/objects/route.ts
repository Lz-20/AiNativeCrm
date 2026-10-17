import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";

export const dynamic = "force-dynamic";
const querySchema = z.object({ kind: z.enum(["contact", "lead", "conversation", "pipeline"]), q: z.string().trim().max(100).default("") });

/** Tenant-scoped object picker for the workbench's optional CRM context. */
export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const parsed = querySchema.safeParse({ kind: req.nextUrl.searchParams.get("kind"), q: req.nextUrl.searchParams.get("q") ?? "" });
  if (!parsed.success) return fail("validation_failed", "CRM 对象筛选无效。", 422, { requestId });
  const admin = createAdminClient();
  const q = parsed.data.q.replace(/[%,()]/g, " ").trim();
  const orgId = authz.org.orgId;
  let query;
  switch (parsed.data.kind) {
    case "contact": {
      query = admin.from("contacts").select("id, name, display_name, phone_number, updated_at").eq("organization_id", orgId).is("is_merged_into", null).order("updated_at", { ascending: false }).limit(12);
      if (q) query = query.or(`display_name.ilike.%${q}%,name.ilike.%${q}%,phone_number.ilike.%${q}%`);
      break;
    }
    case "lead": {
      query = admin.from("crm_leads").select("id, title, status, value_cents, pipeline_id, contact_id, updated_at").eq("organization_id", orgId).order("updated_at", { ascending: false }).limit(12);
      if (q) query = query.ilike("title", `%${q}%`);
      break;
    }
    case "conversation": {
      query = admin.from("conversations").select("id, last_message_preview, contact_id, channel_session_id, last_message_at").eq("organization_id", orgId).order("last_message_at", { ascending: false }).limit(12);
      if (q) query = query.ilike("last_message_preview", `%${q}%`);
      break;
    }
    case "pipeline": {
      query = admin.from("crm_pipelines").select("id, name, updated_at").eq("organization_id", orgId).eq("is_archived", false).order("updated_at", { ascending: false }).limit(12);
      if (q) query = query.ilike("name", `%${q}%`);
      break;
    }
  }
  const { data, error } = await query;
  if (error) return fail("internal_error", "无法搜索 CRM 对象。", 500, { requestId });
  const items = (data ?? []).map((row) => {
    if (parsed.data.kind === "contact") {
      const item = row as { id: string; name: string | null; display_name: string | null; phone_number: string | null };
      return { id: item.id, label: rotuloDoContato(item), detail: item.phone_number ?? null };
    }
    if (parsed.data.kind === "lead") {
      const item = row as { id: string; title: string; status: string; pipeline_id: string; contact_id: string | null; value_cents: number | null };
      return { id: item.id, label: item.title, detail: `${item.status}${item.value_cents == null ? "" : ` · ${item.value_cents} cents`}`, pipelineId: item.pipeline_id, contactId: item.contact_id };
    }
    if (parsed.data.kind === "conversation") {
      const item = row as { id: string; last_message_preview: string | null; contact_id: string; channel_session_id: string };
      return { id: item.id, label: item.last_message_preview?.slice(0, 90) || "会话", detail: item.contact_id, contactId: item.contact_id, channelId: item.channel_session_id };
    }
    const item = row as { id: string; name: string };
    return { id: item.id, label: item.name, detail: null };
  });
  return ok(items, { requestId });
}
