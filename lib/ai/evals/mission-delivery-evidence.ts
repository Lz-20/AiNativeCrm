import type { Queryable } from "@/lib/agent-engine/queue/queue";

export interface MissionReplyDeliveryEvidence {
  proposalId: string;
  status: string;
  messageId: string | null;
  contactId: string;
  conversationId: string;
  sendJobId: string | null;
  approvedAt: string | null;
  approvedBodyMatchesLedger: boolean | null;
  ledger: {
    idempotencyKey: string;
    jobId: string;
    status: string;
    messageId: string | null;
    contactId: string | null;
  } | null;
  message: {
    id: string;
    idempotencyKey: string | null;
    contactId: string;
    conversationId: string;
    direction: string;
    status: string;
    sentVia: string;
    sentAt: string;
    bodyMatchesLedger: boolean | null;
  } | null;
}

interface DeliveryRow {
  proposal_id: string;
  draft_status: string;
  draft_message_id: string | null;
  draft_contact_id: string;
  draft_conversation_id: string;
  send_job_id: string | null;
  approved_at: Date | string | null;
  approved_body_matches_ledger: boolean | null;
  ledger_job_id: string | null;
  ledger_idempotency_key: string | null;
  ledger_status: string | null;
  ledger_message_id: string | null;
  ledger_contact_id: string | null;
  actual_message_id: string | null;
  message_idempotency_key: string | null;
  message_contact_id: string | null;
  message_conversation_id: string | null;
  message_direction: string | null;
  message_status: string | null;
  message_sent_via: string | null;
  message_sent_at: Date | string | null;
  message_body_matches_ledger: boolean | null;
}

function instant(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Read only receipt metadata and in-database body-hash comparisons; never
 * fetch the message body or approved draft text. Every join is organization-scoped. A missing linked row remains
 * missing evidence, not an inferred successful delivery.
 */
export async function loadMissionDeliveryEvidence(
  db: Queryable,
  organizationId: string,
  sendProposalIds: string[],
): Promise<MissionReplyDeliveryEvidence[]> {
  if (sendProposalIds.length === 0) return [];
  const { rows } = await db.query<DeliveryRow>(
    `select d.workbench_proposal_id as proposal_id,
            d.status as draft_status,d.message_id as draft_message_id,
            d.contact_id as draft_contact_id,d.conversation_id as draft_conversation_id,
            d.send_job_id,d.approved_at,
            l.body_hash=encode(sha256(convert_to(d.approved_body,'UTF8')),'hex') as approved_body_matches_ledger,
            l.id::text as ledger_idempotency_key,l.job_id as ledger_job_id,l.status as ledger_status,
            l.crm_message_id as ledger_message_id,l.contact_id as ledger_contact_id,
            m.id as actual_message_id,m.metadata->>'idempotency_key' as message_idempotency_key,
            m.contact_id as message_contact_id,
            m.conversation_id as message_conversation_id,m.direction as message_direction,
            m.status as message_status,m.sent_via as message_sent_via,m.sent_at as message_sent_at,
            l.body_hash=encode(sha256(convert_to(m.body,'UTF8')),'hex') as message_body_matches_ledger
     from public.ai_reply_drafts d
     left join public.send_ledger l on l.organization_id=d.organization_id
       and l.job_id=d.send_job_id and l.seq=1
     left join public.messages m on m.organization_id=d.organization_id
       and m.id=d.message_id
     where d.organization_id=$1 and d.workbench_proposal_id=any($2::uuid[])`,
    [organizationId, sendProposalIds],
  );
  if (rows.length > sendProposalIds.length ||
      new Set(rows.map((row) => row.proposal_id)).size !== rows.length)
    throw new Error("mission_delivery_evidence_duplicate");
  return rows.map((row) => ({
    proposalId: row.proposal_id,
    status: row.draft_status,
    messageId: row.draft_message_id,
    contactId: row.draft_contact_id,
    conversationId: row.draft_conversation_id,
    sendJobId: row.send_job_id,
    approvedAt: instant(row.approved_at),
    approvedBodyMatchesLedger: row.approved_body_matches_ledger,
    ledger: row.ledger_idempotency_key && row.ledger_job_id && row.ledger_status ? {
      idempotencyKey: row.ledger_idempotency_key,
      jobId: row.ledger_job_id,
      status: row.ledger_status,
      messageId: row.ledger_message_id,
      contactId: row.ledger_contact_id,
    } : null,
    message: row.actual_message_id && row.message_contact_id && row.message_conversation_id &&
      row.message_direction && row.message_status && row.message_sent_via && row.message_sent_at ? {
      id: row.actual_message_id,
      idempotencyKey: row.message_idempotency_key,
      contactId: row.message_contact_id,
      conversationId: row.message_conversation_id,
      direction: row.message_direction,
      status: row.message_status,
      sentVia: row.message_sent_via,
      sentAt: instant(row.message_sent_at) ?? "",
      bodyMatchesLedger: row.message_body_matches_ledger,
    } : null,
  }));
}
