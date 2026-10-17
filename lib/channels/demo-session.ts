import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";

/**
 * Ensure an isolated, stopped channel row for CRM demo conversations.
 *
 * The returned row is a CRM fixture only: it has no live provider credentials
 * and is never started. Channel storage details stay behind the channel seam
 * so demo/CRM features do not depend on a transport's schema.
 */
export async function ensureStoppedDemoChannelSession(
  admin: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<string> {
  const displayName = "演示会话（已停止，不连接外部渠道）";
  const sessionRef = "crm-workbench-demo-stopped";
  const base = () =>
    admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("waha_session_name", sessionRef);
  const {
    data: existing,
    error: readError,
    schemaOutdated,
  } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (readError) throw new Error(`无法读取演示会话渠道：${readError.message}`);
  if (existing) {
    const id = (existing as { id: string }).id;
    let updateQuery = admin
      .from("channel_sessions")
      .update({ status: "STOPPED", display_name: displayName })
      .eq("organization_id", organizationId)
      .eq("id", id);
    if (!schemaOutdated) updateQuery = updateQuery.is(ARCHIVED_AT, null);
    const { error } = await updateQuery;
    if (error) throw new Error(`无法确保演示渠道已停止：${error.message}`);
    return id;
  }

  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: organizationId,
      waha_session_name: sessionRef,
      display_name: displayName,
      webhook_secret_encrypted: "\\x00",
      status: "STOPPED",
      created_by: userId,
    } as never)
    .select("id")
    .single();
  if (error || !data) throw new Error(`无法创建演示会话渠道：${error?.message ?? "未知错误"}`);
  return (data as { id: string }).id;
}
