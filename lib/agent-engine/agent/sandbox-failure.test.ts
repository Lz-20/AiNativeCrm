import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCallError } from "@/lib/agent-runtime/errors";
import type * as CheckpointModule from "./checkpoint-contract";
const mocks = vi.hoisted(() => ({ model: vi.fn(), parse: vi.fn() }));
vi.mock("./pi-turn-execution", () => ({ executePiTurnModelCall: mocks.model }));
vi.mock("./checkpoint-contract", async (original) => {
  const actual = await original<typeof CheckpointModule>();
  return {
    ...actual,
    parseCheckpointText: (text: string) => {
      mocks.parse(text);
      return actual.parseCheckpointText(text);
    },
  };
});
vi.mock("./agent-config", () => ({
  loadAgentVersionConfig: async () => ({
    agentId: "agent",
    versionId: "version",
    provider: "deepseek",
    model: "deepseek-flash",
    credentialId: null,
    systemPrompt: "synthetic",
    maxSteps: 2,
    historyMessageWindow: 10,
    historyTokenWindow: 1000,
    handoffKeywords: [],
    handoffToolEnabled: false,
    toolIds: [],
    knowledgeSourceIds: [],
    pipelineIds: [],
    casesEnabled: false,
    multimodalInput: false,
    operatorEnabled: false,
    operatorToolIds: [],
  }),
}));
vi.mock("./turn-tools", () => ({
  buildTurnTools: async () => ({
    rawTools: {},
    mcpCleanup: null,
    entregues: [],
    mcpToolIdsDoTurno: [],
  }),
}));
import { testAgentVersion } from "./sandbox";
const pool = {
  query: vi.fn(async (sql: string) => ({
    rows: sql.includes("from playbook_pointers")
      ? [{ layer: "platform", version_id: "platform", content: "synthetic policy" }]
      : [],
  })),
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const deps = {
  log,
  crmCfg: {},
  llmCfg: {},
  knobs: {
    historyLimit: 10,
    maxContextTokens: 1000,
    maxSteps: 2,
    notesIndexMaxTokens: 1000,
    breaker: {},
  },
};
const input = {
  organizationId: "org",
  agentId: "agent",
  versionId: "version",
  runId: "preview",
  requestId: "request-synthetic",
  sampleMessage: "synthetic question",
  channelId: null,
};
function completion(text: string) {
  return {
    result: { text, response: { messages: [] }, runtimeMessages: [], toolCalls: [] },
    events: [],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    costCents: 0,
    model: "synthetic",
  };
}
beforeEach(() => {
  vi.clearAllMocks();
});

describe("the actual draft sandbox path contains model failures", () => {
  it("model failure stops before checkpoint parsing and preserves correlation", async () => {
    mocks.model.mockRejectedValue(
      new ModelCallError("model_http_401", "provider_http", 401, "error"),
    );
    await expect(testAgentVersion(pool as never, deps as never, input)).rejects.toMatchObject({
      code: "model_http_401",
    });
    expect(mocks.model).toHaveBeenCalledOnce();
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.model.mock.calls[0]?.[1]).toHaveProperty("purpose", "agent_preview");
    expect(JSON.stringify(log.info.mock.calls)).toContain("request-synthetic");
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("synthetic question");
  });
  it("successful model and valid checkpoint complete the preview without operational writes", async () => {
    mocks.model
      .mockResolvedValueOnce(completion("synthetic draft"))
      .mockResolvedValueOnce(
        completion(
          '{"commitments":[],"objections":[],"next_action":null,"rolling_summary":"synthetic"}',
        ),
      );
    const result = await testAgentVersion(pool as never, deps as never, input);
    expect(result.checkpoint).toHaveProperty("rolling_summary", "synthetic");
    expect(mocks.parse).toHaveBeenCalledOnce();
    expect(mocks.model.mock.calls.map((call) => call[1].purpose)).toEqual([
      "agent_preview",
      "checkpoint",
    ]);
    expect(
      pool.query.mock.calls.some(([sql]) =>
        /insert into (messages|contacts|conversations)/i.test(sql),
      ),
    ).toBe(false);
  });
});
