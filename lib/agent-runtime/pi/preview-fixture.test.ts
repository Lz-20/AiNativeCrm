import { describe, expect, it, vi } from "vitest";

import { createPreviewAgentRuntime } from "./preview-fixture";

const model = {
  provider: "crm-preview-provider",
  model: "crm-preview-model",
  apiKey: "fixture-key",
};

describe("Pi preview fixture", () => {
  it("returns deterministic non-tool output through the Pi runtime", async () => {
    const runtime = createPreviewAgentRuntime("INTERNAL_CASE_MARKER");

    const result = await runtime.run({
      systemPrompt: "system",
      prompt: "INTERNAL_CASE_MARKER",
      model,
      maxTurns: 2,
    });

    expect(result.finalText).toContain("desconto acima da política");
  });

  it("continues through the same deterministic tool sequence as the QA stub", async () => {
    const runtime = createPreviewAgentRuntime("unused");
    const search = vi.fn(async () => ({ content: "knowledge result" }));
    const send = vi.fn(async () => ({ content: "sent" }));

    const result = await runtime.run({
      systemPrompt: "system",
      prompt: "answer with knowledge",
      model,
      tools: [
        {
          name: "search_knowledge",
          description: "Search knowledge.",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
          capability: "read",
          execute: search,
        },
        {
          name: "send_message",
          description: "Send a message.",
          inputSchema: { type: "object", properties: { body: { type: "string" } } },
          capability: "send",
          execute: send,
        },
      ],
      maxTurns: 4,
    });

    expect(search).toHaveBeenCalledWith(
      { query: "informações de atendimento" },
      expect.objectContaining({ toolCallId: expect.any(String) }),
    );
    expect(send).toHaveBeenCalledWith(
      { body: expect.stringContaining("Posso ajudar") },
      expect.objectContaining({ toolCallId: expect.any(String) }),
    );
    expect(result.finalText).toBe("Sugestão registrada.");
  });
});
