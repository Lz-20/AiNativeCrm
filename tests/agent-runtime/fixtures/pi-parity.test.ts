import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

import type {
  AgentRuntime,
  RuntimeMessage,
  RuntimeTool,
} from "@/lib/agent-runtime/types";
import { runPiAiSdkCall } from "@/lib/agent-runtime/pi/ai-sdk-compat";
import { PiAgentRuntime } from "@/lib/agent-runtime/pi/runtime";
import { PI_PARITY_FIXTURES } from "./parity-cases";

const model = {
  provider: "crm-parity-provider",
  model: "crm-parity-model",
  apiKey: "fixture-key",
};

function runtimeWithFaux(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
): AgentRuntime {
  const faux = fauxProvider({
    provider: model.provider,
    models: [{ id: model.model }],
  });
  faux.setResponses(responses);
  return new PiAgentRuntime(() => ({
    model: faux.getModel() as never,
    streamFn: faux.provider.streamSimple.bind(faux.provider) as never,
  }));
}

function runtimeTool(
  name: string,
  capability: RuntimeTool["capability"],
  execute: RuntimeTool["execute"],
): RuntimeTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    capability,
    execute,
  };
}

async function run(
  runtime: AgentRuntime,
  options: Partial<Omit<Parameters<AgentRuntime["run"]>[0], "model">> = {},
) {
  return runtime.run({
    systemPrompt: "You are a CRM assistant.",
    prompt: "continue the CRM turn",
    model,
    maxTurns: 4,
    ...options,
  });
}

describe("Pi CRM parity fixtures", () => {
  it("matches every frozen pre-Pi business outcome", () => {
    expect(PI_PARITY_FIXTURES).toHaveLength(13);
    for (const fixture of PI_PARITY_FIXTURES) {
      expect(fixture.piBusinessOutcome, fixture.id).toBe(fixture.legacyBusinessOutcome);
    }
  });

  it("keeps simple QA and sales qualification outcomes deterministic", async () => {
    const qa = await run(runtimeWithFaux([fauxAssistantMessage("The answer is ready.")]));
    const qualify = vi.fn(async () => ({ content: "lead qualified", details: { score: 82 } }));
    const sales = await run(
      runtimeWithFaux([
        fauxAssistantMessage(fauxToolCall("qualify_lead", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("Lead qualified."),
      ]),
      {
        tools: [runtimeTool("qualify_lead", "read", qualify)],
      },
    );

    expect(qa.finalText).toBe("The answer is ready.");
    expect(qualify).toHaveBeenCalledOnce();
    expect(sales.finalText).toBe("Lead qualified.");
  });

  it("preserves RAG, lead context, and skill tool turns", async () => {
    const search = vi.fn(async () => ({ content: "policy article" }));
    const applySkill = vi.fn(async () => ({ content: "qualification skill loaded" }));
    const transformed: RuntimeMessage[][] = [];
    const result = await run(
      runtimeWithFaux([
        fauxAssistantMessage(
          [fauxToolCall("search_knowledge", {}), fauxToolCall("apply_skill", {})],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("The policy allows a qualified response."),
      ]),
      {
        messages: [{ role: "user", content: "previous lead context" }],
        tools: [
          runtimeTool("search_knowledge", "read", search),
          runtimeTool("apply_skill", "read", applySkill),
        ],
        transformContext: async (messages) => {
          transformed.push(messages);
          return messages;
        },
      },
    );

    expect(search).toHaveBeenCalledOnce();
    expect(applySkill).toHaveBeenCalledOnce();
    expect(transformed[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "previous lead context" })]),
    );
    expect(result.finalText).toContain("qualified response");
  });

  it("supports CRM updates and multi-tool batches without losing lifecycle events", async () => {
    const update = vi.fn(async () => ({ content: "updated" }));
    const handoff = vi.fn(async () => ({ content: "handed off" }));
    const result = await run(
      runtimeWithFaux([
        fauxAssistantMessage(
          [fauxToolCall("update_lead", {}), fauxToolCall("handoff_case", {})],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("CRM state updated and handed off."),
      ]),
      {
        tools: [
          runtimeTool("update_lead", "write", update),
          runtimeTool("handoff_case", "handoff", handoff),
        ],
        toolExecution: "sequential",
      },
    );

    expect(update).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledOnce();
    expect(result.events.filter((event) => event.type === "tool_execution_end")).toHaveLength(2);
    expect(result.finalText).toContain("handed off");
  });

  it("keeps follow-up scheduling inside the CRM tool boundary", async () => {
    const schedule = vi.fn(async () => ({
      content: "follow-up scheduled",
      details: { delayHours: 24 },
    }));
    const result = await run(
      runtimeWithFaux([
        fauxAssistantMessage(fauxToolCall("schedule_followup", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("I will follow up tomorrow."),
      ]),
      { tools: [runtimeTool("schedule_followup", "write", schedule)] },
    );

    expect(schedule).toHaveBeenCalledOnce();
    expect(result.finalText).toBe("I will follow up tomorrow.");
  });

  it("handles long context through the CRM transform hook and stops after policy", async () => {
    const stop = vi.fn(async () => true);
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: "user" as const,
      content: `history-${index}`,
    }));
    const transform = vi.fn(async (messages: RuntimeMessage[]) => messages.slice(-2));
    const result = await run(
      runtimeWithFaux([fauxAssistantMessage("bounded answer")]),
      {
        messages: history,
        transformContext: transform,
        shouldStopAfterTurn: stop,
      },
    );

    expect(transform).toHaveBeenCalledWith(expect.any(Array), expect.anything());
    expect(transform.mock.calls[0]?.[0]).toEqual(expect.arrayContaining(history));
    expect(stop).toHaveBeenCalledOnce();
    expect(result.finalText).toBe("bounded answer");
  });

  it("returns tool errors to the model without turning them into runtime crashes", async () => {
    const failingTool = vi.fn(async () => {
      throw new Error("CRM write rejected");
    });
    const result = await run(
      runtimeWithFaux([
        fauxAssistantMessage(fauxToolCall("update_lead", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("I could not update the lead."),
      ]),
      { tools: [runtimeTool("update_lead", "write", failingTool)] },
    );

    expect(failingTool).toHaveBeenCalledOnce();
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", isError: true, content: expect.any(Array) }),
      ]),
    );
    expect(result.finalText).toBe("I could not update the lead.");
  });

  it("blocks handoff and budget-sensitive mutations in shadow/evaluation paths", async () => {
    const handoff = vi.fn(async () => ({ content: "must not run" }));
    const result = await runPiAiSdkCall({
      system: "Never mutate during evaluation.",
      messages: [{ role: "user", content: "hand off the case" }],
      model,
      runtime: runtimeWithFaux([
        fauxAssistantMessage(fauxToolCall("handoff_case", {}), { stopReason: "toolUse" }),
      ]),
      tools: {
        handoff_case: tool({
          description: "Hand off a case.",
          inputSchema: z.object({}),
          execute: handoff,
        }),
      },
      evaluation: true,
      maxSteps: 4,
    });

    expect(handoff).not.toHaveBeenCalled();
    expect(result.text).toBe("");
  });

  it("blocks a CRM mutation when the budget gate rejects the turn", async () => {
    const update = vi.fn(async () => ({ content: "must not run" }));
    const result = await run(
      runtimeWithFaux([
        fauxAssistantMessage(fauxToolCall("update_lead", {}), { stopReason: "toolUse" }),
      ]),
      {
        tools: [runtimeTool("update_lead", "write", update)],
        beforeToolCall: async () => ({
          block: true,
          terminate: true,
          reason: "llm_budget_exceeded",
        }),
      },
    );

    expect(update).not.toHaveBeenCalled();
    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          isError: true,
          content: [{ type: "text", text: "llm_budget_exceeded" }],
        }),
      ]),
    );
  });

  it("surfaces provider errors before any CRM tool can run", async () => {
    const provider = new PiAgentRuntime(() => Promise.reject(new Error("provider unavailable")));

    await expect(run(provider)).rejects.toThrow("provider unavailable");
  });
});
