import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { loadMissionDeliveryEvidence } from "@/lib/ai/evals/mission-delivery-evidence";
import { verifyCustomerDelivery } from "@/lib/ai/evals/evaluate-mission";
import {
  judgeCustomerAcceptance, loadCustomerAcceptanceMaterial,
} from "@/lib/ai/evals/mission-customer-acceptance";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 150;
type RouteCtx = { params: Promise<{ id: string }> };

/** Explicit, cost-bearing review of customer-authored CRM messages, separate from the acting Agent. */
export async function POST(_request: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "任务 ID 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite(authz.org.orgId);
  if (supportDenied) return supportDenied;
  const organizationId = authz.org.orgId;
  const admin = createAdminClient();
  const { data: mission, error: missionError } = await admin.from("ai_missions")
    .select("id,lead_id,acceptance_criteria")
    .eq("organization_id", organizationId).eq("id", id).maybeSingle();
  if (missionError) return fail("internal_error", "无法读取商机任务。", 500, { requestId });
  if (!mission) return fail("not_found", "商机任务不存在。", 404, { requestId });
  const [{ data: lead, error: leadError }, { data: runs, error: runError, count: runCount }] = await Promise.all([
    admin.from("crm_leads").select("id,contact_id")
      .eq("organization_id", organizationId).eq("id", mission.lead_id).maybeSingle(),
    admin.from("ai_workbench_runs").select("id,agent_id,runtime_state", { count: "exact" })
      .eq("organization_id", organizationId).eq("mission_id", id)
      .eq("run_kind", "root").order("created_at", { ascending: false }),
  ]);
  if (leadError || runError || runCount !== (runs?.length ?? 0))
    return fail("internal_error", "无法读取商机或模型绑定。", 500, { requestId });
  if (!lead?.contact_id)
    return fail("customer_contact_missing", "商机没有可核验的客户联系人。", 409, { requestId });
  const run = runs?.[0];
  const state = run?.runtime_state as { versionId?: unknown } | null;
  if (!run || typeof state?.versionId !== "string")
    return fail("evaluation_model_binding_missing", "任务没有可复现的模型版本。", 409,
      { requestId });
  const { data: proposals, error: proposalsError, count } = await admin
    .from("ai_agent_action_proposals")
    .select("id,status", { count: "exact" })
    .eq("organization_id", organizationId).eq("tool_name", "send_message")
    .in("run_id", (runs ?? []).map((item) => item.id));
  if (proposalsError || count !== (proposals?.length ?? 0))
    return fail("mission_evidence_incomplete", "发送提案证据不完整。", 409, { requestId });
  const pool = getRequestPool();
  try {
    const executedIds = (proposals ?? []).filter((proposal) => proposal.status === "executed")
      .map((proposal) => proposal.id);
    if (!executedIds.length)
      return ok({ verdict: "insufficient", reason: "verified_outbound_missing",
        businessOutcomeVerified: false, evidence: [] }, { requestId });
    const drafts = await loadMissionDeliveryEvidence(pool, organizationId, executedIds);
    if (drafts.some((draft) => !executedIds.includes(draft.proposalId)))
      return fail("mission_evidence_conflict", "发送草稿不属于该任务。", 409, { requestId });
    const verifiedIds = drafts.filter((draft) =>
      verifyCustomerDelivery(draft, lead.contact_id).verdict === "verified")
      .flatMap((draft) => draft.messageId ? [draft.messageId] : []);
    if (!verifiedIds.length)
      return ok({ verdict: "insufficient", reason: "verified_outbound_missing",
        businessOutcomeVerified: false, evidence: [] }, { requestId });
    const material = await loadCustomerAcceptanceMaterial(pool, organizationId,
      lead.contact_id, verifiedIds, mission.acceptance_criteria);
    if (!material.messages.length)
      return ok({ verdict: "insufficient", reason: "customer_reply_missing",
        businessOutcomeVerified: false, evidence: [] }, { requestId });
    const config = await loadAgentVersionConfig(pool, organizationId,
      run.agent_id, state.versionId);
    if (!config)
      return fail("evaluation_model_binding_missing", "无法读取任务使用的模型版本。", 409,
        { requestId });
    const deps = requestTurnDeps();
    const result = await judgeCustomerAcceptance({
      material, pool, llmCfg: deps.llmCfg, log: deps.log, organizationId,
      model: config.model,
      llmOverride: { provider: config.provider, credentialId: config.credentialId },
      signal: AbortSignal.timeout(120_000),
    });
    void audit({
      action: "ai_mission.customer_acceptance_reviewed",
      actorUserId: authz.user.id,
      organizationId,
      resourceType: "ai_mission",
      resourceId: id,
      requestId,
      metadata: { verdict: result.verdict, evidence_count: result.evidence.length,
        rubric_revision: result.rubricRevision },
    });
    return ok(result, { requestId });
  } catch (error) {
    if (error instanceof Error && error.message === "customer_acceptance_material_incomplete")
      return fail("customer_acceptance_material_incomplete",
        "客户消息过多或正文超出评测边界，不能使用截断材料给出结论。", 409, { requestId });
    return fail("customer_acceptance_review_failed",
      "客户答复审查未完成；不会将模型结果当作业务验收。", 503, { requestId });
  }
}
