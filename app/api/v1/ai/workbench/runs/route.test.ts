import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ensureBuiltinAgents } from "@/lib/ai/agents/ensure-builtins";
import { resolveWorkbenchScope } from "@/lib/ai/agents/workbench-scope";
import { loadMissionContinuationAgent } from "@/lib/ai/agents/mission-continuation-agent";
import { resolveOrgLlmConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { createAdminClient } from "@/lib/supabase/admin";
import { appendWorkbenchEvent } from "@/lib/ai/agents/workbench-events";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/ai/agents/ensure-builtins", () => ({ ensureBuiltinAgents: vi.fn() }));
vi.mock("@/lib/ai/agents/workbench-scope", () => ({ resolveWorkbenchScope: vi.fn() }));
vi.mock("@/lib/ai/agents/mission-continuation-agent", () => ({ loadMissionContinuationAgent: vi.fn() }));
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(), LlmNotConfiguredError: class LlmNotConfiguredError extends Error {},
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn(() => ({})) }));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: vi.fn(() => ({ llmCfg: {} })) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/agents/workbench-events", () => ({ appendWorkbenchEvent: vi.fn() }));
vi.mock("@/lib/agent-engine/queue/queue", () => ({ enqueueJob: vi.fn() }));

const ORG = "a3900000-0000-4000-8000-000000000001";
const AGENT = "a3900000-1111-4000-8000-000000000001";
const VERSION = "a3900000-2222-4000-8000-000000000001";
const LEAD = "a3900000-3333-4000-8000-000000000001";

function request(acceptanceContract?: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/workbench/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: AGENT, task: "持续推进报价", mode: "act", scope: { leadId: LEAD },
      mission: { goal: "完成报价协同", acceptanceCriteria: "客户明确接受价格和交期",
        ...(acceptanceContract === undefined ? {} : { acceptanceContract }) },
    }),
  });
}

function stubAdmin() {
  const inserted: Array<{ table: string; value: Record<string, unknown> }> = [];
  const from = vi.fn((table: string) => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({
        data: table === "ai_agents" ? {
          id: AGENT, origin: "user", builtin_key: null,
          published_version_id: VERSION, operation_revision: 2,
        } : table === "ai_agent_versions" ? {
          id: VERSION, status: "published", provider: "openai", model: "test-model",
          tool_ids: [], max_steps: 6, token_budget: 6000, cost_budget_cents: 50,
        } : table === "ai_models" ? { supports_tools: true, deprecated_at: null } : null,
        error: null,
      }),
      insert: async (value: Record<string, unknown>) => {
        inserted.push({ table, value });
        return { error: null };
      },
    };
    return builder;
  });
  vi.mocked(createAdminClient).mockReturnValue({ from } as never);
  return inserted;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true, org: { orgId: ORG, role: "manager" }, user: { id: "user-1" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(ensureBuiltinAgents).mockResolvedValue({ created: 0, existing: 4, agentIds: {} });
  vi.mocked(resolveWorkbenchScope).mockResolvedValue({
    leadId: LEAD, pipelineId: null, contactId: null, conversationId: null,
    channelId: null, contact: undefined, replyContextRevision: null,
  });
  vi.mocked(resolveOrgLlmConfig).mockResolvedValue({} as never);
  vi.mocked(appendWorkbenchEvent).mockResolvedValue(1);
  vi.mocked(enqueueJob).mockResolvedValue({} as never);
});

describe("delegated Mission start", () => {
  it("refuses an Agent that cannot safely continue before writing a Mission", async () => {
    const inserted = stubAdmin();
    vi.mocked(loadMissionContinuationAgent).mockResolvedValue(null);
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("mission_agent_not_eligible");
    expect(loadMissionContinuationAgent).toHaveBeenCalledWith({}, ORG, AGENT, VERSION);
    expect(inserted).toEqual([]);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("persists the safely normalized Agent revision on an eligible Mission", async () => {
    const inserted = stubAdmin();
    vi.mocked(loadMissionContinuationAgent).mockResolvedValue({ operationRevision: 3 });
    const { POST } = await import("./route");
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(inserted.map((item) => item.table)).toEqual(["ai_missions", "ai_workbench_runs"]);
    expect(inserted[1]?.value.runtime_state).toMatchObject({ agentOperationRevision: 3,
      directionRevision: 0 });
    expect(enqueueJob).toHaveBeenCalledOnce();
  });

  it("persists user-selected observable checks with the Mission", async () => {
    const inserted = stubAdmin();
    vi.mocked(loadMissionContinuationAgent).mockResolvedValue({ operationRevision: 3 });
    const { POST } = await import("./route");
    const contract = { revision: 1, checks: [{ kind: "lead_status", equals: "won" }] };
    const response = await POST(request(contract));
    expect(response.status).toBe(201);
    expect(inserted[0]?.value.acceptance_contract).toEqual(contract);
  });

  it("rejects duplicate or unknown observable checks before any write", async () => {
    const inserted = stubAdmin();
    const { POST } = await import("./route");
    for (const contract of [
      { revision: 1, checks: [{ kind: "lead_status", equals: "won" },
        { kind: "lead_status", equals: "lost" }] },
      { revision: 1, checks: [{ kind: "send_without_approval" }] },
    ]) {
      const response = await POST(request(contract));
      expect(response.status).toBe(422);
    }
    expect(inserted).toEqual([]);
  });
});
