import type { Admin } from "@/lib/waha/ingest";
import { logger } from "@/lib/logger";

/** Best-effort linkage: failure withholds business proof, never blocks inbox ingestion. */
export function signedInboundWitness(admin: Admin, input: {
  eventId: string;
  organizationId: string;
  channelSessionId: string;
}): (messageId: string) => Promise<void> {
  return async (messageId) => {
    try {
      const { data, error } = await admin.from("webhook_events_log")
        .update({ crm_inbound_message_id: messageId } as never)
        .eq("id", input.eventId)
        .eq("organization_id", input.organizationId)
        .eq("channel_session_id", input.channelSessionId)
        .eq("valid_signature", true)
        .is("crm_inbound_message_id", null)
        .select("id").maybeSingle();
      if (!error && data) return;
      logger.warn("waha.webhook: signed inbound witness not persisted", {
        organization_id: input.organizationId,
        channel_session_id: input.channelSessionId,
        event_id: input.eventId,
        message_id: messageId,
        error_code: error?.code ?? "no_row",
      });
    } catch {
      logger.warn("waha.webhook: signed inbound witness unavailable", {
        organization_id: input.organizationId,
        channel_session_id: input.channelSessionId,
        event_id: input.eventId,
        message_id: messageId,
      });
    }
  };
}
