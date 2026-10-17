import type { RuntimeObservation } from "../types";
import { describe, expect, it, vi } from "vitest";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

import { PiAgentRuntime } from "./runtime";

function runtimeWithFaux(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
) {
  const faux = fauxProvider({
    provider: "crm-test-provider",
    models: [{ id: "crm-test-model" }],
  });
  faux.setResponses(responses);
  const runtime = new PiAgentRuntime(() => ({
    model: faux.getModel() as never,
    streamFn: faux.provider.streamSimple.bind(faux.provider) as never,
  }));
  return { runtime, faux };
}

const model = {
  provider: "crm-test-provider",
  model: "crm-test-model",
  apiKey: "test-key",
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PiAgentRuntime", () => {
  it.skipIf(!process.env.OPENCODE_ZEN_TEST_KEY)(
    "uses OpenCode Zen through Pi Agent Core with a CRM-tool fixture",
    async () => {
      const apiKey = process.env.OPENCODE_ZEN_TEST_KEY;
      if (!apiKey) throw new Error("opencode_zen_test_key_missing");

      let crmReadCount = 0;
      const eventTypes: string[] = [];
      const runtime = new PiAgentRuntime();
      const result = await runtime.run({
        systemPrompt:
          "You are a CRM assistant. For contact facts, you must call crm_search_contacts before answering. Never invent tool results.",
        prompt:
          "请先调用 crm_search_contacts 按姓名精确查找‘林晓梅’，再根据工具返回回答她的商机阶段。",
        model: {
          provider: "opencode",
          model: "space-bunny-free",
          apiKey,
          temperature: 0,
        },
        tools: [
          {
            name: "crm_search_contacts",
            description: "按姓名搜索 CRM 联系人并返回关联商机事实。",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
            capability: "read",
            execute: async ({ name }) => {
              crmReadCount += 1;
              if (name !== "林晓梅") return { content: "没有找到联系人。" };
              return {
                content: "联系人：林晓梅；关联商机阶段：需求确认。",
                details: { source: "crm-test-fixture", contactName: name, leadStage: "需求确认" },
              };
            },
          },
        ],
        maxTurns: 4,
        abortSignal: AbortSignal.timeout(60_000),
        onEvent: (event) => {
          eventTypes.push(event.type);
        },
      });

      expect(crmReadCount, `runtime events: ${eventTypes.join(",")}`).toBe(1);
      expect(result.toolCalls).toEqual([
        expect.objectContaining({
          name: "crm_search_contacts",
          arguments: { name: "林晓梅" },
        }),
      ]);
      expect(result.events.some((event) => event.type === "tool_execution_start")).toBe(true);
      expect(result.events.some((event) => event.type === "tool_execution_end")).toBe(true);
      expect(result.finalText).toContain("需求确认");
    },
    90_000,
  );

  it("observes real model/tool boundaries without exporting private contents", async () => {
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("lookup", { secret: "ARG_CANARY" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("OUTPUT_CANARY"),
    ]);
    const observations: RuntimeObservation[] = [];
    await runtime.run({
      systemPrompt: "SYSTEM_CANARY",
      prompt: "USER_CANARY",
      model,
      maxTurns: 3,
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          inputSchema: { type: "object", properties: { secret: { type: "string" } } },
          capability: "read",
          execute: async () => ({ content: "TOOL_CANARY" }),
        },
      ],
      onObservation: (observation) => {
        observations.push(observation);
      },
    });
    expect(observations.map((observation) => observation.kind).sort()).toEqual([
      "generation",
      "generation",
      "tool",
    ]);
    expect(observations.every((observation) => observation.endedAt >= observation.startedAt)).toBe(
      true,
    );
    expect(JSON.stringify(observations)).not.toContain("CANARY");
    expect(
      observations
        .filter((observation) => observation.kind === "generation")
        .every((observation) => observation.usage !== undefined),
    ).toBe(true);
  });

  it("isolates rejected, throwing and never-settling optional observers", async () => {
    for (const observer of [
      () => {
        throw new Error("sink unavailable");
      },
      async () => {
        throw new Error("enqueue failed");
      },
      () => new Promise<void>(() => {}),
    ]) {
      const { runtime } = runtimeWithFaux([fauxAssistantMessage("finished")]);
      const result = await runtime.run({
        systemPrompt: "system",
        prompt: "hello",
        model,
        onObservation: observer,
      });
      expect(result.finalText).toBe("finished");
    }
  }, 5000);

  it("runs a basic turn through Pi Agent Core and exposes lifecycle events", async () => {
    const { runtime } = runtimeWithFaux([fauxAssistantMessage("ok")]);

    const result = await runtime.run({
      systemPrompt: "You are a CRM assistant.",
      prompt: "hello",
      model,
    });

    expect(result.finalText).toBe("ok");
    expect(result.events[0]?.type).toBe("agent_start");
    expect(result.events[1]?.type).toBe("turn_start");
    expect(result.events.at(-2)?.type).toBe("turn_end");
    expect(result.events.at(-2)?.data.stop_reason).toBe("stop");
    expect(result.events.at(-1)?.type).toBe("agent_end");
    expect(result.events.filter((event) => event.type === "message_update").length).toBeGreaterThan(
      0,
    );
  });

  it("proves a direction reached the final model context without logging its text", async () => {
    const direction = JSON.stringify("先按新的报价依据核对");
    const contextProbe = { id: "manager-direction:mission-1:2", userText: direction };
    const { runtime } = runtimeWithFaux([fauxAssistantMessage("已核对")]);
    const result = await runtime.run({ systemPrompt: "CRM", prompt: `负责人方向：${direction}`,
      model, contextProbe });
    expect(result.events.filter((event) => event.type === "model_context_consumed"))
      .toEqual([{ type: "model_context_consumed", data: { probeId: contextProbe.id } }]);
    expect(JSON.stringify(result.events)).not.toContain(direction);
  });

  it("does not claim direction consumption after context filtering or a failed turn", async () => {
    const direction = JSON.stringify("先按新的报价依据核对");
    const contextProbe = { id: "manager-direction:mission-1:2", userText: direction };
    const filtered = runtimeWithFaux([fauxAssistantMessage("没有新方向")]);
    const filteredResult = await filtered.runtime.run({ systemPrompt: "CRM",
      prompt: `负责人方向：${direction}`, model, contextProbe,
      transformContext: (messages) => messages.filter((message) =>
        message.role !== "user" || !(typeof message.content === "string"
          ? message.content.includes(direction)
          : message.content.some((part) => part.type === "text" && part.text.includes(direction)))),
    });
    expect(filteredResult.events.some((event) => event.type === "model_context_consumed"))
      .toBe(false);
    const failed = runtimeWithFaux([fauxAssistantMessage("", { stopReason: "error" })]);
    const failedResult = await failed.runtime.run({ systemPrompt: "CRM",
      prompt: `负责人方向：${direction}`, model, contextProbe });
    expect(failedResult.events.some((event) => event.type === "model_context_consumed"))
      .toBe(false);
  });

  it("keeps private reasoning out of the answer while preserving provider continuation", async () => {
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage([
        { type: "thinking", thinking: "private planning text", thinkingSignature: "signed-thought" },
        { type: "text", text: "visible result" },
      ], { responseId: "response-1" }),
      (context) => {
        const previous = context.messages.find((message) => message.role === "assistant");
        expect(previous?.content).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "thinking", thinkingSignature: "signed-thought" }),
        ]));
        expect(previous).toEqual(expect.objectContaining({ responseId: "response-1" }));
        return fauxAssistantMessage("continued result");
      },
    ]);
    const first = await runtime.run({ systemPrompt: "CRM", prompt: "start", model });
    expect(first.finalText).toBe("visible result");
    const publicMessage = first.messages.find((message) => message.role === "assistant");
    expect(publicMessage?.content).toBe("visible result");
    const restored = JSON.parse(JSON.stringify(first.messages));
    const second = await runtime.run({
      systemPrompt: "CRM",
      messages: restored,
      prompt: "continue",
      model,
    });
    expect(second.finalText).toBe("continued result");
  });

  it("refreshes the explicit system baseline after JSON restore while preserving history and current tools", async () => {
    const observedPrompts: string[] = [];
    const observedTools: string[][] = [];
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage([
        { type: "thinking", thinking: "private planning", thinkingSignature: "signed-history" },
        fauxToolCall("lookup_old", { id: "lead-1" }),
      ], { stopReason: "toolUse", responseId: "old-response" }),
      fauxAssistantMessage("Prior verified finding."),
      (context) => {
        observedPrompts.push(getCurrentSystemPrompt(context.messages));
        observedTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
        expect(getCurrentTools(context.messages)).toEqual([
          expect.objectContaining({ name: "lookup_current", description: "Current allowed lookup",
            parameters: { type: "object", properties: { confirmed: { type: "boolean" } }, required: ["confirmed"] } }),
        ]);
        const priorAssistant = context.messages.find((message) =>
          message.role === "assistant" && message.responseId === "old-response");
        expect(priorAssistant?.content).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "thinking", thinkingSignature: "signed-history" }),
        ]));
        expect(context.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: "user", content: [{ type: "text", text: "Original task" }] }),
          expect.objectContaining({ role: "toolResult", toolName: "lookup_old",
            content: [{ type: "text", text: "Persisted CRM fact" }] }),
        ]));
        return fauxAssistantMessage(fauxToolCall("lookup_current", { confirmed: true }), { stopReason: "toolUse" });
      },
      (context) => {
        observedPrompts.push(getCurrentSystemPrompt(context.messages));
        return fauxAssistantMessage("Current policy applied.");
      },
      (context) => {
        observedPrompts.push(getCurrentSystemPrompt(context.messages));
        return fauxAssistantMessage("Newest policy applied.");
      },
    ]);
    const first = await runtime.run({
      systemPrompt: "OLD_MEMORY_v1", prompt: "Original task", model, maxTurns: 2,
      tools: [{ name: "lookup_old", description: "Old allowed lookup", capability: "read",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        execute: async () => ({ content: "Persisted CRM fact" }) }],
    });
    const restored = JSON.parse(JSON.stringify(first.messages));
    const before = JSON.stringify(restored);
    const execute = vi.fn(async () => ({ content: "Current CRM fact" }));
    const resumed = await runtime.run({
      systemPrompt: "CURRENT_MEMORY_v2", messages: restored, prompt: "Continue", model, maxTurns: 2,
      tools: [{ name: "lookup_current", description: "Current allowed lookup", capability: "read",
        inputSchema: { type: "object", properties: { confirmed: { type: "boolean" } }, required: ["confirmed"] }, execute }],
    });
    expect(observedPrompts).toEqual(["CURRENT_MEMORY_v2", "CURRENT_MEMORY_v2"]);
    expect(observedTools).toEqual([["lookup_current"]]);
    expect(execute).toHaveBeenCalledOnce();
    expect(resumed.finalText).toBe("Current policy applied.");
    expect(resumed.messages[0]).toEqual({ role: "system", content: "CURRENT_MEMORY_v2" });
    expect(JSON.stringify(restored)).toBe(before);
    const resumedAgain = await runtime.run({ systemPrompt: "CURRENT_MEMORY_v3",
      messages: JSON.parse(JSON.stringify(resumed.messages)), prompt: "Continue again", model,
    });
    expect(observedPrompts).toEqual(["CURRENT_MEMORY_v2", "CURRENT_MEMORY_v2", "CURRENT_MEMORY_v3"]);
    expect(resumedAgain.messages.filter((message) => message.role === "system" && message.content))
      .toEqual([{ role: "system", content: "CURRENT_MEMORY_v3" }]);
  });

  it("replaces an old baseline with an empty explicit prompt and preserves supplemental system instructions", async () => {
    let observed = "not called";
    const { runtime } = runtimeWithFaux([(context) => {
      observed = getCurrentSystemPrompt(context.messages);
      return fauxAssistantMessage("done");
    }]);
    await runtime.run({ systemPrompt: "", prompt: "continue", model,
      messages: [
        { role: "system", content: "OLD_MEMORY_v1" },
        { role: "user", content: "Original task" },
        { role: "system", content: "Keep this supplemental instruction" },
      ],
    });
    expect(observed).toBe("Keep this supplemental instruction");
  });

  it("keeps the current baseline on cold starts and histories without a leading system message", async () => {
    const observed: string[] = [];
    const { runtime } = runtimeWithFaux([
      (context) => { observed.push(getCurrentSystemPrompt(context.messages)); return fauxAssistantMessage("cold"); },
      (context) => { observed.push(getCurrentSystemPrompt(context.messages)); return fauxAssistantMessage("legacy"); },
    ]);
    await runtime.run({ systemPrompt: "CURRENT_MEMORY_v2", prompt: "start", model });
    await runtime.run({ systemPrompt: "CURRENT_MEMORY_v2", prompt: "continue", model,
      messages: [{ role: "user", content: "Legacy history" }],
    });
    expect(observed).toEqual(["CURRENT_MEMORY_v2", "CURRENT_MEMORY_v2"]);
  });

  it("executes a tool and continues with its result", async () => {
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("lookup", { id: "lead-1" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    const lookup = vi.fn(async () => ({ content: "lead found", details: { found: true } }));

    const result = await runtime.run({
      systemPrompt: "Use tools when needed.",
      prompt: "find the lead",
      model,
      tools: [
        {
          name: "lookup",
          description: "Look up a lead.",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          capability: "read",
          execute: lookup,
        },
      ],
      maxTurns: 4,
    });

    expect(lookup).toHaveBeenCalledWith(
      { id: "lead-1" },
      expect.objectContaining({ toolCallId: expect.any(String) }),
    );
    expect(result.finalText).toBe("done");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({ name: "lookup", arguments: { id: "lead-1" } }),
    ]);
    expect(result.events.some((event) => event.type === "tool_execution_start")).toBe(true);
    expect(result.events.some((event) => event.type === "tool_execution_end")).toBe(true);
  });

  it("injects a polled manager direction after the current tool batch, once per source ID", async () => {
    const instruction = "负责人新方向：先核对新合同，不沿用旧交期";
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("lookup", { id: "lead-1" }), { stopReason: "toolUse" }),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(instruction);
        return fauxAssistantMessage("已按新合同继续核对");
      },
    ]);
    const lookup = vi.fn(async () => ({ content: "旧交期：下周二" }));
    const poll = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: "direction-1", content: instruction }]);
    const result = await runtime.run({
      systemPrompt: "CRM", prompt: "核对交期", model, maxTurns: 4,
      tools: [{ name: "lookup", description: "查商机", capability: "read",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        execute: lookup }],
      steering: { poll },
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledTimes(3);
    expect(result.finalText).toBe("已按新合同继续核对");
    expect(result.messages.some((message) => message.role === "user" &&
      JSON.stringify(message.content).includes(instruction))).toBe(true);
    const steeringEvents = result.events.filter((event) => event.type === "steering_queued");
    expect(steeringEvents).toEqual([{ type: "steering_queued", data: { steeringId: "direction-1" } }]);
    expect(JSON.stringify(steeringEvents)).not.toContain(instruction);
    expect(result.events.filter((event) => event.type === "steering_consumed"))
      .toEqual([{ type: "steering_consumed", data: { steeringId: "direction-1" } }]);
  });

  it("consumes a durable direction already pending before the first model request", async () => {
    const direction = "先核对负责人刚更新的合同";
    const { runtime } = runtimeWithFaux([(context) => {
      expect(JSON.stringify(context.messages)).toContain(direction);
      return fauxAssistantMessage("已核对新合同");
    }]);
    const result = await runtime.run({ systemPrompt: "CRM", prompt: "核对商机", model,
      maxTurns: 1, steering: { poll: async () => [{ id: "direction-before-start", content: direction }] } });
    expect(result.events.filter((event) => event.type === "steering_consumed"))
      .toEqual([{ type: "steering_consumed", data: { steeringId: "direction-before-start" } }]);
  });

  it("acknowledges only the direction included in a successful model turn", async () => {
    const first = "先核对合同版本一";
    const second = "再核对合同版本二";
    const { runtime } = runtimeWithFaux([(context) => {
      expect(JSON.stringify(context.messages)).toContain(first);
      expect(JSON.stringify(context.messages)).not.toContain(second);
      return fauxAssistantMessage("第一条方向已处理");
    }]);
    const result = await runtime.run({ systemPrompt: "CRM", prompt: "核对商机", model,
      maxTurns: 1, steering: { poll: async () => [
        { id: "direction-first", content: first },
        { id: "direction-second", content: second },
      ] } });
    expect(result.events.filter((event) => event.type === "steering_queued")).toHaveLength(2);
    expect(result.events.filter((event) => event.type === "steering_consumed"))
      .toEqual([{ type: "steering_consumed", data: { steeringId: "direction-first" } }]);
    expect(result.messages.some((message) => message.role === "user" &&
      JSON.stringify(message.content).includes(second))).toBe(false);
  });

  it("does not acknowledge a direction when the model turn fails", async () => {
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage("", { stopReason: "error" }),
    ]);
    const result = await runtime.run({ systemPrompt: "CRM", prompt: "核对商机", model,
      steering: { poll: async () => [{ id: "direction-failed", content: "先核对新合同" }] } });
    expect(result.events.some((event) => event.type === "steering_queued")).toBe(true);
    expect(result.events.some((event) => event.type === "steering_consumed")).toBe(false);
  });

  it("does not acknowledge a direction removed by context transformation", async () => {
    const direction = "负责人要求核对新版交期";
    const { runtime } = runtimeWithFaux([(context) => {
      expect(JSON.stringify(context.messages)).not.toContain(direction);
      return fauxAssistantMessage("缺少新版交期");
    }]);
    const result = await runtime.run({ systemPrompt: "CRM", prompt: "核对商机", model,
      maxTurns: 1,
      steering: { poll: async () => [{ id: "direction-filtered", content: direction }] },
      transformContext: (messages) => messages.filter((message) =>
        message.role !== "user" || !JSON.stringify(message.content).includes(direction)),
    });
    expect(result.events.some((event) => event.type === "steering_queued")).toBe(true);
    expect(result.events.some((event) => event.type === "steering_consumed")).toBe(false);
  });

  it("leaves steering unconsumed when the hard turn limit has been reached", async () => {
    const { runtime } = runtimeWithFaux([fauxAssistantMessage("预算前的结论")]);
    const poll = vi.fn(async () => []);
    const result = await runtime.run({ systemPrompt: "CRM", prompt: "先查商机", model,
      maxTurns: 1, steering: { poll } });
    expect(poll).toHaveBeenCalledOnce();
    expect(result.finalText).toBe("预算前的结论");
    expect(result.events.some((event) => event.type === "steering_queued")).toBe(false);
  });

  it("does not mistake a queued steer for delivery when CRM stop policy ends the turn", async () => {
    const { runtime } = runtimeWithFaux([fauxAssistantMessage("旧结论")]);
    const poll = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "direction-2", content: "改按新合同核对" }]);
    const result = await runtime.run({ systemPrompt: "CRM", prompt: "核对", model,
      maxTurns: 3,
      steering: { poll },
      shouldStopAfterTurn: () => true,
    });
    expect(result.events.some((event) => event.type === "steering_queued")).toBe(true);
    expect(result.events.some((event) => event.type === "steering_consumed")).toBe(false);
    expect(result.messages.some((message) => message.role === "user" &&
      JSON.stringify(message.content).includes("改按新合同核对"))).toBe(false);
    expect(result.finalText).toBe("旧结论");
  });

  it("blocks a tool in beforeToolCall without executing its side effect", async () => {
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("send_message", { body: "hello" }), {
        stopReason: "toolUse",
      }),
    ]);
    const send = vi.fn(async () => ({ content: "sent" }));

    const result = await runtime.run({
      systemPrompt: "Never bypass policy.",
      prompt: "send it",
      model,
      tools: [
        {
          name: "send_message",
          description: "Send a message.",
          inputSchema: { type: "object", properties: { body: { type: "string" } } },
          capability: "send",
          execute: send,
        },
      ],
      beforeToolCall: async () => ({
        block: true,
        reason: "blocked by CRM policy",
        terminate: true,
      }),
      maxTurns: 4,
    });

    expect(send).not.toHaveBeenCalled();
    expect(result.finalText).toBe("");
    expect(result.events.some((event) => event.type === "tool_execution_end")).toBe(true);
  });

  it("honors the CRM post-turn stop policy before requesting another model turn", async () => {
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage("first"),
      fauxAssistantMessage("second"),
    ]);
    const stopPolicy = vi.fn(async (_input: unknown) => true);

    const result = await runtime.run({
      systemPrompt: "Stop after the first completed turn.",
      prompt: "hello",
      model,
      maxTurns: 4,
      shouldStopAfterTurn: async (input) => {
        stopPolicy(input);
        return true;
      },
    });

    expect(stopPolicy).toHaveBeenCalledTimes(1);
    expect(result.finalText).toBe("first");
    expect(result.events.filter((event) => event.type === "turn_end")).toHaveLength(1);
  });

  it("accumulates usage across model turns in one CRM agent run", async () => {
    const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const { runtime } = runtimeWithFaux([
      {
        ...fauxAssistantMessage(fauxToolCall("continue", {}), { stopReason: "toolUse" }),
        usage: usage(10, 3, 1, 0),
      },
      { ...fauxAssistantMessage("second"), usage: usage(20, 5, 2, 4) },
    ]);
    const seenUsage: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> = [];

    const result = await runtime.run({
      systemPrompt: "Continue until the CRM policy stops the run.",
      prompt: "continue",
      model,
      maxTurns: 2,
      tools: [
        {
          name: "continue",
          description: "Continue the scripted run.",
          inputSchema: { type: "object", properties: {} },
          capability: "read",
          execute: async () => ({ content: "continued" }),
        },
      ],
      shouldStopAfterTurn: async ({ usage }) => {
        seenUsage.push(usage);
        return false;
      },
    });

    const perTurnUsage = result.messages.flatMap((message) =>
      message.role === "assistant" && message.usage !== undefined ? [message.usage] : [],
    );
    const expectedUsage = perTurnUsage.reduce(
      (total, current) => ({
        inputTokens: total.inputTokens + current.inputTokens,
        outputTokens: total.outputTokens + current.outputTokens,
        cacheReadTokens: total.cacheReadTokens + current.cacheReadTokens,
        cacheWriteTokens: total.cacheWriteTokens + current.cacheWriteTokens,
        totalTokens: total.totalTokens + current.totalTokens,
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    );

    expect(seenUsage).toHaveLength(2);
    expect(seenUsage.at(-1)).toEqual(expectedUsage);
    expect(result.usage).toEqual(expectedUsage);
    expect(result.usage.outputTokens).toBeGreaterThan(perTurnUsage.at(-1)?.outputTokens ?? 0);
  });

  it.each([
    ["parallel", 2],
    ["sequential", 1],
  ] as const)(
    "executes a multi-tool batch in %s mode",
    async (toolExecution, expectedConcurrency) => {
      const { runtime } = runtimeWithFaux([
        fauxAssistantMessage([fauxToolCall("first", {}), fauxToolCall("second", {})], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("batch complete"),
      ]);
      let active = 0;
      let maximumConcurrency = 0;
      const execute = vi.fn(async () => {
        active += 1;
        maximumConcurrency = Math.max(maximumConcurrency, active);
        await wait(5);
        active -= 1;
        return { content: "ok" };
      });

      const result = await runtime.run({
        systemPrompt: "Use both tools.",
        prompt: "run the batch",
        model,
        toolExecution,
        tools: [
          {
            name: "first",
            description: "First operation.",
            inputSchema: { type: "object", properties: {} },
            capability: "read",
            execute,
          },
          {
            name: "second",
            description: "Second operation.",
            inputSchema: { type: "object", properties: {} },
            capability: "read",
            execute,
          },
        ],
        maxTurns: 4,
      });

      expect(result.finalText).toBe("batch complete");
      expect(execute).toHaveBeenCalledTimes(2);
      expect(maximumConcurrency).toBe(expectedConcurrency);
    },
  );

  it("applies afterToolCall to the tool result before continuation", async () => {
    const { runtime } = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("lookup", { id: "lead-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    const afterToolCall = vi.fn(async () => ({
      content: "policy-normalized result",
      details: { normalized: true },
    }));

    const result = await runtime.run({
      systemPrompt: "Use the lookup tool.",
      prompt: "find the lead",
      model,
      tools: [
        {
          name: "lookup",
          description: "Look up a lead.",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          capability: "read",
          execute: async () => ({ content: "raw result" }),
        },
      ],
      afterToolCall,
      maxTurns: 4,
    });

    expect(afterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: "lookup", args: { id: "lead-1" } }),
    );
    const toolResult = result.messages.find((message) => message.role === "tool");
    expect(toolResult).toMatchObject({ details: { normalized: true } });
    expect(toolResult && typeof toolResult.content === "object" ? toolResult.content : []).toEqual([
      { type: "text", text: "policy-normalized result" },
    ]);
  });

  it("routes CRM history through transformContext before Pi converts it to LLM messages", async () => {
    const { runtime } = runtimeWithFaux([fauxAssistantMessage("ok")]);
    const transformed = vi.fn(async (messages) => messages);

    await runtime.run({
      systemPrompt: "You are a CRM assistant.",
      messages: [{ role: "user", content: "previous CRM context" }],
      prompt: "continue",
      model,
      transformContext: transformed,
    });

    expect(transformed).toHaveBeenCalled();
    expect(transformed.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "previous CRM context" })]),
    );
  });

  it("rejects before opening the provider when the caller is already aborted", async () => {
    const { runtime } = runtimeWithFaux([fauxAssistantMessage("must not run")]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      runtime.run({
        systemPrompt: "system",
        prompt: "cancel",
        model,
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
