import { describe, expect, it, vi } from "vitest";
import { assertWorkbenchJobLease } from "./workbench-job-lease";

const job = {
  id: "job-1",
  organization_id: "org-1",
  locked_by: "worker-1",
  claim_acquired_at: "2026-09-26 12:00:00.123456+00",
} as never;

describe("workbench job lease fencing", () => {
  it("requires the exact current claim before CRM-side effects", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ current: true }] });
    await expect(
      assertWorkbenchJobLease({ query } as never, job, "worker-1"),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("locked_at=$4::timestamptz"), [
      "job-1",
      "org-1",
      "worker-1",
      "2026-09-26 12:00:00.123456+00",
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("m.status not in ('cancelled','completed')");
    expect(query.mock.calls[0]?.[0]).toContain("r.status<>'cancelled'");
    expect(query.mock.calls[0]?.[0]).toContain("a.paused_at is null");
    expect(query.mock.calls[0]?.[0]).toContain("a.published_version_id=v.id");
    expect(query.mock.calls[0]?.[0]).toContain("v.status='draft'");
  });

  it("rejects a stale claim and a different worker", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ current: false }] });
    await expect(assertWorkbenchJobLease({ query } as never, job, "worker-1")).rejects.toThrow(
      "workbench_job_lease_lost",
    );
    await expect(assertWorkbenchJobLease({ query } as never, job, "worker-2")).rejects.toThrow(
      "workbench_job_lease_missing",
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});
