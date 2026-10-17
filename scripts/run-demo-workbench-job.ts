/** Opt-in real-model verification: one explicitly selected, read-only demo job.
 * pnpm exec tsx --env-file=.env.e2e scripts/run-demo-workbench-job.ts <run-uuid>
 * Credentials remain in the encrypted provider store; this script never prints them.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { runWorkbenchStartJob } from "@/lib/ai/agents/workbench-start-job";
import { completeJob, failJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

async function main() {
  const runId = z.string().uuid().parse(process.argv[2]);
  const url = new URL(process.env.SUPABASE_DB_URL ?? "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("demo_requires_loopback_db");
  const workerId = `demo-verification-${randomUUID()}`;
  const pool = new pg.Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 5000 });
  let job: JobRow | undefined;
  try {
    const claimed = await pool.query<JobRow>(`update job_queue j
      set status='running', locked_by=$1, locked_at=now(), attempts=attempts+1
      from ai_workbench_runs r join organizations o on o.id=r.organization_id
      where j.organization_id=r.organization_id and j.payload->>'runId'=r.id::text
        and r.id=$2 and o.slug='pi-native-demo' and r.mode='inspect'
        and r.task like '[2026-10-03 memory regression]%' and r.status='queued'
        and j.status='pending' and j.kind='workbench_start' and j.run_after<=now()
      returning j.*,j.locked_at::text as claim_acquired_at`, [workerId, runId]);
    if (claimed.rows.length !== 1) throw new Error("one_pending_demo_job_required");
    job = claimed.rows[0];
    await runWorkbenchStartJob(job, pool, workerId);
    await completeJob(pool, job.id, workerId, undefined, job.claim_acquired_at);
    console.info(JSON.stringify({ runId, queueStatus: "done", realModel: true }));
  } catch {
    if (job) await failJob(pool, job.id, workerId, new Error("demo_verification_failed"), job.claim_acquired_at);
    // Provider exception strings may contain sensitive request material.
    console.error("Demo verification failed; inspect the scoped CRM run and server logs.");
    process.exitCode = 1;
    if (!job) throw new Error("demo_job_not_claimed");
  } finally {
    await pool.end();
    await getRequestPool().end();
  }
}
void main().catch(() => { process.exitCode = 1; });
