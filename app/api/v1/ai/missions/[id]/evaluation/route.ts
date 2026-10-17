import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { evaluateMission } from "@/lib/ai/evals/evaluate-mission";
import { loadMissionDeliveryEvidence } from "@/lib/ai/evals/mission-delivery-evidence";
import { loadMissionCustomerResponses } from "@/lib/ai/evals/mission-customer-response";
import { evaluateExplicitOffer } from "@/lib/ai/evals/mission-explicit-offer-evidence";
import { parseMissionAcceptanceContract } from "@/lib/ai/evals/mission-acceptance-contract";
import { loadMissionBudgetUsage } from "@/lib/ai/agents/mission-budget";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type RouteCtx = { params: Promise<{ id: string }> };

/** Deterministic business-evidence audit; it never claims free-text acceptance is proven. */
export async function GET(_request: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "任务 ID 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const organizationId = authz.org.orgId;
  const admin = createAdminClient();
  const { data: mission, error: missionError } = await admin.from("ai_missions")
    .select("id, lead_id, status, acceptance_criteria, acceptance_contract, resolution_reason, resolved_by_user_id, max_runs, deadline_at")
    .eq("organization_id", organizationId).eq("id", id).maybeSingle();
  if (missionError) return fail("internal_error", "无法读取业务任务。", 500, { requestId });
  if (!mission) return fail("not_found", "业务任务不存在。", 404, { requestId });
  let acceptanceContract;
  try { acceptanceContract = parseMissionAcceptanceContract(mission.acceptance_contract); }
  catch {
    return fail("mission_contract_invalid", "任务验收契约无效，评测拒绝给出结论。", 409, { requestId });
  }

  const [{ data: rootRuns, error: runsError }, { data: lead, error: leadError }] = await Promise.all([
    admin.from("ai_workbench_runs")
      .select("id, status, error_code")
      .eq("organization_id", organizationId).eq("mission_id", id).eq("run_kind", "root")
      .order("created_at", { ascending: true }),
    admin.from("crm_leads")
      .select("id, status, stage_id, contact_id")
      .eq("organization_id", organizationId).eq("id", mission.lead_id).maybeSingle(),
  ]);
  if (runsError || leadError)
    return fail("internal_error", "无法读取任务证据。", 500, { requestId });
  const runIds = (rootRuns ?? []).map((run) => run.id);
  const [proposalResult, eventResult, specialistResult] = runIds.length
    ? await Promise.all([
        admin.from("ai_agent_action_proposals")
          .select("id, run_id, tool_name, status, preview", { count: "exact" })
          .eq("organization_id", organizationId).in("run_id", runIds),
        admin.from("ai_agent_run_events")
          .select("run_id, sequence, event_type, payload", { count: "exact" })
          .eq("organization_id", organizationId).in("run_id", runIds)
          .order("sequence", { ascending: true }),
        admin.from("ai_workbench_runs")
          .select("id, parent_run_id, status", { count: "exact" })
          .eq("organization_id", organizationId).in("parent_run_id", runIds)
          .eq("run_kind", "specialist"),
      ])
    : [{ data: [], error: null, count: 0 }, { data: [], error: null, count: 0 }, { data: [], error: null, count: 0 }];
  if (proposalResult.error || eventResult.error || specialistResult.error)
    return fail("internal_error", "无法读取任务执行证据。", 500, { requestId });
  if (
    proposalResult.count !== (proposalResult.data?.length ?? 0) ||
    eventResult.count !== (eventResult.data?.length ?? 0) ||
    specialistResult.count !== (specialistResult.data?.length ?? 0)
  ) return fail("mission_evidence_incomplete", "任务证据超过单次读取上限，评测拒绝给出不完整结论。", 409, { requestId });

  const proposals = proposalResult.data;
  const events = eventResult.data;
  const sendProposalIds = (proposals ?? [])
    .filter((proposal) => proposal.tool_name === "send_message")
    .map((proposal) => proposal.id);
  const pool = getRequestPool();
  let replyDrafts;
  let customerResponses;
  let budget;
  let explicitOffer;
  try {
    replyDrafts = await loadMissionDeliveryEvidence(pool, organizationId, sendProposalIds);
    customerResponses = await loadMissionCustomerResponses(
      pool, organizationId,
      replyDrafts.flatMap((draft) => draft.messageId ? [draft.messageId] : []),
    );
    budget = await loadMissionBudgetUsage(pool, organizationId, id);
    explicitOffer = await evaluateExplicitOffer(pool, organizationId, id);
  } catch {
    return fail("mission_evidence_unavailable", "无法核对发送、客户回复、报价确认凭证或任务预算。", 503, { requestId });
  }
  if (!budget) return fail("mission_budget_unavailable", "任务累计预算不存在。", 503, { requestId });

  const report = evaluateMission({
    mission: {
      id: mission.id,
      leadId: mission.lead_id,
      status: mission.status,
      acceptanceCriteria: mission.acceptance_criteria,
      acceptanceContract,
      resolutionReason: mission.resolution_reason,
      resolvedByUserId: mission.resolved_by_user_id,
      maxRuns: mission.max_runs,
      deadlineAt: mission.deadline_at,
    },
    runs: (rootRuns ?? []).map((run) => ({ id: run.id, status: run.status, errorCode: run.error_code })),
    specialists: (specialistResult.data ?? []).map((run) => ({
      id: run.id, parentRunId: run.parent_run_id ?? "", status: run.status,
    })),
    proposals: (proposals ?? []).map((proposal) => ({
      id: proposal.id, runId: proposal.run_id, toolName: proposal.tool_name, status: proposal.status,
      preview: proposal.tool_name === "crm_update_lead" && proposal.preview &&
        typeof proposal.preview === "object" && !Array.isArray(proposal.preview)
        ? proposal.preview as Record<string, unknown> : null,
    })),
    replyDrafts,
    customerResponses,
    events: (events ?? []).map((event) => ({
      runId: event.run_id,
      sequence: event.sequence,
      eventType: event.event_type,
      payload: event.payload && typeof event.payload === "object"
        ? event.payload as Record<string, unknown> : {},
    })),
    lead: lead ? {
      id: lead.id, status: lead.status, stageId: lead.stage_id, contactId: lead.contact_id,
    } : null,
    budget,
    structuredOffer: {
      offerId: explicitOffer.offerId, verdict: explicitOffer.verdict,
      reason: explicitOffer.reason, terms: explicitOffer.terms,
      outboundMessageId: explicitOffer.outboundMessageId,
      inboundMessageId: explicitOffer.inboundMessageId,
      structuredTermsAccepted: explicitOffer.structuredTermsAccepted,
    },
  });
  return ok(report, { requestId });
}
