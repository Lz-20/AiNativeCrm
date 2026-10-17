import type { Queryable } from "@/lib/agent-engine/queue/queue";

export interface MissionCustomerResponseEvidence {
  outboundMessageId: string;
  reply: {
    id: string;
    contactId: string;
    conversationId: string;
    sentAt: string;
  } | null;
}

interface ResponseRow {
  outbound_message_id: string;
  reply_id: string | null;
  reply_contact_id: string | null;
  reply_conversation_id: string | null;
  reply_sent_at: Date | string | null;
}

/** Only metadata is returned. A later inbound text is engagement evidence, not acceptance. */
export async function loadMissionCustomerResponses(
  db: Queryable,
  organizationId: string,
  outboundMessageIds: string[],
): Promise<MissionCustomerResponseEvidence[]> {
  const ids = [...new Set(outboundMessageIds)];
  if (ids.length === 0) return [];
  const { rows } = await db.query<ResponseRow>(
    `select outbound.id as outbound_message_id,
            inbound.id as reply_id,inbound.contact_id as reply_contact_id,
            inbound.conversation_id as reply_conversation_id,inbound.sent_at as reply_sent_at
     from public.messages outbound
     left join lateral (
       select m.id,m.contact_id,m.conversation_id,m.sent_at
       from public.messages m
       where m.organization_id=$1 and m.contact_id=outbound.contact_id
         and m.conversation_id=outbound.conversation_id
         and m.direction='inbound' and m.type='text'
         and m.body is not null and m.sent_at>outbound.sent_at
       order by m.sent_at,m.id
       limit 1
     ) inbound on true
     where outbound.organization_id=$1 and outbound.id=any($2::uuid[])
       and outbound.direction='outbound'`,
    [organizationId, ids],
  );
  if (rows.length > ids.length ||
      rows.some((row) => !ids.includes(row.outbound_message_id)) ||
      new Set(rows.map((row) => row.outbound_message_id)).size !== rows.length)
    throw new Error("mission_customer_response_evidence_invalid");
  return rows.map((row) => ({
    outboundMessageId: row.outbound_message_id,
    reply: row.reply_id && row.reply_contact_id && row.reply_conversation_id && row.reply_sent_at
      ? {
          id: row.reply_id,
          contactId: row.reply_contact_id,
          conversationId: row.reply_conversation_id,
          sentAt: new Date(row.reply_sent_at).toISOString(),
        } : null,
  }));
}
