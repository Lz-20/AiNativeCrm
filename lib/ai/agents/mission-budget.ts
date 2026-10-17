import type { Queryable } from "@/lib/agent-engine/queue/queue";

export interface MissionBudgetUsage {
  missionId: string;
  maxTotalTokens: number;
  maxTotalCostCents: number;
  usedTokens: number;
  usedCostCents: number;
  unknownCostCalls: number;
}

export class MissionBudgetExceededError extends Error {
  constructor(readonly reason: "tokens" | "cost" | "unknown_cost") {
    super(`mission_budget_${reason}`);
    this.name = "MissionBudgetExceededError";
  }
}

/** Includes root and specialist model calls; no provider messages are read. */
export async function loadMissionBudgetUsage(
  db: Queryable,
  organizationId: string,
  missionId: string,
): Promise<MissionBudgetUsage | null> {
  const { rows } = await db.query<{
    id: string;
    max_total_tokens: number;
    max_total_cost_cents: string;
    used_tokens: number;
    used_cost_cents: string;
    unknown_cost_calls: number;
  }>(
    `select m.id,m.max_total_tokens,m.max_total_cost_cents,
            coalesce(sum(c.input_tokens+c.output_tokens),0)::int as used_tokens,
            coalesce(sum(c.cost_cents),0)::text as used_cost_cents,
            count(*) filter (where c.status='ok' and c.cost_cents is null)::int as unknown_cost_calls
     from public.ai_missions m
     left join public.ai_workbench_runs r
       on r.organization_id=m.organization_id
      and (r.mission_id=m.id or r.parent_run_id in (
        select root.id from public.ai_workbench_runs root
        where root.organization_id=m.organization_id and root.mission_id=m.id
      ))
     left join public.llm_calls c
       on c.organization_id=m.organization_id and c.workbench_run_id=r.id
     where m.organization_id=$1 and m.id=$2
     group by m.id,m.max_total_tokens,m.max_total_cost_cents`,
    [organizationId, missionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    missionId: row.id,
    maxTotalTokens: row.max_total_tokens,
    maxTotalCostCents: Number(row.max_total_cost_cents),
    usedTokens: row.used_tokens,
    usedCostCents: Number(row.used_cost_cents),
    unknownCostCalls: row.unknown_cost_calls,
  };
}

export async function loadMissionBudgetForRun(
  db: Queryable,
  organizationId: string,
  runId: string,
): Promise<MissionBudgetUsage | null> {
  const { rows } = await db.query<{ mission_id: string }>(
    `select coalesce(r.mission_id,parent.mission_id) as mission_id
     from public.ai_workbench_runs r
     left join public.ai_workbench_runs parent
       on parent.organization_id=r.organization_id and parent.id=r.parent_run_id
     where r.organization_id=$1 and r.id=$2`,
    [organizationId, runId],
  );
  if (rows.length === 0) throw new Error("workbench_run_missing_for_mission_budget");
  const missionId = rows[0]?.mission_id;
  if (!missionId) return null;
  const usage = await loadMissionBudgetUsage(db, organizationId, missionId);
  if (!usage) throw new Error("mission_budget_missing_for_workbench_run");
  return usage;
}

export function missionBudgetBlockReason(usage: MissionBudgetUsage): MissionBudgetExceededError["reason"] | null {
  if (usage.unknownCostCalls > 0 || !Number.isFinite(usage.usedCostCents)) return "unknown_cost";
  if (usage.usedTokens >= usage.maxTotalTokens) return "tokens";
  if (usage.usedCostCents >= usage.maxTotalCostCents) return "cost";
  return null;
}
