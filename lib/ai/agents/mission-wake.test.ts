import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const mocks = vi.hoisted(() => ({
  eligibility: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("@/lib/ai/elegibilidade/consulta-pg", () => ({
  decidirElegibilidadeDaConversa: mocks.eligibility,
}));
vi.mock("@/lib/agent-engine/queue/queue", () => ({ enqueueJob: mocks.enqueue }));

import { wakeMissionsFromInbound } from "./mission-wake";

const input = {
  organizationId: "org-1",
  contactId: "contact-1",
  conversationId: "conversation-1",
  inboundMessageId: "message-1",
  allowlistTtlMs: 60_000,
};

function makePool(options: {
  candidate?: boolean;
  multipleCandidates?: boolean;
  messageType?: string;
  priorWake?: boolean;
  runCount?: number;
  priorStatus?: string;
  budgetExhausted?: boolean;
  agentUnavailable?: boolean;
  currentDirection?: string;
  directionRevision?: number;
} = {}) {
  const statements: string[] = [];
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      calls.push({ sql, params });
      if (sql.includes("for update of m")) return { rows: [{
        id: "mission-1", lead_id: "lead-1", actor_user_id: "user-1",
        goal: "跟进报价", acceptance_criteria: "客户确认报价", max_runs: 4,
        current_direction: options.currentDirection ?? null,
        direction_revision: options.directionRevision ?? 0,
        pipeline_id: "pipeline-1", reply_context_revision: 3,
      }] };
      if (sql.includes("from public.ai_mission_wakes")) {
        return { rows: options.priorWake ? [{ id: "wake-1" }] : [] };
      }
      if (sql.includes("from public.ai_workbench_runs") && sql.includes("order by")) {
        return { rows: [{
          id: "run-1", agent_id: "agent-1", status: options.priorStatus ?? "completed",
          budget: { maxTurns: 6 }, runtime_state: { versionId: "version-1" },
        }] };
      }
      if (sql.includes("count(*)::int")) return { rows: [{ count: options.runCount ?? 1 }] };
      if (sql.includes("m.max_total_tokens")) return { rows: [{
        id: "mission-1", max_total_tokens: 72000, max_total_cost_cents: "200",
        used_tokens: options.budgetExhausted ? 72000 : 12000,
        used_cost_cents: "10", unknown_cost_calls: 0,
      }] };
      if (sql.includes("from public.ai_agents a")) return {
        rows: options.agentUnavailable ? [] : [{ operation_revision: 2 }],
      };
      return { rows: [] };
    }),
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("from public.ai_missions")) {
        return { rows: options.candidate === false ? [] : options.multipleCandidates
          ? [{ id: "mission-1" }, { id: "mission-2" }]
          : [{ id: "mission-1" }] };
      }
      if (sql.includes("from public.messages")) {
        return { rows: [{ type: options.messageType ?? "text" }] };
      }
      return { rows: [] };
    }),
    connect: vi.fn(async () => client),
  };
  return { pool: pool as unknown as Pool, client, statements, calls };
}

describe("customer reply mission wake", () => {
  beforeEach(() => {
    mocks.eligibility.mockReset().mockResolvedValue({ permite: true });
    mocks.enqueue.mockReset().mockResolvedValue({ job: { id: "job-1" }, deduped: false });
  });

  it("does no work without a waiting mission", async () => {
    const { pool } = makePool({ candidate: false });
    expect(await wakeMissionsFromInbound(pool, input)).toBe(false);
    expect(mocks.eligibility).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("fails closed on a denied eligibility gate or non-text input", async () => {
    mocks.eligibility.mockResolvedValueOnce({ permite: false });
    const denied = makePool();
    expect(await wakeMissionsFromInbound(denied.pool, input)).toBe(false);
    expect(denied.pool.connect).not.toHaveBeenCalled();
    const media = makePool({ messageType: "audio" });
    expect(await wakeMissionsFromInbound(media.pool, input)).toBe(false);
    expect(media.pool.connect).not.toHaveBeenCalled();
  });

  it("atomically records one new run, its wake marker and job", async () => {
    const { pool, client, statements } = makePool();
    expect(await wakeMissionsFromInbound(pool, input)).toBe(true);
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining("insert into public.ai_workbench_runs"),
      expect.stringContaining("insert into public.ai_mission_wakes"),
      expect.stringContaining("insert into public.ai_agent_run_events"),
    ]));
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledWith(client, "org-1", expect.objectContaining({
      kind: "workbench_start", sourceEventId: expect.any(String),
    }));
    expect(statements.at(-1)).toBe("commit");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("carries trusted Mission direction into a later customer-reply wake", async () => {
    const { pool, calls } = makePool({ currentDirection: "先核对新的报价依据",
      directionRevision: 3 });
    expect(await wakeMissionsFromInbound(pool, input)).toBe(true);
    const run = calls.find((call) => call.sql.includes("insert into public.ai_workbench_runs"));
    expect(run?.params?.[5]).toContain("当前负责人方向");
    expect(run?.params?.[5]).toContain("先核对新的报价依据");
    expect(run?.params?.[5]).toContain("不是对外动作的批准");
    expect(JSON.parse(String(run?.params?.[8]))).toMatchObject({ directionRevision: 3 });
  });

  it("fails closed when the persisted direction revision cannot be represented safely", async () => {
    const { pool, calls } = makePool({ directionRevision: -1 });
    await expect(wakeMissionsFromInbound(pool, input)).rejects.toThrow(
      "mission_direction_revision_invalid",
    );
    expect(calls.at(-1)?.sql).toBe("rollback");
    expect(calls.some((call) => call.sql.includes("insert into public.ai_workbench_runs"))).toBe(false);
  });

  it("does not schedule a second run for the same inbound message", async () => {
    const { pool, statements } = makePool({ priorWake: true });
    expect(await wakeMissionsFromInbound(pool, input)).toBe(true);
    expect(statements.some((s) => s.includes("insert into public.ai_workbench_runs"))).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("escalates two opportunities for the same contact instead of waking both", async () => {
    const { pool, statements } = makePool({ multipleCandidates: true });
    expect(await wakeMissionsFromInbound(pool, input)).toBe(false);
    expect(statements.some((s) => s.includes("ambiguous_customer_reply"))).toBe(true);
    expect(pool.connect).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("moves a budget-exhausted mission to review, without model spend", async () => {
    const { pool, statements } = makePool({ runCount: 4 });
    expect(await wakeMissionsFromInbound(pool, input)).toBe(true);
    expect(statements.some((s) => s.includes("update public.ai_missions"))).toBe(true);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue a continuation after the cumulative token budget is exhausted", async () => {
    const { pool, statements } = makePool({ budgetExhausted: true });
    expect(await wakeMissionsFromInbound(pool, input)).toBe(true);
    expect(statements.some((s) => s.includes("update public.ai_missions"))).toBe(true);
    expect(statements.some((s) => s.includes("insert into public.ai_workbench_runs"))).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("escalates a paused or replaced Agent instead of auto-running the customer reply", async () => {
    const { pool, statements } = makePool({ agentUnavailable: true });
    expect(await wakeMissionsFromInbound(pool, input)).toBe(true);
    expect(statements.some((statement) => statement.includes("mission_agent_unavailable"))).toBe(true);
    expect(statements.some((statement) => statement.includes("insert into public.ai_workbench_runs"))).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(statements.some((statement) => statement.includes("a.paused_at is null"))).toBe(true);
  });

  it("rolls back a failed enqueue, leaving no stranded run or wake marker", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));
    const { pool, client, statements } = makePool();
    await expect(wakeMissionsFromInbound(pool, input)).rejects.toThrow("queue unavailable");
    expect(statements.at(-1)).toBe("rollback");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
