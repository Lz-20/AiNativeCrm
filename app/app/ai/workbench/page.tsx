import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { roleAtLeast } from "@/lib/auth/types";
import { ensureBuiltinAgents } from "@/lib/ai/agents/ensure-builtins";
import { BUILTIN_AGENTS } from "@/lib/ai/agents/builtins";
import { createAdminClient } from "@/lib/supabase/admin";
import { AgentCrmWorkbench } from "./_components/AgentCrmWorkbench";

export const dynamic = "force-dynamic";

export default async function AgentCrmWorkbenchPage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string }>;
}) {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org || !roleAtLeast(org.role, "manager")) redirect("/403");
  await ensureBuiltinAgents(org.orgId);
  const admin = createAdminClient();
  const { leadId } = await searchParams;
  const requestedLeadId =
    typeof leadId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId)
      ? leadId
      : null;
  const { data: initialLead } = requestedLeadId
    ? await admin
        .from("crm_leads")
        .select("id, title, pipeline_id")
        .eq("organization_id", org.orgId)
        .eq("id", requestedLeadId)
        .maybeSingle()
    : { data: null };
  const { data: agents, error } = await admin
    .from("ai_agents")
    .select("id, name, description, builtin_key, builtin_revision, model_binding_mode")
    .eq("organization_id", org.orgId)
    .eq("origin", "builtin")
    .is("archived_at", null)
    .order("created_at", { ascending: true });
  const { data: organization } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  const llm = (organization?.settings as { llm?: unknown } | null)?.llm as
    { provider?: unknown; default_model?: unknown } | undefined;
  const modelConfigured =
    typeof llm?.provider === "string" &&
    Boolean(llm.provider.trim()) &&
    typeof llm?.default_model === "string" &&
    Boolean(llm.default_model.trim());

  return (
    <section
      aria-label="Agent–CRM 工作台"
      className="mx-auto flex h-full min-h-0 w-full max-w-[1600px] flex-col"
    >
      <h1 className="sr-only">Agent–CRM 工作台</h1>
      {!modelConfigured && (
        <div
          role="status"
          className="mb-2 max-h-24 shrink-0 overflow-auto rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          先连接组织的真实模型，内置 Agent 可先查看但暂时不能运行。系统不会使用模拟模型。
        </div>
      )}
      {error ? (
        <p role="alert">加载内置 Agent 失败，请刷新重试。</p>
      ) : (
        <AgentCrmWorkbench
          initialLead={
            initialLead
              ? {
                  id: initialLead.id,
                  title: initialLead.title,
                  pipelineId: initialLead.pipeline_id,
                }
              : null
          }
          canCopy={roleAtLeast(org.role, "admin")}
          agents={(agents ?? []).map((agent) => {
            const definition = BUILTIN_AGENTS.find((item) => item.key === agent.builtin_key);
            return {
              ...agent,
              scenarios: definition?.scenarios ?? [],
              builtinKey: agent.builtin_key ?? "",
              knowledgePolicy: definition?.knowledgePolicy,
              evalProfile: definition?.evalProfile,
            };
          })}
          modelConfigured={modelConfigured}
        />
      )}
    </section>
  );
}
