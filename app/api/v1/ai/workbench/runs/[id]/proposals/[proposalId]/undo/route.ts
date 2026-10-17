import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { appendWorkbenchEvent } from "@/lib/ai/agents/workbench-events";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { buildMcpTurnTools } from "@/lib/agent-engine/edge/crm/mcp-tools";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type RouteCtx = { params: Promise<{ id: string; proposalId: string }> };
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Undo one previously executed reversible CRM action, guarded by its post-write version. */
export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id, proposalId } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(proposalId))
    return fail("invalid_request", "run/proposal id 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite(authz.org.orgId);
  if (supportDenied) return supportDenied;
  const admin = createAdminClient();
  const [{ data: run }, { data: proposal }] = await Promise.all([
    admin.from("ai_workbench_runs").select("id, agent_id, runtime_state, scope").eq("organization_id", authz.org.orgId).eq("id", id).maybeSingle(),
    admin.from("ai_agent_action_proposals").select("id, tool_name, status, compensation_args").eq("organization_id", authz.org.orgId).eq("run_id", id).eq("id", proposalId).maybeSingle(),
  ]);
  if (!run || !proposal) return fail("not_found", "运行或操作不存在。", 404, { requestId });
  if (proposal.tool_name !== "crm_update_lead" || proposal.status !== "executed" || !proposal.compensation_args)
    return fail("undo_unavailable", "该操作没有可用的业务撤销动作。", 409, { requestId });

  const { data: claimed } = await admin.from("ai_agent_action_proposals")
    .update({ status: "undoing" }).eq("organization_id", authz.org.orgId).eq("id", proposalId).eq("status", "executed")
    .select("id").maybeSingle();
  if (!claimed) return fail("state_conflict", "该操作正在被处理或已撤销。", 409, { requestId });

  const runtimeState = run.runtime_state as { versionId?: unknown };
  const versionId = typeof runtimeState?.versionId === "string" ? runtimeState.versionId : null;
  const base = versionId ? await loadAgentVersionConfig(getRequestPool(), authz.org.orgId, run.agent_id, versionId) : null;
  const scope = run.scope as { pipelineId?: string };
  const agent = base ? { ...base, pipelineIds: scope.pipelineId ? [scope.pipelineId] : [] } : null;
  if (!agent?.toolIds.includes("crm_update_lead")) {
    await admin.from("ai_agent_action_proposals").update({ status: "undo_failed" }).eq("organization_id", authz.org.orgId).eq("id", proposalId).eq("status", "undoing");
    return fail("undo_unavailable", "当前 Agent 版本没有 CRM 商机更新权限，无法安全撤销。", 409, { requestId });
  }

  const deps = requestTurnDeps();
  const mcp = await buildMcpTurnTools(deps.crmCfg, { organizationId: authz.org.orgId, jobId: id }, agent, deps.log);
  try {
    const tool = mcp?.tools.crm_update_lead;
    if (!tool?.execute) throw new Error("undo_tool_unavailable");
    await appendWorkbenchEvent(admin, { organizationId: authz.org.orgId, runId: id, type: "tool_started", payload: { proposalId, tool: "crm_update_lead" } });
    const result = await tool.execute(proposal.compensation_args as Record<string, unknown>, { toolCallId: randomUUID(), messages: [], context: {} });
    if (result && typeof result === "object" && "error" in result) throw new Error("undo_write_failed");
    const { error } = await admin.from("ai_agent_action_proposals").update({ status: "undone", result_summary: { outcome: "undone" } }).eq("organization_id", authz.org.orgId).eq("id", proposalId).eq("status", "undoing");
    if (error) throw new Error("undo_status_update_failed");
    await appendWorkbenchEvent(admin, { organizationId: authz.org.orgId, runId: id, type: "tool_completed", payload: { proposalId, tool: "crm_update_lead", status: "success" } });
    const args = proposal.compensation_args as { lead_id?: unknown };
    await appendWorkbenchEvent(admin, { organizationId: authz.org.orgId, runId: id, type: "crm_state_changed", payload: { proposalId, tool: "crm_update_lead", targetId: args.lead_id, changedFields: Object.keys(args).filter((key) => key !== "lead_id" && key !== "expected_updated_at") } });
    void audit({ action: "ai_workbench.action_undone", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "ai_agent_action_proposal", resourceId: proposalId, requestId, metadata: { run_id: id, tool: "crm_update_lead" } });
    return ok({ proposal_id: proposalId, status: "undone" }, { requestId });
  } catch {
    await admin.from("ai_agent_action_proposals").update({ status: "undo_failed", result_summary: { outcome: "undo_failed" } }).eq("organization_id", authz.org.orgId).eq("id", proposalId).eq("status", "undoing");
    return fail("undo_failed", "CRM 记录自操作后可能已有变化。撤销未应用，请先重新读取商机状态。", 409, { requestId });
  } finally {
    await mcp?.cleanup();
  }
}
