import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type * as AnthropicProviderModule from "@earendil-works/pi-ai/providers/anthropic";
import type * as DeepseekProviderModule from "@earendil-works/pi-ai/providers/deepseek";
import type * as GoogleProviderModule from "@earendil-works/pi-ai/providers/google";
import type * as OpenaiProviderModule from "@earendil-works/pi-ai/providers/openai";
import type * as OpenrouterProviderModule from "@earendil-works/pi-ai/providers/openrouter";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { allowlistedFetch, buildAllowlist } from "../../agent-engine/edge/egress";
import { importNativeEsm, isTsxWorker } from "./native-import";
import type { RuntimeModelBinding } from "../types";

type PiProvider = {
  getModels(): readonly Model<Api>[];
  streamSimple(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream;
};

function loadProvider<T>(specifier: string, bundled: () => Promise<T>): Promise<T> {
  return isTsxWorker() ? importNativeEsm<T>(specifier) : bundled();
}

export interface ResolvedPiModel {
  model: Model<Api>;
  streamFn: StreamFn;
}

const DEFAULT_BASE_URL: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: "https://openrouter.ai/api/v1",
  opencode: "https://opencode.ai/zen/v1",
  deepseek: "https://api.deepseek.com",
};

const DEFAULT_API: Record<string, Api> = {
  anthropic: "anthropic-messages",
  openai: "openai-responses",
  google: "google-generative-ai",
  openrouter: "openai-completions",
  opencode: "openai-completions",
  deepseek: "openai-completions",
};

async function providerFor(id: string): Promise<PiProvider> {
  switch (id) {
    case "anthropic":
      return (
        await loadProvider<typeof AnthropicProviderModule>(
          "@earendil-works/pi-ai/providers/anthropic",
          () => import("@earendil-works/pi-ai/providers/anthropic"),
        )
      ).anthropicProvider() as PiProvider;
    case "openai":
      return (
        await loadProvider<typeof OpenaiProviderModule>(
          "@earendil-works/pi-ai/providers/openai",
          () => import("@earendil-works/pi-ai/providers/openai"),
        )
      ).openaiProvider() as PiProvider;
    case "google":
      return (
        await loadProvider<typeof GoogleProviderModule>(
          "@earendil-works/pi-ai/providers/google",
          () => import("@earendil-works/pi-ai/providers/google"),
        )
      ).googleProvider() as PiProvider;
    case "openrouter":
    case "opencode":
      return (
        await loadProvider<typeof OpenrouterProviderModule>(
          "@earendil-works/pi-ai/providers/openrouter",
          () => import("@earendil-works/pi-ai/providers/openrouter"),
        )
      ).openrouterProvider() as PiProvider;
    case "deepseek":
      return (
        await loadProvider<typeof DeepseekProviderModule>(
          "@earendil-works/pi-ai/providers/deepseek",
          () => import("@earendil-works/pi-ai/providers/deepseek"),
        )
      ).deepseekProvider() as PiProvider;
    default:
      throw new Error(`Pi provider not supported by the CRM adapter: ${id}`);
  }
}

function modelFor(provider: PiProvider, binding: RuntimeModelBinding): Model<Api> {
  const catalogModel = provider.getModels().find((entry) => entry.id === binding.model);
  const template = catalogModel ?? provider.getModels()[0];
  if (template !== undefined) {
    return {
      ...template,
      id: binding.model,
      name: binding.model,
      // Unknown models may use the provider's first catalog entry as a shape
      // template. Never inherit that entry's provider/API metadata: the first
      // OpenRouter entry can be an Anthropic model, while the binding still
      // must execute through OpenRouter's OpenAI-compatible API.
      api: DEFAULT_API[binding.provider] ?? template.api,
      provider: binding.provider,
      // Keep provider defaults untouched when no CRM reasoning knob is set.
      // When the knob is explicit, mark the model as reasoning-capable so Pi's
      // provider adapter can encode even an explicit `off` decision.
      reasoning: binding.reasoning !== undefined,
      baseUrl:
        binding.baseUrl ??
        (binding.provider === "openrouter"
          ? process.env.OPENROUTER_BASE_URL?.trim() || undefined
          : undefined) ??
        (catalogModel === undefined ? DEFAULT_BASE_URL[binding.provider] : template.baseUrl) ??
        "",
    };
  }

  return {
    id: binding.model,
    name: binding.model,
    api: DEFAULT_API[binding.provider] ?? "openai-completions",
    provider: binding.provider,
    baseUrl:
      binding.baseUrl ??
      (binding.provider === "openrouter"
        ? process.env.OPENROUTER_BASE_URL?.trim() || undefined
        : undefined) ??
      DEFAULT_BASE_URL[binding.provider] ??
      "",
    reasoning: binding.reasoning !== undefined,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: binding.maxOutputTokens ?? 8_192,
  };
}

export async function resolvePiModel(binding: RuntimeModelBinding): Promise<ResolvedPiModel> {
  const provider = await providerFor(binding.provider);
  const model = modelFor(provider, binding);
  const allowlist = buildAllowlist([model.baseUrl]);
  const containedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" || input instanceof URL ? input : input.url;
    return allowlistedFetch(target, init, { allowlist });
  };

  const streamFn: StreamFn = (requestedModel, context, options) =>
    provider.streamSimple(requestedModel, context, {
      ...options,
      apiKey: binding.apiKey,
      fetch: containedFetch,
      ...(binding.headers !== undefined ? { headers: binding.headers } : {}),
      ...(binding.maxOutputTokens !== undefined ? { maxTokens: binding.maxOutputTokens } : {}),
      ...(binding.temperature !== undefined ? { temperature: binding.temperature } : {}),
      ...(binding.topP !== undefined || binding.topK !== undefined
        ? {
            samplingParams: {
              ...(binding.topP !== undefined ? { top_p: binding.topP } : {}),
              ...(binding.topK !== undefined ? { top_k: binding.topK } : {}),
            },
          }
        : {}),
    });

  return { model, streamFn };
}
