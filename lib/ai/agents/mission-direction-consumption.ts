import type { Pool, PoolClient } from "pg";
import type { AgentRuntimeEvent, RuntimeContent, RuntimeMessage } from "@/lib/agent-runtime";
import { MissionDirectionFenceError } from "@/lib/ai/agents/mission-direction-fence";
import { parseRuntimeMessages } from "@/lib/ai/agents/workbench-state";

function directionProbeId(missionId: string, revision: number): string {
  return `manager-direction:${missionId}:${revision}`;
}

/** Load a scoped, in-memory probe immediately before the root model call. */
export async function loadMissionDirectionContextProbe(
  pool: Pool,
  input: { organizationId: string; missionId: string; runId: string; expectedRevision: unknown },
): Promise<{ id: string; userText: string } | undefined> {
  if (typeof input.expectedRevision !== "number" ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    throw new MissionDirectionFenceError("revision_missing");
  const { rows } = await pool.query<{
    current_direction: string | null; direction_revision: string; run_revision: string | null;
    run_status: string;
  }>(
    `select m.current_direction,m.direction_revision::text as direction_revision,
            r.runtime_state->>'directionRevision' as run_revision,r.status as run_status
     from public.ai_workbench_runs r
     join public.ai_missions m on m.organization_id=r.organization_id and m.id=r.mission_id
     where r.organization_id=$1 and r.id=$2 and r.mission_id=$3 and r.run_kind='root'`,
    [input.organizationId, input.runId, input.missionId],
  );
  const row = rows[0];
  if (!row || row.run_status !== "running")
    throw new MissionDirectionFenceError("run_inactive");
  if (row.direction_revision !== String(input.expectedRevision) ||
      row.run_revision !== String(input.expectedRevision))
    throw new MissionDirectionFenceError("revision_changed");
  if (!row.current_direction) return undefined;
  return {
    id: directionProbeId(input.missionId, input.expectedRevision),
    userText: JSON.stringify(row.current_direction),
  };
}

function textOf(content: string | RuntimeContent[]): string {
  return typeof content === "string" ? content
    : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

/** A queued instruction is not proof. Require a successful model turn and its saved prompt. */
export function directionReachedModel(
  messages: RuntimeMessage[],
  events: AgentRuntimeEvent[],
  direction: string,
  probeId: string,
): boolean {
  return messages.some((message) => message.role === "user" &&
    textOf(message.content).includes(JSON.stringify(direction))) &&
    events.some((event) => event.type === "model_context_consumed" &&
      event.data.probeId === probeId);
}

async function appendConsumedEvent(
  client: PoolClient,
  organizationId: string,
  runId: string,
  directionRevision: number,
  directionId: string | null,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { rows } = await client.query<{ sequence: number }>(
      `insert into public.ai_agent_run_events
       (organization_id,run_id,sequence,event_type,payload)
       select $1,$2,coalesce(max(sequence),0)+1,'manager_direction_consumed',
              jsonb_build_object('directionRevision',$3::bigint,'directionId',$4::uuid)
       from public.ai_agent_run_events
       where organization_id=$1 and run_id=$2
       on conflict (run_id,sequence) do nothing
       returning sequence`,
      [organizationId, runId, directionRevision, directionId],
    );
    if (rows.length === 1) return;
  }
  throw new Error("mission_direction_event_sequence_race");
}

/**
 * Commit private Pi state and the public, redacted consumption acknowledgement
 * together. The Mission row is locked before the Run, matching manager-command
 * lock order; a replacement can neither race this acknowledgement nor inherit it.
 */
export async function persistMissionRunMessagesAndDirectionAck(
  pool: Pool,
  input: {
    organizationId: string;
    missionId: string;
    runId: string;
    expectedRevision: unknown;
    messages: RuntimeMessage[];
    events: AgentRuntimeEvent[];
  },
): Promise<{ acknowledged: boolean }> {
  if (!parseRuntimeMessages(input.messages)) throw new Error("workbench_runtime_state_invalid");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: missions } = await client.query<{
      current_direction: string | null;
      direction_revision: string;
      direction_consumed_revision: string;
    }>(
      `select current_direction,direction_revision::text,direction_consumed_revision::text
       from public.ai_missions where organization_id=$1 and id=$2 for update`,
      [input.organizationId, input.missionId],
    );
    const mission = missions[0];
    if (!mission) throw new MissionDirectionFenceError("run_inactive");
    const { rows: runs } = await client.query<{
      status: string;
      run_revision: string | null;
    }>(
      `select status,runtime_state->>'directionRevision' as run_revision
       from public.ai_workbench_runs
       where organization_id=$1 and id=$2 and mission_id=$3 and run_kind='root'
       for update`,
      [input.organizationId, input.runId, input.missionId],
    );
    const run = runs[0];
    if (!run || run.status !== "running")
      throw new MissionDirectionFenceError("run_inactive");
    const revision = Number(mission.direction_revision);
    const consumedRevision = Number(mission.direction_consumed_revision);
    if (!Number.isSafeInteger(revision) || revision < 0 ||
        !Number.isSafeInteger(consumedRevision) || consumedRevision < 0 ||
        consumedRevision > revision)
      throw new MissionDirectionFenceError("revision_missing");
    if (mission.current_direction && (
      typeof input.expectedRevision !== "number" ||
      !Number.isSafeInteger(input.expectedRevision) ||
      String(input.expectedRevision) !== mission.direction_revision ||
      run.run_revision !== mission.direction_revision
    )) throw new MissionDirectionFenceError("revision_changed");
    if (mission.current_direction && !directionReachedModel(
      input.messages, input.events, mission.current_direction,
      directionProbeId(input.missionId, revision),
    )) throw new MissionDirectionFenceError("context_missing");

    await client.query(
      `insert into public.ai_agent_run_states(organization_id,run_id,messages)
       values ($1,$2,$3::jsonb)
       on conflict (run_id) do update set messages=excluded.messages,updated_at=now()`,
      [input.organizationId, input.runId, JSON.stringify(input.messages)],
    );
    let acknowledged = false;
    if (mission.current_direction && consumedRevision < revision) {
      const { rows: markers } = await client.query<{ id: string }>(
        `select id from public.ai_mission_internal_inputs
         where organization_id=$1 and mission_id=$2 and kind='manager_direction'
           and direction_revision=$3
         for update`,
        [input.organizationId, input.missionId, revision],
      );
      await client.query(
        `update public.ai_missions set direction_consumed_revision=$3
         where organization_id=$1 and id=$2 and direction_revision=$3`,
        [input.organizationId, input.missionId, revision],
      );
      if (markers[0]) await client.query(
        `update public.ai_mission_internal_inputs
         set consumed_at=coalesce(consumed_at,now())
         where organization_id=$1 and id=$2`,
        [input.organizationId, markers[0].id],
      );
      await appendConsumedEvent(client, input.organizationId, input.runId,
        revision, markers[0]?.id ?? null);
      acknowledged = true;
    }
    await client.query("commit");
    return { acknowledged };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
