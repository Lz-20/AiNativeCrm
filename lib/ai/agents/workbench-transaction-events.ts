import type { PoolClient } from "pg";
import {
  type CrmAgentEventType, redactEventPayload,
} from "@/lib/ai/agents/workbench-events";

/** Append a product event inside the transaction that owns its state change. */
export async function appendWorkbenchEventTx(
  client: PoolClient, organizationId: string, runId: string,
  type: CrmAgentEventType, payload: Record<string, unknown>,
): Promise<void> {
  const safePayload = redactEventPayload(type, payload);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { rows } = await client.query(
      `insert into public.ai_agent_run_events
       (organization_id,run_id,sequence,event_type,payload)
       select $1,$2,coalesce(max(sequence),0)+1,$3,$4::jsonb
       from public.ai_agent_run_events
       where organization_id=$1 and run_id=$2
       on conflict (run_id,sequence) do nothing returning sequence`,
      [organizationId, runId, type, JSON.stringify(safePayload)],
    );
    if (rows.length === 1) return;
  }
  throw new Error("workbench_event_sequence_race");
}
