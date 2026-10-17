import type { Pool } from "pg";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { MissionInternalResponseError } from "@/lib/ai/agents/mission-internal-response";
import { submitFeishuMissionText } from "@/lib/ai/internal-collaboration/feishu-mission";
import { decryptInboxText } from "@/lib/ai/internal-collaboration/inbox-crypto";

interface InboxRow {
  id: string;
  organization_id: string;
  mission_id: string;
  tenant_key: string;
  event_id: string;
  external_user_id: string;
  chat_id: string;
  root_message_id: string;
  message_id: string;
  content_ciphertext: Buffer | null;
  content_iv: Buffer | null;
  content_tag: Buffer | null;
  status: "pending" | "processed" | "needs_review" | "expired";
  expires_at: Date;
}

type InboxTerminal = "processed" | "needs_review" | "expired";
type InboxJobFence = { jobId: string; workerId: string; acquiredAt: string };

async function finishInbox(
  pool: Pool,
  row: Pick<InboxRow, "id" | "organization_id" | "mission_id">,
  status: InboxTerminal,
  fence: InboxJobFence,
  options: { runId?: string; reason?: string } = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: claims } = await client.query(
      `select 1 from public.job_queue j
       where j.organization_id=$1 and j.id=$2 and j.source_event_id=$3
         and j.kind='internal_im_event' and j.status='running'
         and j.locked_by=$4 and j.locked_at=$5::timestamptz
       for share of j`,
      [row.organization_id, fence.jobId, row.id, fence.workerId, fence.acquiredAt],
    );
    if (!claims[0]) throw new Error("internal_im_job_lease_lost");
    const { rows } = await client.query<{ id: string }>(
      `update public.ai_internal_event_inbox
       set status=$3,processed_run_id=$4,failure_code=$5,processed_at=now(),
           content_ciphertext=case when $3='needs_review' then content_ciphertext else null end,
           content_iv=case when $3='needs_review' then content_iv else null end,
           content_tag=case when $3='needs_review' then content_tag else null end
       where organization_id=$1 and id=$2 and status='pending'
       returning id`,
      [row.organization_id, row.id, status, options.runId ?? null, options.reason ?? null],
    );
    if (rows[0] && status !== "processed") {
      await client.query(
        `update public.ai_missions
         set status='needs_review',blocked_reason=$3
         where organization_id=$1 and id=$2 and status='waiting_internal'`,
        [row.organization_id, row.mission_id, options.reason ?? "internal_im_unavailable"],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Only the Worker decrypts and resumes; callback never waits for a model. */
export async function runFeishuInboxJob(job: JobRow, pool: Pool): Promise<void> {
  const claim = claimOfJob(job);
  if (!claim) throw new Error("internal_im_job_claim_missing");
  const fence: InboxJobFence = {
    jobId: job.id, workerId: claim.worker_id, acquiredAt: claim.acquired_at,
  };
  const inboxId = job.payload.inboxId;
  if (typeof inboxId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inboxId))
    throw new Error("internal_im_inbox_id_invalid");
  const { rows } = await pool.query<InboxRow>(
    `select id,organization_id,mission_id,tenant_key,event_id,external_user_id,
            chat_id,root_message_id,message_id,content_ciphertext,content_iv,
            content_tag,status,expires_at
     from public.ai_internal_event_inbox
     where organization_id=$1 and id=$2`,
    [job.organization_id, inboxId],
  );
  const row = rows[0];
  if (!row) throw new Error("internal_im_inbox_missing");
  if (row.status !== "pending") return;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await finishInbox(pool, row, "expired", fence, { reason: "internal_im_input_expired" });
    return;
  }
  if (!row.content_ciphertext || !row.content_iv || !row.content_tag)
    throw new Error("internal_im_inbox_ciphertext_missing");
  let content: string;
  try {
    content = decryptInboxText({
      ciphertext: row.content_ciphertext, iv: row.content_iv, tag: row.content_tag,
    }, {
      organizationId: row.organization_id, tenantKey: row.tenant_key,
      eventId: row.event_id,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "feishu_inbox_encryption_unavailable")
      throw error;
    await finishInbox(pool, row, "needs_review", fence, {
      reason: "internal_im_ciphertext_unreadable",
    });
    return;
  }
  try {
    const result = await submitFeishuMissionText(pool, {
      kind: "internal_text",
      tenantKey: row.tenant_key,
      eventId: row.event_id,
      openId: row.external_user_id,
      chatId: row.chat_id,
      rootMessageId: row.root_message_id,
      messageId: row.message_id,
      content,
    }, { inboxId: row.id, jobId: job.id,
      workerId: claim.worker_id, acquiredAt: claim.acquired_at });
    if (!result) {
      await finishInbox(pool, row, "needs_review", fence, {
        reason: "internal_im_mapping_revoked",
      });
      return;
    }
    await finishInbox(pool, row, "processed", fence, { runId: result.runId });
  } catch (error) {
    // Business preconditions changed while the event waited in the queue.
    // This is a review state, not a provider retry or a second authorization.
    if (error instanceof MissionInternalResponseError) {
      await finishInbox(pool, row, "needs_review", fence, {
        reason: `internal_im_${error.code}`,
      });
      return;
    }
    throw error;
  }
}

/** Bound PII retention. Leave IDs and digest for replay/security diagnosis. */
export async function expireFeishuInboxPayloads(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `with due as (
       select id,organization_id,mission_id,status
       from public.ai_internal_event_inbox
       where expires_at<=now() and content_ciphertext is not null
       for update skip locked
     ), expired as (
       update public.ai_internal_event_inbox i
       set content_ciphertext=null,content_iv=null,content_tag=null,
           status=case when d.status='pending' then 'expired' else i.status end,
           failure_code=case when d.status='pending' then 'internal_im_input_expired'
             else i.failure_code end,
           processed_at=coalesce(i.processed_at,now())
       from due d where i.id=d.id
       returning d.organization_id,d.mission_id,d.status as prior_status
     ), review as (
       update public.ai_missions m
       set status='needs_review',blocked_reason='internal_im_input_expired'
       where m.status='waiting_internal' and exists (
         select 1 from expired e where e.prior_status='pending'
           and e.organization_id=m.organization_id and e.mission_id=m.id
       )
       returning m.id
     )
     select count(*)::int as count from expired`,
  );
  return rows[0]?.count ?? 0;
}

/** Covers ordinary exhaustion and reaper-dead jobs after a process crash. */
export async function reconcileDeadFeishuInboxJobs(pool: Pool): Promise<number> {
  // A continuation may have committed before its inbox settlement failed.
  // The source ledger is durable proof of that Run; don't mislabel it as lost.
  const { rows: recovered } = await pool.query<{ count: number }>(
    `with settled as (
       update public.ai_internal_event_inbox i
       set status='processed',processed_run_id=source.run_id,
           failure_code=null,processed_at=now(),
           content_ciphertext=null,content_iv=null,content_tag=null
       from public.job_queue j, public.ai_mission_internal_inputs source
       where j.organization_id=i.organization_id and j.source_event_id=i.id
         and j.kind='internal_im_event' and j.status='dead' and i.status='pending'
         and source.organization_id=i.organization_id and source.mission_id=i.mission_id
         and source.source_provider=i.provider and source.source_tenant_key=i.tenant_key
         and source.source_event_id=i.event_id
       returning i.id
     ) select count(*)::int as count from settled`,
  );
  const { rows } = await pool.query<{ count: number }>(
    `with dead as (
       update public.ai_internal_event_inbox i
       set status='needs_review',failure_code='internal_im_queue_exhausted',
           processed_at=now()
       from public.job_queue j
       where j.organization_id=i.organization_id and j.source_event_id=i.id
         and j.kind='internal_im_event' and j.status='dead' and i.status='pending'
       returning i.organization_id,i.mission_id
     ), review as (
       update public.ai_missions m
       set status='needs_review',blocked_reason='internal_im_queue_exhausted'
       where m.status='waiting_internal' and exists (
         select 1 from dead d where d.organization_id=m.organization_id
           and d.mission_id=m.id
       )
       returning m.id
     )
     select count(*)::int as count from dead`,
  );
  return (recovered[0]?.count ?? 0) + (rows[0]?.count ?? 0);
}
