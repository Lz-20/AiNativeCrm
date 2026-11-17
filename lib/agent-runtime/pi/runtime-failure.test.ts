import { describe, it, expect, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { PiAgentRuntime } from "./runtime";
import { resolvePiModel } from "./model-adapter";
import { runPiAiSdkCall } from "./ai-sdk-compat";
import { allowlistedFetch } from "@/lib/agent-engine/edge/egress";

vi.mock("@/lib/agent-engine/edge/egress", () => ({
  allowlistedFetch: vi.fn(),
  buildAllowlist: () => new Set(["api.deepseek.com"]),
}));
const binding = { provider: "deepseek", model: "deepseek-flash", apiKey: "synthetic-credential" };
function faux(content: string, stopReason: "stop" | "error" | "aborted" | "pending" = "stop") {
  const provider = fauxProvider({ models: [{ id: "synthetic" }] });
  provider.setResponses([
    fauxAssistantMessage(content, {
      stopReason,
      errorMessage: "private-customer-content Authorization: sensitive-value",
    }),
  ]);
  return new PiAgentRuntime(() => ({
    model: provider.getModel(),
    streamFn: provider.provider.streamSimple.bind(provider.provider) as never,
  }));
}
const input = { systemPrompt: "synthetic", prompt: "synthetic", model: binding };

describe("Pi failure boundary (real Pi, controlled providers; no network)", () => {
  it("returns a valid assistant completion", async () => {
    expect((await faux("valid completion").run(input)).finalText).toBe("valid completion");
  });
  it.each([
    ["error", "model_failed"],
    ["aborted", "model_aborted"],
  ] as const)("rejects stopReason=%s with a safe classification", async (reason, code) => {
    const error = await faux("", reason)
      .run(input)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toMatch(/private-customer|Authorization|sensitive-value/);
    if (reason === "aborted") expect(error).toHaveProperty("name", "AbortError");
  });
  it("rejects an empty assistant completion", async () => {
    await expect(faux(" ").run(input)).rejects.toMatchObject({ code: "model_empty_response" });
  });
  it.each([
    [401, "model_http_401"],
    [429, "model_http_429"],
    [500, "model_http_5xx"],
  ] as const)("preserves safe HTTP %s metadata, without reading its body", async (status, code) => {
    vi.mocked(allowlistedFetch).mockResolvedValueOnce(
      new Response("private-customer-content", { status }),
    );
    const runtime = new PiAgentRuntime(resolvePiModel);
    await expect(runtime.run(input)).rejects.toMatchObject({ code, httpStatus: status });
  });
  it("classifies network errors without retaining their text", async () => {
    vi.mocked(allowlistedFetch).mockRejectedValueOnce(new TypeError("private-customer-content"));
    await expect(new PiAgentRuntime(resolvePiModel).run(input)).rejects.toMatchObject({
      code: "model_network_error",
    });
  });
  it("rejects a malformed/truncated model stream rather than accepting its empty text", async () => {
    vi.mocked(allowlistedFetch).mockResolvedValueOnce(
      new Response("data: {invalid}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    await expect(new PiAgentRuntime(resolvePiModel).run(input)).rejects.toMatchObject({
      code: "model_failed",
    });
  });
  it("does not emit a successful tool event or execute tools after a failed model response", async () => {
    const tool = vi.fn(async () => ({ content: "synthetic" }));
    const onEvent = vi.fn();
    await expect(
      faux("", "error").run({
        ...input,
        onEvent,
        tools: [
          {
            name: "crm_read",
            description: "synthetic",
            inputSchema: { type: "object" },
            capability: "read",
            execute: tool,
          },
        ],
      }),
    ).rejects.toThrow("model_failed");
    expect(tool).not.toHaveBeenCalled();
    expect(onEvent.mock.calls.some(([event]) => event.type === "tool_execution_end")).toBe(false);
  });
  it("defensively rejects an error assistant returned by an injected runtime", async () => {
    const runtime = {
      run: vi.fn(async () => ({
        messages: [
          { role: "assistant", content: "", privateContinuation: { stopReason: "error" } },
        ],
        finalText: "",
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
        },
        events: [],
        toolCalls: [],
      })),
    };
    await expect(
      runPiAiSdkCall({ system: "", messages: [], model: binding, runtime: runtime as never }),
    ).rejects.toMatchObject({ code: "model_failed" });
  });
});
