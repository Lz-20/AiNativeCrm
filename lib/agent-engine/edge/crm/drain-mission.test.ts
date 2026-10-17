import { expect, it, vi } from "vitest";
import type pg from "pg";

const wake = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai/agents/mission-wake", () => ({ wakeMissionsFromInbound: wake }));

import { drainTick } from "./drain";

it("lets a waiting mission own a customer reply even when no channel agent is published", async () => {
  wake.mockReset().mockResolvedValue(true);
  const sql: string[] = [];
  const pool = { query: vi.fn(async (statement: string) => {
    sql.push(statement);
    if (statement.includes("returning e.id")) return { rows: [{
      id: "event-1", organization_id: "org-1", attempts: 1,
      payload: {
        conversation_id: "11111111-1111-4111-8111-111111111111",
        contact_id: "22222222-2222-4222-8222-222222222222",
        channel_session_id: "33333333-3333-4333-8333-333333333333",
        inbound_message_id: "44444444-4444-4444-8444-444444444444",
      },
    }] };
    if (statement.includes("ai_dispatch_mode")) return { rows: [{ mode: null }] };
    if (statement.includes("is_group")) return { rows: [{ is_group: false }] };
    if (statement.includes("tem_agente")) {
      return { rows: [{ tem_agente: false, tem_roteador: false }] };
    }
    if (statement.includes("direction = 'inbound'")) {
      return { rows: [{ id: "44444444-4444-4444-8444-444444444444" }] };
    }
    return { rows: [] };
  }) } as unknown as pg.Pool;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

  await drainTick(pool, {
    batchSize: 10, intervalMs: 0, idleIntervalMs: 0,
    debounceMs: 0, reapTimeoutMs: 60_000,
  }, log);

  expect(wake).toHaveBeenCalledOnce();
  expect(wake).toHaveBeenCalledWith(pool, expect.objectContaining({
    inboundMessageId: "44444444-4444-4444-8444-444444444444",
  }));
  expect(sql.some((statement) => statement.includes("insert into job_queue"))).toBe(false);
  expect(sql.some((statement) => statement.includes("status = 'done'"))).toBe(true);
});
