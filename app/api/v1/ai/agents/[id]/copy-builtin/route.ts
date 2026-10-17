import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { duplicateAgentWithVersion } from "@/lib/ai/agents/duplicate";
import { ensureBuiltinAgents } from "@/lib/ai/agents/ensure-builtins";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteCtx = { params: Promise<{ id: string }> };

/** Copy a locked first-party agent into an ordinary, pinned, editable draft. */
export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });
  const authz = await requireRole("admin", { requestId, resource: "ai_agents" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const supportDenied = await requireSupportWrite(org.orgId);
  if (supportDenied) return supportDenied;
  const admin = createAdminClient();

  try {
    await ensureBuiltinAgents(org.orgId);
  } catch {
    return fail("internal_error", "Não foi possível preparar os Agents nativos.", 500, { requestId });
  }
  const { data: source } = await admin
    .from("ai_agents")
    .select("id, origin, builtin_key")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!source) return fail("not_found", "Agent não encontrado.", 404, { requestId });
  if (source.origin !== "builtin" || !source.builtin_key)
    return fail("invalid_source", "Apenas Agents nativos podem ser copiados por esta rota.", 409, { requestId });

  const { data: organization } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  const llm = (organization?.settings as { llm?: unknown } | null)?.llm as
    | { provider?: unknown; default_model?: unknown }
    | undefined;
  if (typeof llm?.provider !== "string" || !llm.provider.trim() ||
      typeof llm.default_model !== "string" || !llm.default_model.trim()) {
    return fail("model_not_configured", "先在 Agente de IA › Provedores 选择组织默认模型，再复制此 Agent。", 422, { requestId });
  }
  const { data: model } = await admin.from("ai_models").select("supports_tools, deprecated_at")
    .eq("provider", llm.provider).eq("model_id", llm.default_model).maybeSingle();
  if (!model?.supports_tools || model.deprecated_at)
    return fail("model_unavailable", "组织默认模型不在可用工具调用模型目录中，请先更新模型设置。", 422, { requestId });

  const result = await duplicateAgentWithVersion(admin, {
    orgId: org.orgId,
    agentId: id,
    actorUserId: user.id,
    requireVersion: true,
  });
  if (!result.ok) {
    if (result.error === "no_version_to_duplicate")
      return fail("model_not_configured", "组织默认模型尚未配置，暂时无法生成可运行的副本。", 422, { requestId });
    return fail("copy_failed", "复制 Agent 失败。", 500, { requestId });
  }

  // The source version resolves organization_default at run time. The copy is
  // pinned to the exact provider/model visible at copy time for reproducibility.
  const versionId = (result.version as { id: string }).id;
  const { error: versionError } = await admin
    .from("ai_agent_versions")
    .update({ provider: llm.provider, model: llm.default_model } as never)
    .eq("organization_id", org.orgId)
    .eq("id", versionId);
  const copiedAgentId = result.agent.id as string;
  const { error: agentError } = await admin
    .from("ai_agents")
    .update({ model: `${llm.provider}/${llm.default_model}`, model_binding_mode: "pinned" })
    .eq("organization_id", org.orgId)
    .eq("id", copiedAgentId);
  if (versionError || agentError) {
    await admin.from("ai_agents").update({ archived_at: new Date().toISOString(), is_active: false }).eq("organization_id", org.orgId).eq("id", copiedAgentId);
    return fail("copy_failed", "副本已撤下，但模型绑定没有保存完整；请重试。", 500, { requestId });
  }

  void audit({
    action: "ai_agent.builtin_copied",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "ai_agent",
    resourceId: copiedAgentId,
    requestId,
    metadata: { source_agent_id: id, source_builtin_key: source.builtin_key, model_binding_mode: "pinned" },
  });
  return ok({ ...result, agent: { ...result.agent, model_binding_mode: "pinned", origin: "user" } }, { status: 201, requestId });
}
