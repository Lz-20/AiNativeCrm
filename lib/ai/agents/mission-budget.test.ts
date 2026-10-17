import { expect, it, vi } from "vitest";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import {
  loadMissionBudgetForRun,
  loadMissionBudgetUsage,
  missionBudgetBlockReason,
} from "./mission-budget";

it("aggregates root and specialist usage through the same mission-scoped query", async () => {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("coalesce(r.mission_id,parent.mission_id)")) {
      return { rows: [{ mission_id: "mission-1" }] };
    }
    return { rows: [{
      id: "mission-1", max_total_tokens: 72000, max_total_cost_cents: "200.0000",
      used_tokens: 42000, used_cost_cents: "34.5000", unknown_cost_calls: 0,
    }] };
  });
  const usage = await loadMissionBudgetForRun({ query } as unknown as Queryable, "org-1", "child-run-1");
  expect(usage).toMatchObject({ usedTokens: 42000, usedCostCents: 34.5 });
  const aggregateSql = query.mock.calls[1]?.[0] ?? "";
  expect(aggregateSql).toContain("r.parent_run_id");
  expect(aggregateSql).toContain("c.workbench_run_id=r.id");
  expect(aggregateSql).toContain("m.organization_id=$1 and m.id=$2");
});

it("blocks exhausted or unknown cumulative budgets", () => {
  const base = {
    missionId: "mission-1", maxTotalTokens: 1000, maxTotalCostCents: 20,
    usedTokens: 900, usedCostCents: 10, unknownCostCalls: 0,
  };
  expect(missionBudgetBlockReason(base)).toBeNull();
  expect(missionBudgetBlockReason({ ...base, usedTokens: 1000 })).toBe("tokens");
  expect(missionBudgetBlockReason({ ...base, usedCostCents: 20 })).toBe("cost");
  expect(missionBudgetBlockReason({ ...base, unknownCostCalls: 1 })).toBe("unknown_cost");
});

it("returns null for a mission that does not belong to the requested organization", async () => {
  const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Queryable;
  expect(await loadMissionBudgetUsage(db, "org-a", "mission-b")).toBeNull();
});

it("fails closed if a workbench run disappears before the model call", async () => {
  const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Queryable;
  await expect(loadMissionBudgetForRun(db, "org-1", "missing-run"))
    .rejects.toThrow("workbench_run_missing_for_mission_budget");
});
