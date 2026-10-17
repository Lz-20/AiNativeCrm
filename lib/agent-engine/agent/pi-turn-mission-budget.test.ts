import { beforeEach, expect, it, vi } from "vitest";
import type pg from "pg";
import { MissionBudgetExceededError } from "@/lib/ai/agents/mission-budget";

const runModelCall = vi.hoisted(() => vi.fn());
vi.mock("../edge/llm/run-model-call", () => ({ runModelCall }));

import { executePiTurnModelCall } from "./pi-turn-execution";

function pool(usedTokens: number, usedCostCents: number) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("coalesce(r.mission_id,parent.mission_id)"))
      return { rows: [{ mission_id: "mission-1" }] };
    return { rows: [{
      id: "mission-1", max_total_tokens: 72000, max_total_cost_cents: "200",
      used_tokens: usedTokens, used_cost_cents: String(usedCostCents), unknown_cost_calls: 0,
    }] };
  });
  return { query } as unknown as pg.Pool;
}

const input = {
  tenantId: "org-1", workbenchRunId: "run-1", messages: [],
};
const deps = (db: pg.Pool) => ({ pool: db, llmCfg: {} as never, log: {} as never });

beforeEach(() => runModelCall.mockReset().mockResolvedValue({ result: { text: "done" } }));

it("refuses a provider call before spending after cumulative budget exhaustion", async () => {
  await expect(executePiTurnModelCall(deps(pool(72000, 20)), input))
    .rejects.toBeInstanceOf(MissionBudgetExceededError);
  expect(runModelCall).not.toHaveBeenCalled();
});

it("composes the existing run stop rule with the Mission remainder", async () => {
  const stop = vi.fn().mockResolvedValue(false);
  const db = pool(70000, 50);
  await executePiTurnModelCall(deps(db), { ...input, shouldStopAfterTurn: stop });
  const guarded = runModelCall.mock.calls[0]?.[2] as {
    shouldStopAfterTurn: (turn: unknown) => Promise<boolean>;
  };
  const turn = (tokens: number, costCents: number | null) => ({
    cumulativeUsage: { totalTokens: tokens }, costCents,
  });
  expect(await guarded.shouldStopAfterTurn(turn(1999, 100))).toBe(false);
  expect(await guarded.shouldStopAfterTurn(turn(2000, 100))).toBe(true);
  expect(await guarded.shouldStopAfterTurn(turn(100, 150))).toBe(true);
  expect(await guarded.shouldStopAfterTurn(turn(100, null))).toBe(true);
});
