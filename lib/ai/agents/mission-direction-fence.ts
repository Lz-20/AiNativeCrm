import type { Pool } from "pg";

/** Shared by manager direction acceptance and CRM's automatic write executor. */
export function missionDirectionLockKey(organizationId: string, missionId: string): string {
  return `crm_mission_direction:${organizationId}:${missionId}`;
}

export class MissionDirectionFenceError extends Error {
  constructor(readonly code: "revision_missing" | "revision_changed" | "run_inactive" | "context_missing") {
    super(`mission_direction_${code}`);
    this.name = "MissionDirectionFenceError";
  }
}

/**
 * Serialize one reversible CRM write against a manager direction command.
 * The actual business mutation still goes through the CRM tool; this PG
 * transaction only holds the scoped lock and checks the Run's revision.
 */
export async function withMissionDirectionWriteFence<T>(
  pool: Pool,
  input: {
    organizationId: string;
    missionId: string | null;
    runId: string;
    expectedRevision: unknown;
  },
  action: () => Promise<T>,
): Promise<T> {
  if (!input.missionId) return action();
  if (typeof input.expectedRevision !== "number" ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    throw new MissionDirectionFenceError("revision_missing");

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '5s'");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1,0))",
      [missionDirectionLockKey(input.organizationId, input.missionId)],
    );
    const { rows } = await client.query<{
      direction_revision: string;
      run_status: string;
      mission_status: string;
      run_revision: string | null;
    }>(
      `select m.direction_revision::text as direction_revision,
              m.status as mission_status,r.status as run_status,
              r.runtime_state->>'directionRevision' as run_revision
       from public.ai_workbench_runs r
       join public.ai_missions m
         on m.organization_id=r.organization_id and m.id=r.mission_id
       where r.organization_id=$1 and r.id=$2 and r.mission_id=$3
       for share of m`,
      [input.organizationId, input.runId, input.missionId],
    );
    const current = rows[0];
    if (!current || current.run_status !== "running" ||
        ["cancelled", "completed"].includes(current.mission_status))
      throw new MissionDirectionFenceError("run_inactive");
    if (current.direction_revision !== String(input.expectedRevision) ||
        current.run_revision !== String(input.expectedRevision))
      throw new MissionDirectionFenceError("revision_changed");

    const result = await action();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** A stale direction is a terminal safety stop, not a retryable model failure. */
export async function stopMissionRunAfterDirectionFence(
  pool: Pool,
  input: { organizationId: string; missionId: string; runId: string },
  error: MissionDirectionFenceError,
): Promise<boolean> {
  const reason = error.message;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '5s'");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1,0))",
      [missionDirectionLockKey(input.organizationId, input.missionId)],
    );
    const { rows: stopped } = await client.query<{ id: string }>(
      `update public.ai_workbench_runs r
       set status='partial',error_code=$4,completed_at=now()
       where r.organization_id=$1 and r.id=$2 and r.mission_id=$3
         and r.status in ('queued','running')
         and exists (
           select 1 from public.ai_missions m
           where m.organization_id=$1 and m.id=$3
             and m.status <> 'cancelled'
         )
       returning r.id`,
      [input.organizationId, input.runId, input.missionId, reason],
    );
    if (stopped.length === 0) {
      await client.query("commit");
      return false;
    }

    await client.query(
      `update public.ai_reply_drafts
       set status='stale',error_code=$3,updated_at=now()
       where organization_id=$1 and workbench_run_id=$2 and status='pending'`,
      [input.organizationId, input.runId, reason],
    );
    await client.query(
      `update public.ai_agent_action_proposals
       set status='cancelled',decision_reason=$3,updated_at=now(),
           result_summary=jsonb_build_object('outcome','blocked_by_direction','code',$3::text)
       where organization_id=$1 and run_id=$2 and status='pending'`,
      [input.organizationId, input.runId, reason],
    );

    let recorded = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { rows } = await client.query<{ sequence: number }>(
        `insert into public.ai_agent_run_events
           (organization_id,run_id,sequence,event_type,payload)
         select $1,$2,coalesce(max(sequence),0)+1,'run_partial',
                jsonb_build_object('status','partial','reason',$3::text)
         from public.ai_agent_run_events
         where organization_id=$1 and run_id=$2
         on conflict (run_id,sequence) do nothing
         returning sequence`,
        [input.organizationId, input.runId, reason],
      );
      if (rows.length > 0) {
        recorded = true;
        break;
      }
    }
    if (!recorded) throw new Error("mission_direction_event_sequence_race");
    await client.query("commit");
    return true;
  } catch (cause) {
    await client.query("rollback");
    throw cause;
  } finally {
    client.release();
  }
}
