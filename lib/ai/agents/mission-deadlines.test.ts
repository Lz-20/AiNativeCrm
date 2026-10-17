import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { expireDueMissionWaits, runMissionDeadlineLoop } from "./mission-deadlines";

it("moves only expired waiting missions to review without claiming success", async () => {
  const query = vi.fn().mockResolvedValue({ rowCount: 2 });
  expect(await expireDueMissionWaits({ query } as unknown as Pool)).toBe(2);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("deadline_at<=now()"));
  const sql = query.mock.calls[0]?.[0] as string;
  expect(sql).toContain("status in ('waiting_customer','waiting_internal')");
  expect(sql).toContain("status='needs_review'");
  expect(sql).toContain("wake_on_customer_reply=false");
});

it("stops a deadline loop cleanly when the worker shuts down", async () => {
  const controller = new AbortController();
  const query = vi.fn().mockImplementation(async () => {
    controller.abort();
    return { rowCount: 0 };
  });
  const log = { error: vi.fn() };
  await runMissionDeadlineLoop({ query } as unknown as Pool, log, controller.signal, 10_000);
  expect(query).toHaveBeenCalledOnce();
  expect(log.error).not.toHaveBeenCalled();
});
