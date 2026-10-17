import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { Pool } from "pg";

const mocks = vi.hoisted(() => ({
  model: vi.fn(),
  event: vi.fn(async () => 1),
  query: vi.fn(),
  admin: vi.fn(),
  collaboration: vi.fn(),
  selectPlan: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/agent-engine/agent/pi-turn-execution", () => ({
  executePiTurnModelCall: mocks.model,
}));
vi.mock("@/lib/ai/agents/workbench-events", () => ({ appendWorkbenchEvent: mocks.event }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: mocks.query }),
}));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({
  requestTurnDeps: () => ({ crmCfg: {}, llmCfg: {}, log: {}, runtime: {} }),
}));
vi.mock("@/lib/ai/agents/workbench-job-lease", () => ({ assertWorkbenchJobLease: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadAgentVersionConfig: async () => ({
    systemPrompt: "CRM playbook",
    model: "test",
    maxSteps: 8,
  }),
}));
vi.mock("@/lib/agent-engine/edge/crm/mcp-tools", () => ({
  buildMcpTurnTools: async () => ({ tools: {}, cleanup: vi.fn() }),
}));
vi.mock("@/lib/ai/agents/workbench-scope", () => ({
  resolveWorkbenchScope: async () => ({
    contactId: null,
    leadId: null,
    conversationId: null,
    pipelineId: null,
  }),
}));
vi.mock("@/lib/ai/agents/collaboration", () => ({
  selectCollaborationPlan: mocks.selectPlan,
  collaborationPlanForMission: (plan: unknown) => plan,
}));
vi.mock("@/lib/ai/agents/workbench-collaboration", () => ({
  runWorkbenchCollaboration: mocks.collaboration,
}));
import { runWorkbenchStartJob } from "./workbench-start-job";

const job = {
  id: "job1",
  organization_id: "org1",
  payload: { runId: "run1" },
  attempts: 1,
  max_attempts: 3,
} as unknown as JobRow;
const pool = { query: mocks.query } as unknown as Pool;
const policyRow = {
  id: "version3",
  version_id: "version3",
  organization_id: "org1",
  version_number: 3,
  content: "Published organization policy",
  created_at: "2026-10-01T00:00:00Z",
  published_at: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectPlan.mockReturnValue(null);
  mocks.collaboration.mockResolvedValue(null);
  mocks.model.mockRejectedValue(new Error("stop_after_model_input"));
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("from org_memory_pointers") ? [policyRow] : [],
  }));
  mocks.admin.mockReturnValue({
    from: (table: string) => {
      const data =
        table === "ai_workbench_runs"
          ? {
              id: "run1",
              status: "running",
              agent_id: "agent1",
              task: "Check CRM",
              mode: "inspect",
              runtime_state: { versionId: "agent-version1" },
              mission_id: null,
              scope: {},
              budget: {},
            }
          : table === "ai_agent_action_proposals"
            ? []
            : null;
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data, error: null }),
        then: (resolve: (result: unknown) => unknown) =>
          Promise.resolve(resolve({ data, error: null })),
      };
      return builder;
    },
  });
});

describe("Workbench initial organization memory", () => {
  it("injects published policies before any model/tool decision and emits body-free provenance", async () => {
    await expect(runWorkbenchStartJob(job, pool, "worker1")).rejects.toThrow(
      "stop_after_model_input",
    );
    expect(mocks.model).toHaveBeenCalledOnce();
    const input = mocks.model.mock.calls[0]![1];
    expect(input.system).toContain("CRM playbook\n\n=== memória da organização");
    expect(input.system).toContain(policyRow.content);
    expect(input.system).toContain("Revisão: sha256:");
    expect(mocks.event).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "context_loaded",
        payload: {
          orgMemoryRevision: expect.stringMatching(/^sha256:/),
          orgMemoryVersionId: "version3",
          orgMemoryVersionNumber: 3,
          orgMemoryEntriesCount: 0,
          memoryResolution: "current_published",
        },
      }),
    );
  });

  it("passes the same policy-bearing configuration to specialists and retains it in their system prompt", async () => {
    mocks.selectPlan.mockReturnValue({ key: "test-plan" });
    await expect(runWorkbenchStartJob(job, pool, "worker1")).rejects.toThrow(
      "stop_after_model_input",
    );
    expect(mocks.collaboration).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: expect.objectContaining({
          systemPrompt: expect.stringContaining(policyRow.content),
        }),
      }),
    );
    const specialist = readFileSync("lib/ai/agents/workbench-collaboration.ts", "utf8");
    expect(specialist).toMatch(/system:\s*\[\s*(?:\/\/[^\n]*\n\s*)*childConfig\.systemPrompt/);
  });

  it("does not call the model when the policy database fails", async () => {
    mocks.query.mockRejectedValue(new Error("memory_database_unavailable"));
    await expect(runWorkbenchStartJob(job, pool, "worker1")).rejects.toThrow(
      "memory_database_unavailable",
    );
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.collaboration).not.toHaveBeenCalled();
  });
});
