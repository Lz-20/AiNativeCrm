import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

import type { AgentRuntime } from "../types";
import { PiAgentRuntime } from "./runtime";
import { runPiAiSdkCall } from "./ai-sdk-compat";

const model = {
  provider: "crm-test-provider",
  model: "crm-test-model",
  apiKey: "test-key",
};

function runtimeWithFaux(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
): AgentRuntime {
  const faux = fauxProvider({
    provider: "crm-test-provider",
    models: [{ id: "crm-test-model" }],
  });
  faux.setResponses(responses);
  return new PiAgentRuntime(() => ({
    model: faux.getModel() as never,
    streamFn: faux.provider.streamSimple.bind(faux.provider) as never,
  }));
}

describe("Vercel AI compatibility adapter", () => {
  it("preserves tool execution and returns an AI-SDK-shaped result", async () => {
    const execute = vi.fn(async ({ id }: { id: string }) => ({ found: id }));
    const result = await runPiAiSdkCall({
      system: "You are a CRM assistant.",
      messages: [{ role: "user", content: "look up the lead" }],
      model,
      runtime: runtimeWithFaux([
        fauxAssistantMessage(fauxToolCall("lookup", { id: "lead-1" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("found it"),
      ]),
      tools: {
        lookup: tool({
          description: "Find a lead.",
          inputSchema: z.object({ id: z.string() }),
          execute,
        }),
      },
      maxSteps: 4,
    });

    expect(execute).toHaveBeenCalledWith({ id: "lead-1" }, expect.anything());
    expect(result.text).toBe("found it");
    expect(result.steps[0]?.toolCalls[0]?.toolName).toBe("lookup");
    expect(result.response.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("blocks mutating tools in evaluation mode before the wrapped execute function", async () => {
    const execute = vi.fn(async () => ({ sent: true }));
    const result = await runPiAiSdkCall({
      system: "Never send without authorization.",
      messages: [{ role: "user", content: "send it" }],
      model,
      runtime: runtimeWithFaux([
        fauxAssistantMessage(fauxToolCall("send_message", { body: "hello" }), {
          stopReason: "toolUse",
        }),
      ]),
      tools: {
        send_message: tool({
          description: "Send a message.",
          inputSchema: z.object({ body: z.string() }),
          execute,
        }),
      },
      evaluation: true,
      maxSteps: 4,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.text).toBe("");
  });

  it("uses explicit capability metadata instead of inferring side effects from names", async () => {
    const execute = vi.fn(async () => ({ sent: true }));
    const ambiguouslyNamedTool = Object.assign(
      tool({
        description: "Send a message through a deliberately ambiguous name.",
        inputSchema: z.object({ body: z.string() }),
        execute,
      }),
      { capability: "send" as const },
    );

    const result = await runPiAiSdkCall({
      system: "Never send without authorization.",
      messages: [{ role: "user", content: "notify the customer" }],
      model,
      runtime: runtimeWithFaux([
        fauxAssistantMessage(fauxToolCall("notify_customer", { body: "hello" }), {
          stopReason: "toolUse",
        }),
      ]),
      tools: { notify_customer: ambiguouslyNamedTool },
      evaluation: true,
      maxSteps: 4,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.text).toBe("");
  });

  it("forwards CRM context and tool lifecycle hooks through the compatibility seam", async () => {
    const execute = vi.fn(async () => ({ content: "looked up" }));
    const transformContext = vi.fn(async (messages) => messages);
    const beforeToolCall = vi.fn(async () => undefined);
    const afterToolCall = vi.fn(async () => undefined);
    const onEvent = vi.fn();
    const result = await runPiAiSdkCall({
      system: "Use the CRM tool.",
      messages: [{ role: "user", content: "look it up" }],
      model,
      runtime: runtimeWithFaux([
        fauxAssistantMessage(fauxToolCall("lookup", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]),
      tools: {
        lookup: tool({
          description: "Look up a record.",
          inputSchema: z.object({}),
          execute,
        }),
      },
      transformContext,
      beforeToolCall,
      afterToolCall,
      onEvent,
      maxSteps: 4,
    });

    expect(transformContext).toHaveBeenCalled();
    expect(beforeToolCall).toHaveBeenCalledWith(expect.objectContaining({ name: "lookup" }));
    expect(afterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: "lookup", result: expect.anything() }),
    );
    expect(onEvent).toHaveBeenCalled();
    expect(result.events.some((event) => event.type === "tool_execution_end")).toBe(true);
    expect(result.text).toBe("done");
  });

  it("forwards durable steering through the compatibility seam into Pi's next turn", async () => {
    const direction = "负责人要求先核对新合同";
    const poll = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: "direction-1", content: direction }]);
    const result = await runPiAiSdkCall({
      system: "CRM",
      messages: [{ role: "user", content: "核对商机" }],
      model,
      runtime: runtimeWithFaux([
        fauxAssistantMessage("旧计划"),
        (context) => {
          expect(JSON.stringify(context.messages)).toContain(direction);
          return fauxAssistantMessage("已按新合同核对");
        },
      ]),
      steering: { poll },
      maxSteps: 3,
    });
    expect(result.text).toBe("已按新合同核对");
    expect(result.runtimeMessages.some((message) => message.role === "user" &&
      JSON.stringify(message.content).includes(direction))).toBe(true);
    expect(result.events.filter((event) => event.type === "steering_queued"))
      .toEqual([{ type: "steering_queued", data: { steeringId: "direction-1" } }]);
    expect(result.events.filter((event) => event.type === "steering_consumed"))
      .toEqual([{ type: "steering_consumed", data: { steeringId: "direction-1" } }]);
  });

  it("forwards a private model-context probe without exposing its text in events", async () => {
    const direction = JSON.stringify("先核对新的报价");
    const probeId = "manager-direction:mission-1:1";
    const result = await runPiAiSdkCall({
      system: "CRM", messages: [{ role: "user", content: `负责人方向：${direction}` }],
      model, runtime: runtimeWithFaux([fauxAssistantMessage("已核对")]),
      contextProbe: { id: probeId, userText: direction },
    });
    expect(result.events.filter((event) => event.type === "model_context_consumed"))
      .toEqual([{ type: "model_context_consumed", data: { probeId } }]);
    expect(JSON.stringify(result.events)).not.toContain(direction);
  });

  it("continues from CRM-owned runtime messages without replaying completed tool calls", async () => {
    const execute = vi.fn(async () => ({ shouldNeverRun: true }));
    const resumed = await runPiAiSdkCall({
      system: "Continue the CRM task from the persisted state.",
      messages: [],
      runtimeMessages: [
        { role: "user", content: "Move the lead after review." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-1", name: "crm_move_lead_stage", arguments: { lead_id: "lead-1" } },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          toolName: "crm_move_lead_stage",
          content: "proposal_only",
        },
        { role: "assistant", content: "I have proposed moving it." },
        { role: "user", content: "CRM Harness observation: the move succeeded." },
      ],
      model,
      runtime: runtimeWithFaux([fauxAssistantMessage("The lead is now in the requested stage.")]),
      tools: {
        crm_move_lead_stage: tool({
          description: "Move a lead.",
          inputSchema: z.object({ lead_id: z.string() }),
          execute,
        }),
      },
      maxSteps: 2,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(resumed.text).toBe("The lead is now in the requested stage.");
    expect(
      resumed.runtimeMessages.some((message) => message.role === "tool" && message.toolCallId === "call-1"),
    ).toBe(true);
    expect(
      resumed.runtimeMessages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("CRM Harness observation: the move succeeded."),
      ),
    ).toBe(true);
  });

  it("preserves structured tool errors and termination hints across the compatibility seam", async () => {
    const execute = vi.fn(async () => ({
      content: "provider rejected the CRM update",
      details: { code: "crm_update_rejected" },
      isError: true,
      terminate: true,
    }));
    const result = await runPiAiSdkCall({
      system: "Use the CRM update tool.",
      messages: [{ role: "user", content: "update the lead" }],
      model,
      runtime: runtimeWithFaux([
        fauxAssistantMessage(fauxToolCall("update_lead", { id: "lead-1" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("must not continue"),
      ]),
      tools: {
        update_lead: tool({
          description: "Update a lead.",
          inputSchema: z.object({ id: z.string() }),
          execute,
        }),
      },
      maxSteps: 4,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result.text).toBe("");
    expect(result.response.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: [
            expect.objectContaining({
              type: "tool-result",
              output: { type: "text", value: "provider rejected the CRM update" },
            }),
          ],
        }),
      ]),
    );
  });
});
