import type { Pool } from "pg";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { decryptQuestionText } from "@/lib/ai/internal-collaboration/inbox-crypto";
import {
  FeishuSendError, sendFeishuDirectMessage, type FeishuSendReceipt,
} from "@/lib/ai/internal-collaboration/feishu-send";

interface QuestionRow {
  id: string;
  organization_id: string;
  mission_id: string;
  recipient_user_id: string;
  tenant_key: string;
  recipient_open_id: string;
  question_ciphertext: Buffer | null;
  question_iv: Buffer | null;
  question_tag: Buffer | null;
  status: "pending" | "sent" | "needs_review" | "expired";
  send_deadline_at: Date;
}

interface QuestionClaim {
  jobId: string;
  workerId: string;
  acquiredAt: string;
}

async function currentClaim(pool: Pool, row: QuestionRow, claim: QuestionClaim): Promise<void> {
  const { rows } = await pool.query(
    `select 1 from public.job_queue
     where organization_id=$1 and id=$2 and source_event_id=$3
       and kind='internal_im_question' and status='running'
       and locked_by=$4 and locked_at=$5::timestamptz`,
    [row.organization_id, claim.jobId, row.id, claim.workerId, claim.acquiredAt],
  );
  if (!rows[0]) throw new Error("internal_question_job_lease_lost");
}

async function finishQuestion(
  pool: Pool,
  row: QuestionRow,
  claim: QuestionClaim,
  outcome: { status: "sent"; receipt: FeishuSendReceipt } |
    { status: "needs_review" | "expired"; reason: string },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: missions } = await client.query<{ status: string }>(
      `select status from public.ai_missions
       where organization_id=$1 and id=$2 for update`,
      [row.organization_id, row.mission_id],
    );
    if (!missions[0]) throw new Error("internal_question_mission_missing");
    const { rows: jobs } = await client.query(
      `select 1 from public.job_queue
       where organization_id=$1 and id=$2 and source_event_id=$3
         and kind='internal_im_question' and status='running'
         and locked_by=$4 and locked_at=$5::timestamptz
       for share`,
      [row.organization_id, claim.jobId, row.id, claim.workerId, claim.acquiredAt],
    );
    if (!jobs[0]) throw new Error("internal_question_job_lease_lost");
    const { rows: settled } = await client.query<{ id: string }>(
      `update public.ai_internal_question_outbox
       set status=$3,message_id=$4,chat_id=$5,failure_code=$6,
           sent_at=case when $3='sent' then now() else sent_at end,
           question_ciphertext=case when $3='sent' then null else question_ciphertext end,
           question_iv=case when $3='sent' then null else question_iv end,
           question_tag=case when $3='sent' then null else question_tag end
       where organization_id=$1 and id=$2 and status='pending'
       returning id`,
      [row.organization_id, row.id, outcome.status,
        outcome.status === "sent" ? outcome.receipt.messageId : null,
        outcome.status === "sent" ? outcome.receipt.chatId : null,
        outcome.status === "sent" ? null : outcome.reason],
    );
    if (settled[0] && outcome.status === "sent") {
      await client.query(
        `insert into public.ai_mission_internal_threads
         (organization_id,mission_id,provider,tenant_key,chat_id,root_message_id,active)
         values ($1,$2,'feishu',$3,$4,$5,$6)`,
        [row.organization_id, row.mission_id, row.tenant_key,
          outcome.receipt.chatId, outcome.receipt.messageId,
          missions[0].status === "waiting_internal"],
      );
    }
    if (settled[0] && outcome.status !== "sent") {
      await client.query(
        `update public.ai_missions
         set status='needs_review',blocked_reason=$3
         where organization_id=$1 and id=$2 and status='waiting_internal'`,
        [row.organization_id, row.mission_id, outcome.reason],
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

/** The send UUID is the outbox ID. Never retry after its provider dedup window. */
export async function runFeishuQuestionJob(
  job: JobRow,
  pool: Pool,
  send: typeof sendFeishuDirectMessage = sendFeishuDirectMessage,
): Promise<void> {
  const jobClaim = claimOfJob(job);
  if (!jobClaim) throw new Error("internal_question_job_claim_missing");
  const questionId = job.payload.questionId;
  if (typeof questionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(questionId))
    throw new Error("internal_question_id_invalid");
  const claim = { jobId: job.id, workerId: jobClaim.worker_id,
    acquiredAt: jobClaim.acquired_at };
  const { rows } = await pool.query<QuestionRow>(
    `select id,organization_id,mission_id,recipient_user_id,tenant_key,
            recipient_open_id,question_ciphertext,question_iv,question_tag,
            status,send_deadline_at
     from public.ai_internal_question_outbox
     where organization_id=$1 and id=$2`,
    [job.organization_id, questionId],
  );
  const row = rows[0];
  if (!row) throw new Error("internal_question_missing");
  if (row.status !== "pending") return;
  await currentClaim(pool, row, claim);
  if (new Date(row.send_deadline_at).getTime() <= Date.now()) {
    await finishQuestion(pool, row, claim, { status: "expired",
      reason: "internal_question_send_deadline_expired" });
    return;
  }
  const tenantKey = process.env.FEISHU_TENANT_KEY ?? "";
  if (!tenantKey || tenantKey !== row.tenant_key ||
      !process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET)
    throw new FeishuSendError("config_missing");
  if (!row.question_ciphertext || !row.question_iv || !row.question_tag)
    throw new Error("internal_question_ciphertext_missing");
  let text: string;
  try {
    text = decryptQuestionText({
      ciphertext: row.question_ciphertext, iv: row.question_iv, tag: row.question_tag,
    }, { organizationId: row.organization_id, tenantKey: row.tenant_key,
      eventId: row.id });
  } catch (error) {
    if (error instanceof Error && error.message === "feishu_inbox_encryption_unavailable")
      throw error;
    await finishQuestion(pool, row, claim, { status: "needs_review",
      reason: "internal_question_ciphertext_unreadable" });
    return;
  }
  let receipt: FeishuSendReceipt | null = null;
  let authorized = false;
  let deliveryUnconfirmed = false;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: allowed } = await client.query(
      `select 1 from public.ai_missions m
       join public.ai_internal_platform_tenants t
         on t.organization_id=m.organization_id and t.provider='feishu' and t.tenant_key=$3
       join public.ai_internal_platform_users u
         on u.organization_id=t.organization_id and u.provider=t.provider
        and u.tenant_key=t.tenant_key and u.user_id=$4 and u.external_user_id=$5
       join public.user_organizations member
         on member.organization_id=u.organization_id and member.user_id=u.user_id
       where m.organization_id=$1 and m.id=$2 and m.status='waiting_internal'
         and (m.deadline_at is null or m.deadline_at>now())
         and t.active and u.active and member.revoked_at is null
         and member.accepted_at is not null and member.role in ('agent','manager','admin')
       for share of m,t,u,member`,
      [row.organization_id, row.mission_id, row.tenant_key,
        row.recipient_user_id, row.recipient_open_id],
    );
    authorized = Boolean(allowed[0]);
    if (authorized) {
      // Serialize cancellation/revocation with the actual channel call. If
      // cancellation commits first, no send occurs; if this lock wins, the
      // send is already in flight before cancellation may commit.
      receipt = await send({
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
      }, { openId: row.recipient_open_id, text, uuid: row.id });
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    if (error instanceof FeishuSendError && error.code === "delivery_unconfirmed") {
      deliveryUnconfirmed = true;
    } else {
      throw error;
    }
  } finally {
    client.release();
  }
  if (deliveryUnconfirmed) {
    await finishQuestion(pool, row, claim, { status: "needs_review",
      reason: "internal_question_delivery_uncertain" });
    return;
  }
  if (!authorized || !receipt) {
    await finishQuestion(pool, row, claim, { status: "needs_review",
      reason: "internal_question_authorization_changed" });
    return;
  }
  await finishQuestion(pool, row, claim, { status: "sent", receipt });
}

/** Queue exhaustion and retention are visible Mission failures, never success. */
export async function reconcileDeadFeishuQuestionJobs(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `with dead as (
       update public.ai_internal_question_outbox q
       set status='needs_review',failure_code='internal_question_queue_exhausted'
       from public.job_queue j
       where j.organization_id=q.organization_id and j.source_event_id=q.id
         and j.kind='internal_im_question' and j.status='dead' and q.status='pending'
       returning q.organization_id,q.mission_id
     ), review as (
       update public.ai_missions m
       set status='needs_review',blocked_reason='internal_question_queue_exhausted'
       where m.status='waiting_internal' and exists (
         select 1 from dead d where d.organization_id=m.organization_id
           and d.mission_id=m.id
       ) returning m.id
     ) select count(*)::int as count from dead`,
  );
  return rows[0]?.count ?? 0;
}

export async function expireFeishuQuestionPayloads(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `with due as (
       select id,organization_id,mission_id,status
       from public.ai_internal_question_outbox
       where payload_expires_at<=now() and question_ciphertext is not null
       for update skip locked
     ), expired as (
       update public.ai_internal_question_outbox q
       set question_ciphertext=null,question_iv=null,question_tag=null,
           status=case when d.status='pending' then 'expired' else q.status end,
           failure_code=case when d.status='pending' then 'internal_question_expired'
             else q.failure_code end
       from due d where q.id=d.id
       returning d.organization_id,d.mission_id,d.status as prior_status
     ), review as (
       update public.ai_missions m
       set status='needs_review',blocked_reason='internal_question_expired'
       where m.status='waiting_internal' and exists (
         select 1 from expired e where e.prior_status='pending'
           and e.organization_id=m.organization_id and e.mission_id=m.id
       ) returning m.id
     ) select count(*)::int as count from expired`,
  );
  return rows[0]?.count ?? 0;
}
