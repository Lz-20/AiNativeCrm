import type { Pool } from "pg";
import {
  explicitOfferTermsSchema, formatExplicitOffer, newOfferConfirmationCode,
  type ExplicitOfferTerms,
} from "@/lib/ai/evals/mission-explicit-offer";

export class ExplicitOfferError extends Error {
  constructor(readonly code: "not_found" | "forbidden" | "state_conflict" |
    "conversation_invalid" | "request_conflict") {
    super(code);
    this.name = "ExplicitOfferError";
  }
}

export interface IssuedExplicitOffer {
  id: string;
  missionId: string;
  conversationId: string;
  offerText: string;
  acceptanceText: string;
  expiresAt: string;
  superseded: boolean;
  replayed: boolean;
}

interface OfferRow {
  id: string;
  mission_id: string;
  conversation_id: string;
  description: string;
  amount_minor: string;
  currency: string;
  delivery_date: string;
  offer_text: string;
  acceptance_text: string;
  direction_revision: string;
  expires_at: Date | string;
  superseded_at: Date | string | null;
}

function receipt(row: OfferRow, replayed: boolean): IssuedExplicitOffer {
  return {
    id: row.id, missionId: row.mission_id, conversationId: row.conversation_id,
    offerText: row.offer_text, acceptanceText: row.acceptance_text,
    expiresAt: new Date(row.expires_at).toISOString(),
    superseded: row.superseded_at !== null, replayed,
  };
}

/** Fixes the terms before the Agent proposes a send; it never sends or approves a message. */
export async function issueMissionExplicitOffer(pool: Pool, input: {
  organizationId: string;
  missionId: string;
  actorUserId: string;
  conversationId: string;
  requestKey: string;
  terms: ExplicitOfferTerms;
}): Promise<IssuedExplicitOffer> {
  const terms = explicitOfferTermsSchema.parse(input.terms);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '5s'");
    const { rows: missions } = await client.query<{
      lead_id: string; status: string; deadline_at: Date | null;
      direction_revision: string; customer_send_paused: boolean;
    }>(
      `select lead_id,status,deadline_at,direction_revision,customer_send_paused
       from public.ai_missions where organization_id=$1 and id=$2 for update`,
      [input.organizationId, input.missionId],
    );
    const mission = missions[0];
    if (!mission) throw new ExplicitOfferError("not_found");
    const { rows: members } = await client.query<{ role: string }>(
      `select role from public.user_organizations
       where organization_id=$1 and user_id=$2 and accepted_at is not null
         and revoked_at is null for share`,
      [input.organizationId, input.actorUserId],
    );
    if (!members[0] || !["manager", "admin"].includes(members[0].role))
      throw new ExplicitOfferError("forbidden");
    if (["completed", "cancelled"].includes(mission.status) ||
        mission.customer_send_paused ||
        (mission.deadline_at && mission.deadline_at.getTime() <= Date.now()))
      throw new ExplicitOfferError("state_conflict");

    const { rows: conversations } = await client.query<{
      contact_id: string; channel_session_id: string;
    }>(
      `select c.contact_id,c.channel_session_id
       from public.conversations c
       join public.crm_leads l on l.organization_id=c.organization_id
         and l.contact_id=c.contact_id and l.id=$3
       where c.organization_id=$1 and c.id=$2 and c.channel='whatsapp'
         and c.is_group=false
       for share of c,l`,
      [input.organizationId, input.conversationId, mission.lead_id],
    );
    const conversation = conversations[0];
    if (!conversation) throw new ExplicitOfferError("conversation_invalid");

    const { rows: existing } = await client.query<OfferRow>(
      `select id,mission_id,conversation_id,description,amount_minor,currency,
              to_char(delivery_date,'YYYY-MM-DD') as delivery_date,
              offer_text,acceptance_text,direction_revision,expires_at,superseded_at
       from public.ai_mission_explicit_offers
       where organization_id=$1 and mission_id=$2 and request_key=$3 for update`,
      [input.organizationId, input.missionId, input.requestKey],
    );
    if (existing[0]) {
      const prior = existing[0];
      if (prior.conversation_id !== input.conversationId ||
          prior.description !== terms.description ||
          prior.amount_minor !== String(terms.amountMinor) ||
          prior.currency !== terms.currency ||
          prior.delivery_date !== terms.deliveryDate)
        throw new ExplicitOfferError("request_conflict");
      if (prior.superseded_at || prior.direction_revision !== mission.direction_revision ||
          new Date(prior.expires_at).getTime() <= Date.now())
        throw new ExplicitOfferError("state_conflict");
      await client.query("commit");
      return receipt(prior, true);
    }

    const { offerText, acceptanceText } = formatExplicitOffer(
      terms, newOfferConfirmationCode());
    await client.query(
      `update public.ai_mission_explicit_offers set superseded_at=now()
       where organization_id=$1 and mission_id=$2 and superseded_at is null`,
      [input.organizationId, input.missionId],
    );
    const { rows } = await client.query<OfferRow>(
      `insert into public.ai_mission_explicit_offers
       (organization_id,mission_id,contact_id,conversation_id,channel_session_id,
        created_by,request_key,direction_revision,description,amount_minor,currency,
        delivery_date,offer_text,acceptance_text,expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
         least(now()+interval '7 days',coalesce($15::timestamptz,now()+interval '7 days')))
       returning id,mission_id,conversation_id,description,amount_minor,currency,
         to_char(delivery_date,'YYYY-MM-DD') as delivery_date,
         offer_text,acceptance_text,direction_revision,expires_at,superseded_at`,
      [input.organizationId, input.missionId, conversation.contact_id,
        input.conversationId, conversation.channel_session_id, input.actorUserId,
        input.requestKey, mission.direction_revision, terms.description,
        terms.amountMinor, terms.currency, terms.deliveryDate,
        offerText, acceptanceText, mission.deadline_at],
    );
    await client.query("commit");
    return receipt(rows[0]!, false);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
