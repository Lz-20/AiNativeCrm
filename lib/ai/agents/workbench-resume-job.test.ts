import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  maybeSingle: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  runResumed: vi.fn(),
  resolveScope: vi.fn(),
  table: "",
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/ai/agents/run-resumed-workbench-turn", () => ({
  runResumedWorkbenchTurn: mocks.runResumed,
}));
vi.mock("@/lib/ai/agents/workbench-scope", () => ({
  resolveWorkbenchScope: mocks.resolveScope,
}));

import { runWorkbenchResumeJob } from "./workbench-resume-job";

const job = {
  id: "queue-job",
  organization_id: "org-a",
  locked_by: "worker-a",
  claim_acquired_at: "2026-09-26 12:00:00.123456+00",
  payload: { runId: "run-a" },
} as unknown as JobRow;

const pool = {
  query: vi.fn().mockResolvedValue({ rows: [{ current: true }] }),
} as never;

describe("durable workbench resume job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const builder = { select: mocks.select, eq: mocks.eq, maybeSingle: mocks.maybeSingle };
    mocks.select.mockReturnValue(builder);
    mocks.eq.mockReturnValue(builder);
    mocks.from.mockImplementation((table: string) => {
      mocks.table = table;
      return builder;
    });
    mocks.maybeSingle.mockImplementation(async () =>
      mocks.table === "ai_workbench_runs"
        ? {
            data: {
              id: "run-a",
              agent_id: "agent-a",
              mission_id: "mission-a",
              task: "Review this account",
              mode: "act",
              status: "running",
              runtime_state: { versionId: "version-a", directionRevision: 5,
                agentOperationRevision: 3 },
              scope: { leadId: "lead-a" },
              budget: { tokenBudget: 1000 },
              final_text: null,
            },
            error: null,
          }
        : { data: { messages: [{ role: "user", content: "resume me" }] }, error: null },
    );
    mocks.resolveScope.mockResolvedValue({
      contactId: "contact-a",
      conversationId: null,
      channelId: null,
      leadId: "lead-a",
      pipelineId: "pipeline-a",
      contact: { name: "Customer" },
      replyContextRevision: null,
    });
  });

  it("loads the tenant-scoped persisted run and resumes its saved Pi messages", async () => {
    await runWorkbenchResumeJob(job, pool, "worker-a");

    expect(mocks.from).toHaveBeenNthCalledWith(1, "ai_workbench_runs");
    expect(mocks.from).toHaveBeenNthCalledWith(2, "ai_agent_run_states");
    expect(mocks.eq).toHaveBeenCalledWith("organization_id", "org-a");
    expect(mocks.resolveScope).toHaveBeenCalledWith(expect.anything(), "org-a", {
      leadId: "lead-a",
    });
    expect(mocks.runResumed).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        runId: "run-a",
        missionId: "mission-a",
        versionId: "version-a",
        runtimeState: { versionId: "version-a", directionRevision: 5,
          agentOperationRevision: 3 },
        messages: [{ role: "user", content: "resume me" }],
        budget: { tokenBudget: 1000 },
      }),
    );
  });

  it("fails closed when a queue payload has no run identifier", async () => {
    await expect(
      runWorkbenchResumeJob({ ...job, payload: {} } as JobRow, pool, "worker-a"),
    ).rejects.toThrow("workbench_resume_run_id_missing");
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
