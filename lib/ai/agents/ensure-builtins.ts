import { BUILTIN_AGENTS } from "@/lib/ai/agents/builtins";
import { createAdminClient } from "@/lib/supabase/admin";

export interface EnsureBuiltinAgentsResult {
  created: number;
  existing: number;
  agentIds: Record<string, string>;
}

/** Idempotently ensure all canonical built-in agent records exist for a tenant. */
export async function ensureBuiltinAgents(
  organizationId: string,
): Promise<EnsureBuiltinAgentsResult> {
  const admin = createAdminClient();
  const result: EnsureBuiltinAgentsResult = { created: 0, existing: 0, agentIds: {} };
  const { data: organization, error: organizationError } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (organizationError || !organization)
    throw new Error(
      `builtin_agent_org_lookup_failed:${organizationError?.message ?? organizationId}`,
    );
  const llm = (organization.settings as { llm?: unknown } | null)?.llm as
    { provider?: unknown; default_model?: unknown } | undefined;
  const provider = typeof llm?.provider === "string" ? llm.provider.trim() : "";
  const model = typeof llm?.default_model === "string" ? llm.default_model.trim() : "";
  const { data: activeKnowledge, error: knowledgeError } = await admin
    .from("ai_knowledge_sources")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("id", { ascending: true });
  if (knowledgeError)
    throw new Error(`builtin_agent_knowledge_lookup_failed:${knowledgeError.message}`);
  const organizationKnowledgeSourceIds = (activeKnowledge ?? []).map((source) => source.id);

  for (const definition of BUILTIN_AGENTS) {
    const { data: existing, error: readError } = await admin
      .from("ai_agents")
      .select("id, builtin_revision")
      .eq("organization_id", organizationId)
      .eq("builtin_key", definition.key)
      .maybeSingle();
    if (readError) throw new Error(`builtin_agent_lookup_failed:${readError.message}`);

    if (existing) {
      result.existing += 1;
      result.agentIds[definition.key] = existing.id;
      if (existing.builtin_revision !== definition.revision) {
        const { error } = await admin
          .from("ai_agents")
          .update({
            builtin_revision: definition.revision,
            name: definition.name,
            description: definition.description,
            system_prompt: definition.systemPrompt,
            config: {
              workbench: { scenarios: definition.scenarios, budget: definition.defaultBudget },
            },
          } as never)
          .eq("organization_id", organizationId)
          .eq("id", existing.id)
          .eq("origin", "builtin");
        if (error) throw new Error(`builtin_agent_upgrade_failed:${error.message}`);
      }
      await ensureDraftVersion(
        admin,
        organizationId,
        existing.id,
        definition,
        provider,
        model,
        organizationKnowledgeSourceIds,
      );
      continue;
    }

    const { data: created, error: insertError } = await admin
      .from("ai_agents")
      .insert({
        organization_id: organizationId,
        name: definition.name,
        description: definition.description,
        model: "organization_default",
        system_prompt: definition.systemPrompt,
        kind: "mcp_agent",
        is_active: true,
        is_default: false,
        origin: "builtin",
        builtin_key: definition.key,
        builtin_revision: definition.revision,
        model_binding_mode: "organization_default",
        config: {
          workbench: { scenarios: definition.scenarios, budget: definition.defaultBudget },
        },
        created_by: null,
      } as never)
      .select("id")
      .single();

    if (insertError?.code === "23505") {
      const { data: raced } = await admin
        .from("ai_agents")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("builtin_key", definition.key)
        .maybeSingle();
      if (raced) {
        result.existing += 1;
        result.agentIds[definition.key] = raced.id;
        continue;
      }
    }
    if (insertError || !created)
      throw new Error(`builtin_agent_create_failed:${insertError?.message ?? definition.key}`);
    result.created += 1;
    result.agentIds[definition.key] = created.id;
    await ensureDraftVersion(
      admin,
      organizationId,
      created.id,
      definition,
      provider,
      model,
      organizationKnowledgeSourceIds,
    );
  }

  return result;
}

async function ensureDraftVersion(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  agentId: string,
  definition: (typeof BUILTIN_AGENTS)[number],
  provider: string,
  model: string,
  knowledgeSourceIds: string[],
): Promise<void> {
  // No fake model or provider: leave the built-in visible and runnable only
  // after the organization has selected a real provider/model.
  if (!provider || !model) return;
  const { data: catalogModel, error: catalogError } = await admin
    .from("ai_models")
    .select("supports_tools, deprecated_at")
    .eq("provider", provider)
    .eq("model_id", model)
    .maybeSingle();
  if (catalogError) throw new Error(`builtin_agent_model_lookup_failed:${catalogError.message}`);
  if (!catalogModel?.supports_tools || catalogModel.deprecated_at) return;
  const { data: latest, error: readError } = await admin
    .from("ai_agent_versions")
    .select("id, version_number, status, system_prompt, tool_ids, knowledge_source_ids, max_steps, token_budget, cost_budget_cents")
    .eq("organization_id", organizationId)
    .eq("agent_id", agentId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readError) throw new Error(`builtin_agent_version_lookup_failed:${readError.message}`);

  if (latest?.status === "draft") {
    const desiredKnowledgeSourceIds = definition.knowledgePolicy.namespaces.includes(
      "organization_wiki",
    )
      ? knowledgeSourceIds
      : [];
    if (
      latest.system_prompt !== definition.systemPrompt ||
      JSON.stringify(latest.tool_ids ?? []) !== JSON.stringify(definition.toolIds) ||
      latest.max_steps !== definition.defaultBudget.maxSteps ||
      latest.token_budget !== definition.defaultBudget.tokenBudget ||
      latest.cost_budget_cents !== definition.defaultBudget.costBudgetCents ||
      JSON.stringify(latest.knowledge_source_ids ?? []) !==
        JSON.stringify(desiredKnowledgeSourceIds)
    ) {
      const { error } = await admin
        .from("ai_agent_versions")
        .update({
          system_prompt: definition.systemPrompt,
          provider,
          model,
          tool_ids: [...definition.toolIds],
          max_steps: definition.defaultBudget.maxSteps,
          token_budget: definition.defaultBudget.tokenBudget,
          cost_budget_cents: definition.defaultBudget.costBudgetCents,
          knowledge_source_ids: desiredKnowledgeSourceIds,
        } as never)
        .eq("organization_id", organizationId)
        .eq("id", latest.id);
      if (error) throw new Error(`builtin_agent_version_upgrade_failed:${error.message}`);
    }
    return;
  }

  const versionNumber = (latest?.version_number ?? 0) + 1;
  const { error } = await admin.from("ai_agent_versions").insert({
    organization_id: organizationId,
    agent_id: agentId,
    version_number: versionNumber,
    system_prompt: definition.systemPrompt,
    provider,
    model,
    credential_id: null,
    tool_ids: [...definition.toolIds],
    channel_session_id: null,
    max_steps: definition.defaultBudget.maxSteps,
    token_budget: definition.defaultBudget.tokenBudget,
    cost_budget_cents: definition.defaultBudget.costBudgetCents,
    pipeline_ids: [],
    knowledge_source_ids: definition.knowledgePolicy.namespaces.includes("organization_wiki")
      ? knowledgeSourceIds
      : [],
    status: "draft",
    created_by: null,
  } as never);
  if (error && error.code !== "23505")
    throw new Error(`builtin_agent_version_create_failed:${error.message}`);
}
