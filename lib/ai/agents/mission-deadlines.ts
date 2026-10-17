import { setTimeout as sleep } from "node:timers/promises";
import type { Pool } from "pg";

/** Expired waits require human review; a deadline never silently proves success. */
export async function expireDueMissionWaits(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(
    `update public.ai_missions
     set status='needs_review',blocked_reason='mission_deadline_expired',
         wake_on_customer_reply=false
     where deadline_at is not null and deadline_at<=now()
       and status in ('waiting_customer','waiting_internal')`,
  );
  return rowCount ?? 0;
}

export async function runMissionDeadlineLoop(
  pool: Pool,
  log: { error(message: string, data?: Record<string, unknown>): void },
  signal: AbortSignal,
  intervalMs = 60_000,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await expireDueMissionWaits(pool);
    } catch (error) {
      log.error("mission deadline scan failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await sleep(intervalMs, undefined, { signal });
    } catch {
      if (signal.aborted) return;
      throw new Error("mission_deadline_timer_failed");
    }
  }
}
