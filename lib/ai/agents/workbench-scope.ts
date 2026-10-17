import type { createAdminClient } from "@/lib/supabase/admin";

export interface WorkbenchScopeInput {
  contactId?: string;
  leadId?: string;
  conversationId?: string;
  pipelineId?: string;
}

export async function resolveWorkbenchScope(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  scope?: WorkbenchScopeInput,
) {
  let contactId = scope?.contactId ?? null;
  const leadId = scope?.leadId ?? null;
  const conversationId = scope?.conversationId ?? null;
  let pipelineId = scope?.pipelineId ?? null;
  let channelId: string | null = null;
  let replyContextRevision: number | null = null;
  if (leadId) {
    const { data, error } = await admin
      .from("crm_leads")
      .select("id, contact_id, pipeline_id")
      .eq("organization_id", organizationId)
      .eq("id", leadId)
      .maybeSingle();
    if (error || !data) throw new Error("lead_not_found");
    if (contactId && contactId !== data.contact_id) throw new Error("scope_mismatch");
    if (pipelineId && pipelineId !== data.pipeline_id) throw new Error("scope_mismatch");
    pipelineId = data.pipeline_id;
    contactId = data.contact_id;
  }
  if (conversationId) {
    const { data, error } = await admin
      .from("conversations")
      .select("id, contact_id, channel_session_id, reply_context_revision")
      .eq("organization_id", organizationId)
      .eq("id", conversationId)
      .maybeSingle();
    if (error || !data) throw new Error("conversation_not_found");
    if (contactId && contactId !== data.contact_id) throw new Error("scope_mismatch");
    contactId = data.contact_id;
    channelId = data.channel_session_id;
    replyContextRevision = data.reply_context_revision;
  }
  if (pipelineId) {
    const { data, error } = await admin
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", pipelineId)
      .eq("is_archived", false)
      .maybeSingle();
    if (error || !data) throw new Error("pipeline_not_found");
  }
  let contact: { name?: string; phone?: string } | undefined;
  if (contactId) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, name, phone_number")
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle();
    if (error || !data) throw new Error("contact_not_found");
    contact = { name: data.name ?? undefined, phone: data.phone_number ?? undefined };
  }
  return { contactId, conversationId, channelId, leadId, pipelineId, contact, replyContextRevision };
}
