import type pg from "pg";
import { ModelCallError } from "@/lib/agent-runtime/errors";
import type { AgentBindingSummary } from "@/lib/ai/agents/model-binding";
import { loadAgentVersionConfig } from "./agent-config";
import { selectLlmCredential } from "../edge/llm/credential-selection";
import type { LlmEdgeConfig } from "../edge/llm/credentials";

/** Read-only metadata; never decrypts, validates by HTTP, or calls a model. */
export async function readAgentModelBinding(
  pool: pg.Pool,
  org: string,
  agentId: string,
  versionId: string,
  cfg: LlmEdgeConfig,
): Promise<AgentBindingSummary | null> {
  const agent = await loadAgentVersionConfig(pool, org, agentId, versionId);
  if (!agent) return null;
  const bindingMode = agent.modelBindingMode ?? "pinned";
  const base = {
    bindingMode,
    source:
      bindingMode === "organization_default"
        ? ("organization_default" as const)
        : ("version" as const),
    provider: agent.provider,
    model: agent.model,
  };
  try {
    const row = await selectLlmCredential(pool, org, agent.provider, agent.credentialId, false);
    const platform = {
      anthropic: cfg.anthropicApiKey,
      openai: cfg.openaiApiKey,
      google: cfg.googleApiKey,
      openrouter: cfg.openrouterApiKey,
      deepseek: cfg.deepseekApiKey,
    };
    const hasPlatform = Boolean(platform[agent.provider as keyof typeof platform]);
    return {
      ...base,
      credentialStatus: row ? "matched" : hasPlatform ? "platform" : "unavailable",
    };
  } catch (error) {
    if (!(error instanceof ModelCallError)) throw error;
    return {
      ...base,
      credentialStatus:
        error.code === "credential_provider_mismatch"
          ? "mismatch"
          : error.code === "credential_ambiguous"
            ? "ambiguous"
            : "unavailable",
      errorCode: error.code,
    };
  }
}
