import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ from: vi.fn(), evaluate: vi.fn(), project: vi.fn() }));
vi.mock("@/lib/ai/integrations/langfuse", () => ({ projectLangfuseEvaluation: mocks.project }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn().mockResolvedValue({ ok: true, org: { orgId: "org" }, user: { id: "user" } }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({ loadAgentVersionConfig: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/ai/evals/semantic-judge", () => ({
  LlmAgentSemanticJudge: vi.fn(),
  WORKBENCH_SEMANTIC_RUBRIC_REVISION: 1,
}));
vi.mock("@/lib/ai/evals/run-evaluation", () => ({ runAgentEvaluation: mocks.evaluate }));
import { GET, POST } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
function stub(failure?: string, corruptChild = false, missingState = false) {
  mocks.from.mockImplementation((table: string) => {
    let multiple = false;
    let child = false;
    const response = () => ({
      error: failure === table ? { message: "read failed" } : null,
      data:
        table === "ai_workbench_runs"
          ? child
            ? [{ id: "child", status: "completed", runtime_state: {} }]
            : {
                id,
                agent_id: "agent",
                task: "Read CRM",
                mode: "inspect",
                status: "completed",
                final_text: "Result",
                runtime_state: {},
                updated_at: "now",
              }
          : table === "ai_agent_run_states"
            ? multiple
              ? [{ run_id: "child", messages: corruptChild ? {} : [] }]
              : missingState
                ? null
                : { messages: [] }
            : table === "ai_agents"
              ? { origin: "user" }
              : [],
    });
    const builder = {
      select: () => builder,
      upsert: async () => ({ error: null }),
      eq: (key: string) => {
        if (key === "parent_run_id") child = true;
        return builder;
      },
      in: () => {
        multiple = true;
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve(response()),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve),
    };
    return builder;
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.evaluate.mockResolvedValue({
    runId: id,
    profileKey: "crm",
    profileRevision: 1,
    verdict: "pass",
    score: 90,
    dimensions: [],
    semanticJudge: { status: "not_run" },
  });
  mocks.project.mockResolvedValue(undefined);
});
describe("real evaluation material is required", () => {
  it("keeps GET read-only and explicitly queues deterministic scores without a judge", async () => {
    stub();
    expect(
      (
        await GET(new NextRequest(`http://localhost/runs/${id}/evaluation`), {
          params: Promise.resolve({ id }),
        })
      ).status,
    ).toBe(200);
    expect(mocks.project).not.toHaveBeenCalled();
    const response = await POST(
      new NextRequest(`http://localhost/runs/${id}/evaluation?mode=deterministic_export`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.project).toHaveBeenCalledWith(
      undefined,
      "org",
      expect.objectContaining({ verdict: "pass" }),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
    expect(mocks.evaluate.mock.calls.at(-1)![0]).not.toHaveProperty("judge");
  });
  it("rejects unknown export modes before a paid judge can run", async () => {
    const response = await POST(
      new NextRequest(`http://localhost/runs/${id}/evaluation?mode=typo`, { method: "POST" }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it.each(["ai_agent_run_events", "ai_agent_action_proposals", "ai_agent_run_states", "ai_agents"])(
    "rejects incomplete %s instead of grading empty material",
    async (failure) => {
      stub(failure);
      const response = await GET(new NextRequest(`http://localhost/runs/${id}/evaluation`), {
        params: Promise.resolve({ id }),
      });
      expect(response.status).toBe(500);
      expect(mocks.evaluate).not.toHaveBeenCalled();
    },
  );
  it("rejects corrupt specialist messages instead of silently dropping them", async () => {
    stub(undefined, true);
    const response = await GET(new NextRequest(`http://localhost/runs/${id}/evaluation`), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(409);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("does not grade a completed run whose persisted observations are missing", async () => {
    stub(undefined, false, true);
    const response = await GET(new NextRequest(`http://localhost/runs/${id}/evaluation`), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(409);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("fails visibly when persisted review storage cannot be read and never invokes a judge", async () => {
    stub("ai_agent_eval_reports");
    const response = await GET(new NextRequest(`http://localhost/runs/${id}/evaluation`), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(503);
    expect(mocks.evaluate.mock.calls[0]?.[0]).not.toHaveProperty("judge");
  });
  it("computes the report from successfully loaded root and specialist material", async () => {
    stub();
    const response = await GET(new NextRequest(`http://localhost/runs/${id}/evaluation`), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(200);
    expect(mocks.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({
          runId: id,
          runtimeMessages: [],
          collaborationRuns: [expect.objectContaining({ id: "child" })],
        }),
      }),
    );
  });
});
