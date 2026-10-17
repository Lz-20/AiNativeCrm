import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  missionDirectionLockKey,
  withMissionDirectionWriteFence,
} from "./mission-direction-fence";

const scope = {
  organizationId: "org-a",
  missionId: "mission-a",
  runId: "run-a",
  expectedRevision: 2,
};

function makePool(row: Record<string, unknown> | null = {
  direction_revision: "2", run_revision: "2",
  run_status: "running", mission_status: "running",
}) {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      return { rows: sql.includes("from public.ai_workbench_runs") && row ? [row] : [] };
    }),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client, statements };
}

describe("Mission direction write fence", () => {
  it("does not need a Mission lock for a normal Workbench run", async () => {
    const { pool } = makePool();
    const action = vi.fn(async () => "written");
    await expect(withMissionDirectionWriteFence(pool, { ...scope, missionId: null }, action))
      .resolves.toBe("written");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("keeps the scoped advisory lock until the CRM tool returns", async () => {
    const { pool, client, statements } = makePool();
    const action = vi.fn(async () => {
      expect(statements.map((item) => item.sql)).toContainEqual(
        expect.stringContaining("for share of m"),
      );
      expect(statements.some((item) => item.sql === "commit")).toBe(false);
      return "written";
    });
    await expect(withMissionDirectionWriteFence(pool, scope, action)).resolves.toBe("written");
    expect(statements.map((item) => item.sql)).toEqual([
      "begin",
      "set local lock_timeout = '5s'",
      "select pg_advisory_xact_lock(hashtextextended($1,0))",
      expect.stringContaining("for share of m"),
      "commit",
    ]);
    expect(statements[2]?.params).toEqual([missionDirectionLockKey("org-a", "mission-a")]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects missing and stale revisions before calling the CRM tool", async () => {
    const invalid = makePool();
    const action = vi.fn(async () => "written");
    await expect(withMissionDirectionWriteFence(invalid.pool,
      { ...scope, expectedRevision: undefined }, action))
      .rejects.toMatchObject({ code: "revision_missing" });
    expect(invalid.pool.connect).not.toHaveBeenCalled();

    const stale = makePool({ direction_revision: "3", run_revision: "2",
      run_status: "running", mission_status: "running" });
    await expect(withMissionDirectionWriteFence(stale.pool, scope, action))
      .rejects.toMatchObject({ code: "revision_changed" });
    expect(action).not.toHaveBeenCalled();
    expect(stale.statements.at(-1)?.sql).toBe("rollback");
    expect(stale.client.release).toHaveBeenCalledOnce();
  });

  it("rejects a cancelled Run and releases the lock after a failed CRM tool", async () => {
    const inactive = makePool({ direction_revision: "2", run_revision: "2",
      run_status: "cancelled", mission_status: "running" });
    await expect(withMissionDirectionWriteFence(inactive.pool, scope, async () => "written"))
      .rejects.toMatchObject({ code: "run_inactive" });
    expect(inactive.statements.at(-1)?.sql).toBe("rollback");

    const failed = makePool();
    await expect(withMissionDirectionWriteFence(failed.pool, scope, async () => {
      throw new Error("crm_update_failed");
    })).rejects.toThrow("crm_update_failed");
    expect(failed.statements.at(-1)?.sql).toBe("rollback");
  });
});
