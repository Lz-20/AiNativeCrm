import { ModelCallError } from "@/lib/agent-runtime/errors";

export interface EffectiveAgentModelBinding {
  bindingMode: "organization_default" | "pinned";
  source: "organization_default" | "version";
  provider: string;
  model: string;
  credentialId: string | null;
}

/** The same projection for channel turns, previews, Workbench and the editor. */
export function resolveEffectiveAgentModelBinding(input: {
  mode?: string | null;
  provider: string;
  model: string;
  credentialId: string | null;
  organizationLlm?: { provider?: unknown; default_model?: unknown } | null;
}): EffectiveAgentModelBinding {
  if (input.mode != null && input.mode !== "organization_default" && input.mode !== "pinned")
    throw new ModelCallError("model_binding_unavailable", "binding");
  if (input.mode === "organization_default") {
    const provider = input.organizationLlm?.provider;
    const model = input.organizationLlm?.default_model;
    if (
      typeof provider !== "string" ||
      !provider.trim() ||
      typeof model !== "string" ||
      !model.trim()
    )
      throw new ModelCallError("model_binding_unavailable", "binding");
    return {
      bindingMode: "organization_default",
      source: "organization_default",
      provider,
      model,
      credentialId: null,
    };
  }
  if (!input.provider?.trim() || !input.model?.trim())
    throw new ModelCallError("model_binding_unavailable", "binding");
  return {
    bindingMode: "pinned",
    source: "version",
    provider: input.provider,
    model: input.model,
    credentialId: input.credentialId,
  };
}

export interface AgentBindingSummary {
  bindingMode: EffectiveAgentModelBinding["bindingMode"];
  source: EffectiveAgentModelBinding["source"];
  provider: string;
  model: string;
  credentialStatus: "matched" | "platform" | "unavailable" | "mismatch" | "ambiguous";
  errorCode?: string;
}
