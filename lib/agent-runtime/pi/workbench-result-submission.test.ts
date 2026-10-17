import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { adaptAiTools, runPiAiSdkCall } from "@/lib/agent-runtime/pi/ai-sdk-compat";
import { PiAgentRuntime } from "@/lib/agent-runtime/pi/runtime";
import {
  createWorkbenchResultChannel,
  SUBMIT_WORKBENCH_RESULT_TOOL,
} from "@/lib/ai/agents/workbench-result-submission";

describe("Pi structured result adapter", () => {
  it("exposes the field assertion schema and stops after the accepted submission", async () => {
    const candidate = {
      summary: "商机状态已读取。",
      evidence: [{
        sourceType: "lead" as const,
        sourceId: "67b72c24-741b-4c26-8a15-22580211bd7e",
        claim: "商机状态为 open",
        assertions: [{ field: "status" as const, equals: "open" }],
      }],
      missingInformation: [],
      nextStep: "人工核对业务结果",
      wakeCondition: "none" as const,
    };
    const channel = createWorkbenchResultChannel();
    const adapted = adaptAiTools(channel.tools);
    expect(adapted.map((item) => item.name)).toEqual([SUBMIT_WORKBENCH_RESULT_TOOL]);
    expect(adapted[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { summary: expect.any(Object), evidence: expect.any(Object) },
    });
    const faux = fauxProvider({
      provider: "crm-result-test",
      models: [{ id: "crm-result-model" }],
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(SUBMIT_WORKBENCH_RESULT_TOOL, candidate), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("unexpected second turn"),
    ]);
    const runtime = new PiAgentRuntime(() => ({
      model: faux.getModel() as never,
      streamFn: faux.provider.streamSimple.bind(faux.provider) as never,
    }));
    const result = await runPiAiSdkCall({
      system: "Submit a structured result.",
      messages: [{ role: "user", content: "Check this lead" }],
      tools: channel.tools,
      model: { provider: "crm-result-test", model: "crm-result-model", apiKey: "fake" },
      runtime,
      maxSteps: 3,
      shouldStopAfterTurn: () => channel.submitted() !== null,
    });
    expect(channel.submitted()).toEqual(candidate);
    expect(result.turnCount).toBe(1);
    expect(result.steps[0]?.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: SUBMIT_WORKBENCH_RESULT_TOOL }),
    ]));
  });
});
