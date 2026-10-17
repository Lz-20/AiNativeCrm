import { describe, expect, it } from "vitest";

import { resolvePiModel } from "./model-adapter";

describe("Pi model adapter", () => {
  it.each([
    ["anthropic", "anthropic-messages", "https://api.anthropic.com"],
    ["openai", "openai-responses", "https://api.openai.com/v1"],
    ["google", "google-generative-ai", "https://generativelanguage.googleapis.com/v1beta"],
    ["openrouter", "openai-completions", "https://openrouter.ai/api/v1"],
    ["opencode", "openai-completions", "https://opencode.ai/zen/v1"],
    ["deepseek", "openai-completions", "https://api.deepseek.com"],
  ] as const)(
    "binds %s through Pi with its canonical API and endpoint",
    async (provider, api, baseUrl) => {
      const resolved = await resolvePiModel({
        provider,
        model: "crm-test-model",
        apiKey: "test-key",
      });

      expect(resolved.model).toMatchObject({
        id: "crm-test-model",
        provider,
        api,
        baseUrl,
      });
      expect(resolved.streamFn).toEqual(expect.any(Function));
    },
  );

  it("honors tenant-selected endpoint and request controls in the Pi binding", async () => {
    const resolved = await resolvePiModel({
      provider: "openrouter",
      model: "tenant/model",
      apiKey: "tenant-key",
      baseUrl: "https://gateway.example.test/v1",
      headers: { "X-Tenant": "org-a" },
      maxOutputTokens: 321,
      temperature: 0.2,
      topP: 0.8,
    });

    expect(resolved.model).toMatchObject({
      id: "tenant/model",
      baseUrl: "https://gateway.example.test/v1",
    });
    expect(resolved.streamFn).toEqual(expect.any(Function));
  });

  it("rejects unsupported providers before any provider request", async () => {
    await expect(
      resolvePiModel({ provider: "unsupported", model: "m", apiKey: "k" }),
    ).rejects.toThrow("Pi provider not supported by the CRM adapter");
  });
});
