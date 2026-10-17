import { describe, expect, it, vi } from "vitest";
import type { RuntimeMessage } from "@/lib/agent-runtime";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiAgentRuntime } from "@/lib/agent-runtime/pi/runtime";
import { runPiAiSdkCall } from "@/lib/agent-runtime/pi/ai-sdk-compat";

const mocks = vi.hoisted(() => ({
  model: vi.fn(),
  reversible: vi.fn(),
  event: vi.fn(async () => undefined),
  query: vi.fn(async (sql: string) => ({ rows: sql.includes("from org_memory_pointers") ? [{
    id: "memory-version-4", version_id: "memory-version-4", organization_id: "org-1", version_number: 4,
    content: "Current published policy for resumed runs", created_at: "2026-10-01T00:00:00Z",
    published_at: "2026-10-01T00:00:00Z",
  }] : [] })),
  stopForDirection: vi.fn(async (
    _pool: unknown,
    _input: { organizationId: string; missionId: string; runId: string },
  ) => true),
}));

vi.mock("@/lib/agent-engine/agent/pi-turn-execution", () => ({ executePiTurnModelCall: mocks.model }));
vi.mock("@/lib/ai/agents/reversible-lead-update", () => ({ executeReversibleLeadUpdate: mocks.reversible }));
vi.mock("@/lib/ai/agents/workbench-events", () => ({ appendWorkbenchEvent: mocks.event }));
vi.mock("@/lib/ai/agents/mission-direction-fence", async (importOriginal) => ({
  ...await importOriginal(),
  stopMissionRunAfterDirectionFence: mocks.stopForDirection,
}));
vi.mock("@/lib/ai/agents/mission-direction-consumption", async (importOriginal) => ({
  ...await importOriginal(),
  loadMissionDirectionContextProbe: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({
  requestTurnDeps: () => ({ crmCfg: {}, llmCfg: {}, log: {}, runtime: {} }),
}));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadAgentVersionConfig: async () => ({
    systemPrompt: "CRM",
    model: "test-model",
    provider: "test-provider",
    credentialId: "credential",
    maxSteps: 8,
  }),
}));
vi.mock("@/lib/agent-engine/edge/crm/mcp-tools", () => ({
  buildMcpTurnTools: async () => ({
    tools: { crm_update_lead: { execute: async () => ({ content: "staged" }) } },
    cleanup: async () => undefined,
  }),
}));

import { runResumedWorkbenchTurn } from "@/lib/ai/agents/run-resumed-workbench-turn";
import { MissionDirectionFenceError } from "@/lib/ai/agents/mission-direction-fence";

describe("resumed workbench turn", () => {
  it("delivers the current memory revision to real Pi after JSON restore and persists that same context", async () => {
    vi.clearAllMocks();
    let status = "running";
    let savedMessages: RuntimeMessage[] = [];
    const admin = {
      from(table: string) {
        const builder = {
          select: () => builder, eq: () => builder, order: () => builder, limit: () => builder,
          upsert: (row: { messages: RuntimeMessage[] }) => {
            savedMessages = JSON.parse(JSON.stringify(row.messages));
            return Promise.resolve({ error: null });
          },
          update: (row: { status?: string }) => {
            if (table === "ai_workbench_runs" && row.status) status = row.status;
            return builder;
          },
          maybeSingle: async () => ({ data: table === "ai_workbench_runs" ? { status } : null, error: null }),
          then: (resolve: (value: { error: null; count: number }) => unknown) =>
            Promise.resolve(resolve({ error: null, count: 0 })),
        };
        return builder;
      },
    };
    let providerContext = "not called";
    const faux = fauxProvider({ provider: "crm-test-provider", models: [{ id: "crm-test-model" }] });
    faux.setResponses([
      fauxAssistantMessage("Earlier finding."),
      (context) => {
        providerContext = getCurrentSystemPrompt(context.messages);
        return fauxAssistantMessage(fauxToolCall("submit_workbench_result", {
          summary: "已按当前规则完成核对。", evidence: [], missingInformation: [],
          nextStep: "人工复核", wakeCondition: "none",
        }), { stopReason: "toolUse" });
      },
    ]);
    const runtime = new PiAgentRuntime(() => ({
      model: faux.getModel() as never,
      streamFn: faux.provider.streamSimple.bind(faux.provider) as never,
    }));
    const model = { provider: "crm-test-provider", model: "crm-test-model", apiKey: "test-key" };
    const first = await runtime.run({ systemPrompt: "OLD_MEMORY_v1", prompt: "核对报价", model });
    // The gateway transport is replaced; the actual compatibility adapter,
    // Pi core, history restore, tools, and event callbacks all execute below.
    mocks.model.mockImplementation(async (_deps, input) => {
      const result = await runPiAiSdkCall({
        system: input.system, messages: input.messages, runtimeMessages: input.runtimeMessages,
        tools: input.tools, maxSteps: input.maxSteps, abortSignal: input.abortSignal,
        shouldStopAfterTurn: () => true, onEvent: input.onEvent, model, runtime,
      });
      return { result, events: result.events,
        usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }, costCents: 0 };
    });
    await runResumedWorkbenchTurn({
      admin: admin as never, organizationId: "org-1", runId: "run-1", jobId: "job-1",
      agentId: "agent-1", missionId: null, versionId: "version-1", runtimeState: { versionId: "version-1" },
      task: "核对报价", mode: "inspect",
      scope: { contactId: null, leadId: null, conversationId: null, pipelineId: null, channelId: null },
      messages: JSON.parse(JSON.stringify(first.messages)), budget: { maxSteps: 2 }, priorFinalText: null,
    });
    const eventCalls = mocks.event.mock.calls as unknown as Array<[unknown, {
      type: string; payload: Record<string, unknown>;
    }]>;
    const provenance = eventCalls.find(([, event]) => event.type === "context_loaded")?.[1].payload;
    expect(provenance).toMatchObject({ orgMemoryVersionId: "memory-version-4", orgMemoryVersionNumber: 4,
      orgMemoryRevision: expect.stringMatching(/^sha256:/), memoryResolution: "current_published" });
    expect(providerContext).toContain("Current published policy for resumed runs");
    expect(providerContext).toContain(`Revisão: ${provenance?.orgMemoryRevision}`);
    expect(providerContext).not.toContain("OLD_MEMORY_v1");
    expect(savedMessages[0]).toEqual({ role: "system", content: providerContext });
    expect(savedMessages.some((message) => message.role === "assistant" && message.content === "Earlier finding.")).toBe(true);
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(status).toBe("completed");
  });

  it("stops a stale Mission direction without retrying the model or reporting resume_failed", async () => {
    vi.clearAllMocks();
    const beforeSideEffect = vi.fn(async () => undefined);
    const admin = {
      from: () => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: { status: "running" }, error: null }),
        };
        return builder;
      },
    };
    mocks.model.mockRejectedValueOnce(new MissionDirectionFenceError("revision_changed"));

    await runResumedWorkbenchTurn({
      admin: admin as never,
      organizationId: "org-1", runId: "run-1", jobId: "job-1",
      agentId: "agent-1", missionId: "mission-1", versionId: "version-1",
      runtimeState: { directionRevision: 1 }, task: "推进商机", mode: "act",
      scope: { contactId: null, leadId: null, conversationId: null,
        pipelineId: null, channelId: null },
      messages: [{ role: "user", content: "核对报价" }],
      budget: { maxSteps: 8 }, priorFinalText: null, beforeSideEffect,
    });

    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.stopForDirection).toHaveBeenCalledOnce();
    expect(mocks.stopForDirection.mock.calls[0]?.[1]).toMatchObject({
      organizationId: "org-1", missionId: "mission-1", runId: "run-1",
    });
    expect(beforeSideEffect).toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "run_failed", payload: expect.objectContaining({ code: "resume_failed" }),
    }));
  });

  it("retains each model decision and tool observation across two automatic writes", async () => {
    vi.clearAllMocks();
    let status = "running";
    let savedRuntimeState: Record<string, unknown> | null = null;
    let savedMessages: RuntimeMessage[] = [];
    const proposals: Array<{ id: string; sequence: number; status: string }> = [];
    let currentTable = "";
    let pendingInsert: { id: string; sequence: number; status: string } | null = null;
    const admin = {
      from(table: string) {
        currentTable = table;
        const builder = {
          select: () => builder,
          eq: () => builder,
          order: () => builder,
          limit: () => builder,
          upsert: (row: { messages: RuntimeMessage[] }) => {
            savedMessages = row.messages;
            return Promise.resolve({ error: null });
          },
          insert: (row: { sequence: number }) => {
            pendingInsert = { id: `proposal-${row.sequence}`, sequence: row.sequence, status: "pending" };
            proposals.push(pendingInsert);
            return builder;
          },
          update: (row: { messages?: RuntimeMessage[]; status?: string;
            runtime_state?: Record<string, unknown> }) => {
            if (currentTable === "ai_agent_run_states" && row.messages) savedMessages = row.messages;
            if (currentTable === "ai_agent_action_proposals" && row.status && proposals.length)
              proposals[proposals.length - 1]!.status = row.status;
            if (currentTable === "ai_workbench_runs" && row.status) status = row.status;
            if (currentTable === "ai_workbench_runs" && row.runtime_state)
              savedRuntimeState = row.runtime_state;
            return builder;
          },
          maybeSingle: async () => {
            if (currentTable === "ai_workbench_runs") return { data: { status }, error: null };
            if (currentTable === "ai_agent_action_proposals")
              return { data: proposals.length ? { sequence: proposals.at(-1)!.sequence } : null, error: null };
            return { data: null, error: null };
          },
          single: async () => ({ data: pendingInsert, error: null }),
          then: (resolve: (value: { error: null; count?: number }) => unknown) =>
            Promise.resolve(resolve({
              error: null,
              ...(currentTable === "ai_agent_action_proposals"
                ? { count: proposals.filter((proposal) => proposal.status === "pending").length }
                : {}),
            })),
        };
        return builder;
      },
    };
    mocks.reversible.mockImplementation(async () => ({
      compensationArgs: {},
      preview: { resourceUuid: "lead-1", changedFields: ["title"] },
      result: { updated: true },
    }));
    const modelInputs: RuntimeMessage[][] = [];
    mocks.model.mockImplementation(async (_deps, input) => {
      const messages = input.runtimeMessages as RuntimeMessage[];
      modelInputs.push(messages);
      const turn = modelInputs.length;
      if (turn <= 2) {
        await input.tools.crm_update_lead.execute({ title: `phase-${turn}` }, {});
        return { result: {
          text: `阶段 ${turn}`,
          turnCount: 1,
          runtimeMessages: [
            ...messages,
            { role: "assistant", content: `已提议更新 ${turn}`, toolCalls: [{
              id: `write-${turn}`, name: "crm_update_lead", arguments: { title: `phase-${turn}` },
            }] },
          ],
        }, usage: { inputTokens: 1, outputTokens: 1 }, costCents: 0 };
      }
      await input.tools.submit_workbench_result.execute({
        summary: "两次商机更新已完成。",
        evidence: [], missingInformation: [], nextStep: "核对商机状态", wakeCondition: "none",
      }, {});
      return { result: {
        text: "任务完成", turnCount: 1,
        runtimeMessages: [...messages, { role: "assistant", content: "任务完成" }],
      }, usage: { inputTokens: 1, outputTokens: 1 }, costCents: 0 };
    });

    await runResumedWorkbenchTurn({
      admin: admin as never,
      organizationId: "org-1",
      runId: "run-1",
      jobId: "job-1",
      agentId: "agent-1",
      missionId: null,
      versionId: "version-1",
      runtimeState: { versionId: "version-1", agentOperationRevision: 7,
        replyContextRevision: 4, directionRevision: 2 },
      task: "推进商机",
      mode: "act",
      scope: { contactId: null, leadId: "lead-1", conversationId: null, pipelineId: null, channelId: null },
      messages: [
        { role: "user", content: "读取商机" },
        { role: "assistant", content: "先读取", toolCalls: [{ id: "read-1", name: "crm_get_lead", arguments: {} }] },
        { role: "tool", toolCallId: "read-1", toolName: "crm_get_lead", content: "待跟进" },
      ],
      budget: { maxSteps: 8 },
      priorFinalText: null,
    });

    expect(mocks.model).toHaveBeenCalledTimes(3);
    for (const [, input] of mocks.model.mock.calls) {
      expect(input.system).toContain("Current published policy for resumed runs");
      expect(input.system).toContain("Revisão: sha256:");
    }
    expect(mocks.event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "context_loaded", payload: expect.objectContaining({
        orgMemoryVersionId: "memory-version-4", orgMemoryVersionNumber: 4,
        memoryResolution: "current_published",
      }),
    }));
    expect(mocks.reversible).toHaveBeenCalledTimes(2);
    expect(modelInputs[1]?.some((message) => message.role === "assistant" && message.content === "已提议更新 1")).toBe(true);
    expect(modelInputs[2]?.some((message) => message.role === "assistant" && message.content === "已提议更新 2")).toBe(true);
    expect(savedMessages.filter((message) => message.role === "assistant")).toHaveLength(4);
    expect(proposals.map((proposal) => proposal.status)).toEqual(["executed", "executed"]);
    expect(status).toBe("completed");
    expect(savedRuntimeState).toMatchObject({ versionId: "version-1",
      agentOperationRevision: 7, replyContextRevision: 4, directionRevision: 2 });
  });
});
