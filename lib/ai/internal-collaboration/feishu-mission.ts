import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";
import {
  MissionInternalResponseError,
  submitMissionInternalResponse,
  type FeishuInternalSource,
} from "@/lib/ai/agents/mission-internal-response";
import { encryptInboxText } from "@/lib/ai/internal-collaboration/inbox-crypto";
import {
  feishuEventRequestKey,
  type FeishuWebhookPayload,
} from "@/lib/ai/internal-collaboration/feishu-webhook";

type FeishuText = Extract<FeishuWebhookPayload, { kind: "internal_text" }>;

const RESOLVE_TARGET_SQL = `select t.organization_id,b.mission_id,u.user_id
  from public.ai_internal_platform_tenants t
  join public.ai_mission_internal_threads b
    on b.organization_id=t.organization_id and b.provider=t.provider
   and b.tenant_key=t.tenant_key
  join public.ai_internal_platform_users u
    on u.organization_id=t.organization_id and u.provider=t.provider
   and u.tenant_key=t.tenant_key
  join public.user_organizations member
    on member.organization_id=u.organization_id and member.user_id=u.user_id
  where t.provider='feishu' and t.tenant_key=$1 and t.active
    and b.chat_id=$2 and b.root_message_id=$3 and b.active
    and u.external_user_id=$4 and u.active
    and member.revoked_at is null and member.accepted_at is not null
    and member.role in ('agent','manager','admin')
  for share of t,b,u,member`;

interface FeishuTarget {
  organization_id: string;
  mission_id: string;
  user_id: string;
}

/** Commit the encrypted fact and a queue job together, then acknowledge Feishu. */
export async function persistFeishuMissionEvent(
  pool: Pool,
  event: FeishuText,
): Promise<{ inboxId: string; replayed: boolean } | null> {
  if (event.content.trim().length < 5 || event.content.length > 2_000 ||
      [event.tenantKey, event.eventId, event.openId, event.chatId,
        event.rootMessageId, event.messageId].some((value) => !value || value.length > 256))
    throw new MissionInternalResponseError("input_invalid");
  const digest = createHash("sha256").update(JSON.stringify([
    event.tenantKey, event.eventId, event.openId, event.chatId,
    event.rootMessageId, event.messageId, event.content,
  ])).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<FeishuTarget>(RESOLVE_TARGET_SQL, [
      event.tenantKey, event.chatId, event.rootMessageId, event.openId,
    ]);
    const target = rows[0];
    if (!target) {
      await client.query("commit");
      return null;
    }
    const encrypted = encryptInboxText(event.content, {
      organizationId: target.organization_id,
      tenantKey: event.tenantKey,
      eventId: event.eventId,
    });
    const { rows: inserted } = await client.query<{ id: string }>(
      `insert into public.ai_internal_event_inbox
       (organization_id,mission_id,provider,tenant_key,event_id,event_digest,
        external_user_id,chat_id,root_message_id,message_id,
        content_ciphertext,content_iv,content_tag)
       values ($1,$2,'feishu',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning id`,
      [target.organization_id, target.mission_id, event.tenantKey,
        event.eventId, digest, event.openId, event.chatId, event.rootMessageId,
        event.messageId, encrypted.ciphertext, encrypted.iv, encrypted.tag],
    );
    const inboxId = inserted[0]!.id;
    await enqueueJob(client, target.organization_id, {
      kind: "internal_im_event",
      sourceEventId: inboxId,
      payload: { inboxId },
      maxAttempts: 5,
    });
    await client.query("commit");
    return { inboxId, replayed: false };
  } catch (error) {
    await client.query("rollback");
    if ((error as { code?: string })?.code === "23505") {
      const { rows } = await client.query<{ id: string; event_digest: string }>(
        `select id,event_digest from public.ai_internal_event_inbox
         where provider='feishu' and tenant_key=$1 and event_id=$2`,
        [event.tenantKey, event.eventId],
      );
      if (rows[0]) {
        if (rows[0].event_digest !== digest)
          throw new MissionInternalResponseError("source_conflict");
        return { inboxId: rows[0].id, replayed: true };
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Mapping is operator-provisioned, not inferred from a chat name or message
 * text. submitMissionInternalResponse revalidates every link under the Mission
 * lock, so a revoked mapping cannot race an already-resolved callback.
 */
export async function submitFeishuMissionText(
  pool: Pool,
  event: FeishuText,
  inboxJobClaim?: FeishuInternalSource["inboxJobClaim"],
): Promise<{ runId: string; replayed: boolean } | null> {
  const { rows } = await pool.query<FeishuTarget>(RESOLVE_TARGET_SQL, [
    event.tenantKey, event.chatId, event.rootMessageId, event.openId,
  ]);
  const target = rows[0];
  if (!target) return null;
  const source: FeishuInternalSource = {
    provider: "feishu",
    tenantKey: event.tenantKey,
    eventId: event.eventId,
    openId: event.openId,
    chatId: event.chatId,
    rootMessageId: event.rootMessageId,
    inboxJobClaim,
  };
  const result = await submitMissionInternalResponse(pool, {
    organizationId: target.organization_id,
    missionId: target.mission_id,
    actorUserId: target.user_id,
    requestKey: feishuEventRequestKey(event.tenantKey, event.eventId),
    content: event.content,
    source,
  });
  return { runId: result.runId, replayed: result.replayed };
}
