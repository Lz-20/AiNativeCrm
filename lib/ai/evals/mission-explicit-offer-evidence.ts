import type { Pool, PoolClient } from "pg";
import { SIGNED_MESSAGE_RECEIPT_SQL } from "@/lib/channels/signed-receipt";
import { loadMissionDeliveryEvidence } from "@/lib/ai/evals/mission-delivery-evidence";
import { verifyCustomerDelivery } from "@/lib/ai/evals/evaluate-mission";
import { explicitOfferTermsSchema, formatExplicitOffer } from "@/lib/ai/evals/mission-explicit-offer";

export interface ExplicitOfferEvidence {
  offerId: string | null;
  verdict: "not_issued" | "not_sent" | "awaiting_reply" | "unverified" | "verified" |
    "expired" | "superseded" | "conflict";
  reason: string;
  terms: {
    description: string; amountMinor: number; currency: string; deliveryDate: string;
  } | null;
  offerText: string | null;
  acceptanceText: string | null;
  outboundMessageId: string | null;
  inboundMessageId: string | null;
  /** Exact channel-authored response proves only the normalized offer terms, not legal identity or all Mission criteria. */
  structuredTermsAccepted: boolean;
  legalIdentityVerified: false;
  businessOutcomeVerified: false;
}

interface OfferRow {
  id: string;
  contact_id: string;
  conversation_id: string;
  channel_session_id: string;
  description: string;
  amount_minor: string;
  currency: string;
  delivery_date: string;
  offer_text: string;
  acceptance_text: string;
  issued_at: Date;
  expires_at: Date;
  superseded_at: Date | null;
  direction_revision: string;
  mission_direction_revision: string;
  mission_status: string;
  lead_contact_id: string | null;
}

interface OutboundRow {
  proposal_id: string;
  message_id: string;
  sent_at: Date;
}

interface InboundRow { id: string; sent_at: Date }

function response(
  offer: OfferRow | null, verdict: ExplicitOfferEvidence["verdict"], reason: string,
  outboundMessageId: string | null = null, inboundMessageId: string | null = null,
): ExplicitOfferEvidence {
  const amount = offer ? Number(offer.amount_minor) : null;
  if (amount !== null && !Number.isSafeInteger(amount))
    throw new Error("explicit_offer_amount_invalid");
  return {
    offerId: offer?.id ?? null, verdict, reason,
    terms: offer && amount !== null ? {
      description: offer.description, amountMinor: amount, currency: offer.currency,
      deliveryDate: offer.delivery_date,
    } : null,
    offerText: offer?.offer_text ?? null,
    acceptanceText: offer?.acceptance_text ?? null,
    outboundMessageId, inboundMessageId,
    structuredTermsAccepted: verdict === "verified",
    legalIdentityVerified: false, businessOutcomeVerified: false,
  };
}

/** Evidence is read directly from CRM facts, never from the Agent's final text. */
export async function evaluateExplicitOffer(
  pool: Pool, organizationId: string, missionId: string,
): Promise<ExplicitOfferEvidence> {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const result = await evaluateExplicitOfferSnapshot(client, organizationId, missionId);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function evaluateExplicitOfferSnapshot(
  db: PoolClient, organizationId: string, missionId: string,
): Promise<ExplicitOfferEvidence> {
  const { rows: offers } = await db.query<OfferRow>(
    `select o.id,o.contact_id,o.conversation_id,o.channel_session_id,
            o.description,o.amount_minor,o.currency,
            to_char(o.delivery_date,'YYYY-MM-DD') as delivery_date,
            o.offer_text,o.acceptance_text,o.issued_at,o.expires_at,
            o.superseded_at,o.direction_revision,
            m.direction_revision as mission_direction_revision,m.status as mission_status,
            l.contact_id as lead_contact_id
     from public.ai_mission_explicit_offers o
     join public.ai_missions m on m.organization_id=o.organization_id and m.id=o.mission_id
     join public.crm_leads l on l.organization_id=m.organization_id and l.id=m.lead_id
     where o.organization_id=$1 and o.mission_id=$2
     order by o.issued_at desc,o.id desc limit 1`,
    [organizationId, missionId],
  );
  const offer = offers[0];
  if (!offer) return response(null, "not_issued", "explicit_offer_missing");
  const code = /^确认报价交期 ([A-Za-z0-9_-]{22})$/.exec(offer.acceptance_text)?.[1];
  const terms = explicitOfferTermsSchema.safeParse({
    description: offer.description, amountMinor: Number(offer.amount_minor),
    currency: offer.currency, deliveryDate: offer.delivery_date,
  });
  if (!code || Buffer.from(code, "base64url").length !== 16 || !terms.success ||
      formatExplicitOffer(terms.data, code).offerText !== offer.offer_text)
    return response(offer, "conflict", "stored_offer_terms_invalid");
  if (offer.superseded_at || offer.direction_revision !== offer.mission_direction_revision ||
      offer.mission_status === "cancelled" || offer.lead_contact_id !== offer.contact_id)
    return response(offer, "superseded", "offer_or_customer_context_changed");

  const { rows: outbound } = await db.query<OutboundRow>(
    `select p.id as proposal_id,msg.id as message_id,msg.sent_at
     from public.ai_reply_drafts d
     join public.ai_workbench_runs r on r.organization_id=d.organization_id
       and r.id=d.workbench_run_id and r.mission_id=$2 and r.run_kind='root'
     join public.ai_agent_action_proposals p on p.organization_id=d.organization_id
       and p.id=d.workbench_proposal_id and p.run_id=r.id
       and p.tool_name='send_message' and p.status='executed'
     join public.messages msg on msg.organization_id=d.organization_id
       and msg.id=d.message_id
     where d.organization_id=$1 and d.contact_id=$3 and d.conversation_id=$4
       and d.channel_session_id=$5 and msg.channel_session_id=$5
       and d.approved_body=$6 and msg.body=$6
       and d.approved_at>= $7 and msg.sent_at>= $7 and msg.sent_at<=now()
     order by msg.sent_at,msg.id limit 2`,
    [organizationId, missionId, offer.contact_id, offer.conversation_id,
      offer.channel_session_id, offer.offer_text, offer.issued_at],
  );
  if (outbound.length > 1)
    return response(offer, "conflict", "offer_sent_multiple_times");
  const sent = outbound[0];
  if (!sent)
    return response(offer, Date.now() > offer.expires_at.getTime() ? "expired" : "not_sent",
      "exact_approved_offer_not_delivered");
  const [delivery] = await loadMissionDeliveryEvidence(db, organizationId, [sent.proposal_id]);
  const check = verifyCustomerDelivery(delivery, offer.contact_id);
  if (check.verdict !== "verified" || delivery?.messageId !== sent.message_id ||
      delivery?.conversationId !== offer.conversation_id)
    return response(offer, check.verdict === "conflict" ? "conflict" : "not_sent",
      check.reason, sent.message_id);
  if (sent.sent_at.getTime() > offer.expires_at.getTime())
    return response(offer, "expired", "offer_sent_after_expiry", sent.message_id);

  const { rows: inbound } = await db.query<InboundRow>(
    `select m.id,m.sent_at from public.messages m
     where m.organization_id=$1 and m.contact_id=$2 and m.conversation_id=$3
       and m.channel_session_id=$4 and m.direction='inbound' and m.type='text'
       and m.external_id is not null and m.body is not null
       and m.edited_at is null and m.revoked_at is null
       and btrim(m.body)=$5 and m.sent_at>$6 and m.sent_at<=$7
       and m.sent_at<=now()
       and exists (
         select 1 from public.webhook_events_log w
         where w.organization_id=m.organization_id
           and w.channel_session_id=m.channel_session_id
           and ${SIGNED_MESSAGE_RECEIPT_SQL}
           and w.crm_inbound_message_id=m.id
           and w.external_id=m.external_id
           and w.received_at>$6 and w.received_at<=$7
       )
     order by m.sent_at,m.id limit 1`,
    [organizationId, offer.contact_id, offer.conversation_id,
      offer.channel_session_id, offer.acceptance_text, sent.sent_at, offer.expires_at],
  );
  if (inbound[0])
    return response(offer, "verified", "exact_customer_channel_confirmation",
      sent.message_id, inbound[0].id);
  const { rows: unattributed } = await db.query<{ id: string }>(
    `select m.id from public.messages m
     where m.organization_id=$1 and m.contact_id=$2 and m.conversation_id=$3
       and m.channel_session_id=$4 and m.direction='inbound' and m.type='text'
       and m.external_id is not null and m.body is not null
       and m.edited_at is null and m.revoked_at is null
       and btrim(m.body)=$5 and m.sent_at>$6 and m.sent_at<=$7
       and m.sent_at<=now()
     order by m.sent_at,m.id limit 1`,
    [organizationId, offer.contact_id, offer.conversation_id,
      offer.channel_session_id, offer.acceptance_text, sent.sent_at, offer.expires_at],
  );
  if (unattributed[0])
    return response(offer, "unverified", "customer_reply_signature_unverified",
      sent.message_id, unattributed[0].id);
  return response(offer, Date.now() > offer.expires_at.getTime() ? "expired" : "awaiting_reply",
    "exact_customer_reply_missing", sent.message_id);
}
