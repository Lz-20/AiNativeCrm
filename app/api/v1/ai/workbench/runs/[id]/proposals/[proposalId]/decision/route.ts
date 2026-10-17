import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { resolveWorkbenchScope } from "@/lib/ai/agents/workbench-scope";
import {
  executeApprovedWorkbenchTool, NonCompensableWorkbenchWriteError,
} from "@/lib/ai/agents/approved-workbench-tool";
import {
  assertWorkbenchApprovedActionCurrent, claimWorkbenchApprovedAction,
  finishWorkbenchApprovedAction, markWorkbenchApprovedActionUncertain,
} from "@/lib/ai/agents/workbench-approved-action";
import { workbenchToolEffect } from "@/lib/ai/agents/tool-effects";
import { validateWorkbenchToolArgs } from "@/lib/ai/agents/validate-workbench-tool-args";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { buildMcpTurnTools } from "@/lib/agent-engine/edge/crm/mcp-tools";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools/catalog";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ASK_INTERNAL_COLLEAGUE_TOOL } from "@/lib/ai/agents/internal-question-contract";
import {
  approveProposedFeishuQuestion, InternalQuestionError,
} from "@/lib/ai/internal-collaboration/feishu-question";
import { finalizeWorkbenchSendDecision } from "@/lib/ai/agents/workbench-send-decision-recovery";
import { rejectWorkbenchProposal } from "@/lib/ai/agents/workbench-reject-decision";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decisionSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict();
type RouteCtx = { params: Promise<{ id: string; proposalId: string }> };

/** Record one human decision, then continue the persisted Pi conversation. */
export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id, proposalId } = await ctx.params;
  if (!UUID_RX.test(id) || !UUID_RX.test(proposalId))
    return fail("invalid_request", "run/proposal id 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite(authz.org.orgId);
  if (supportDenied) return supportDenied;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "请求体必须是 JSON。", 400, { requestId });
  }
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success)
    return fail("validation_failed", "决策参数无效。", 422, {
      requestId,
      details: parsed.error.flatten(),
    });

  const admin = createAdminClient();
  const { data: run } = await admin
    .from("ai_workbench_runs")
    .select(
      "id, agent_id, mission_id, actor_user_id, task, mode, status, runtime_state, final_text, scope, budget",
    )
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!run) return fail("not_found", "run 不存在。", 404, { requestId });
  if (run.status !== "awaiting_confirmation")
    return fail("state_conflict", "run 当前不等待确认。", 409, { requestId });
  const { data: proposal } = await admin
    .from("ai_agent_action_proposals")
    .select("id, sequence, tool_name, tool_args, status")
    .eq("organization_id", authz.org.orgId)
    .eq("run_id", id)
    .eq("id", proposalId)
    .maybeSingle();
  if (!proposal) return fail("not_found", "待确认动作不存在。", 404, { requestId });
  if (proposal.status !== "pending")
    return fail("state_conflict", "这个动作已经处理过。", 409, { requestId });
  if (parsed.data.decision === "approve" && run.mode !== "act")
    return fail("inspect_read_only", "只读检查运行不能批准或执行 CRM 写入。", 409, { requestId });
  if (parsed.data.decision === "approve" && !workbenchToolEffect(proposal.tool_name))
    return fail("tool_effect_unclassified", "此工具没有安全效果分类，操作保持未执行。", 409, {
      requestId,
    });
  const validatedArgs = validateWorkbenchToolArgs(proposal.tool_name, proposal.tool_args);
  if (parsed.data.decision === "approve" && !validatedArgs.ok)
    return fail(
      "proposal_arguments_invalid",
      "提案参数未通过 CRM 工具校验；操作保持未执行。",
      409,
      { requestId },
    );

  if (proposal.tool_name === ASK_INTERNAL_COLLEAGUE_TOOL && parsed.data.decision === "approve") {
    if (!run.mission_id)
      return fail("state_conflict", "此提案没有关联商机任务，不能发送内部问题。", 409, { requestId });
    try {
      let result: Awaited<ReturnType<typeof approveProposedFeishuQuestion>> | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await approveProposedFeishuQuestion(getRequestPool(), {
            organizationId: authz.org.orgId,
            missionId: run.mission_id,
            runId: id,
            proposalId,
            approverUserId: authz.user.id,
            reason: parsed.data.reason,
          });
          break;
        } catch (error) {
          const pgCode = error && typeof error === "object" && "code" in error
            ? error.code : null;
          // A worker may append its final usage event just as approval reads
          // the next sequence. Roll back the whole transaction and retry;
          // never replay only the outbox insertion.
          if (attempt === 2 || !["23505", "40P01", "40001"].includes(String(pgCode)))
            throw error;
        }
      }
      if (!result) throw new Error("internal_question_approval_unavailable");
      void audit({
        action: "ai_workbench.action_approved",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "ai_agent_action_proposal",
        resourceId: proposalId,
        requestId,
        metadata: { run_id: id, tool: ASK_INTERNAL_COLLEAGUE_TOOL,
          question_id: result.questionId, delivery: "queued" },
      });
      return ok({ proposal_id: proposalId, status: "executed", run_status: "completed",
        question_id: result.questionId, delivery: "queued" }, { requestId });
    } catch (error) {
      if (error instanceof InternalQuestionError) {
        const code = error.code;
        const unavailable = code === "channel_unavailable" || code === "recipient_unavailable";
        return fail(code, unavailable
          ? "飞书渠道或收件人目前不可用；没有创建发送任务。"
          : "任务、Agent 或提案状态已变化；没有创建发送任务。",
        unavailable ? 503 : 409, { requestId });
      }
      return fail("internal_error", "无法安全保存内部提问；没有创建发送任务。", 500,
        { requestId });
    }
  }

  if (parsed.data.decision === "reject" && proposal.tool_name !== "send_message") {
    try {
      const result = await rejectWorkbenchProposal(getRequestPool(), {
        organizationId: authz.org.orgId,
        runId: id,
        proposalId,
        actorUserId: authz.user.id,
        reason: parsed.data.reason,
      });
      if (!result)
        return fail("state_conflict", "任务或提案状态已变化，请刷新运行详情。", 409,
          { requestId });
      void audit({
        action: "ai_workbench.action_rejected",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "ai_agent_action_proposal",
        resourceId: proposalId,
        requestId,
        metadata: { run_id: id, tool: result.toolName },
      });
      return ok({ proposal_id: proposalId, status: "rejected",
        run_status: result.outcome === "queued" ? "running" : result.outcome },
      { requestId });
    } catch {
      return fail("decision_state_unknown", "拒绝决定状态暂未确认，请刷新运行详情。", 503,
        { requestId });
    }
  }

  if (parsed.data.decision === "approve" && run.mission_id) {
    const { data: mission, error: missionError } = await admin.from("ai_missions")
      .select("status")
      .eq("organization_id", authz.org.orgId)
      .eq("id", run.mission_id)
      .maybeSingle();
    if (missionError || !mission || ["cancelled", "completed"].includes(mission.status)) {
      return fail("mission_not_active", "业务任务已停止，不能再批准关联动作。", 409, { requestId });
    }
  }

  const decision = parsed.data.decision;
  if (
    decision === "approve" &&
    proposal.tool_name !== "send_message" &&
    !VALID_TOOL_IDS.includes(proposal.tool_name as never)
  ) {
    return fail("tool_not_allowed", "提议工具不在当前 CRM 工具目录中。", 409, { requestId });
  }

  if (proposal.tool_name === "send_message") {
    const { data: draft } = await admin
      .from("ai_reply_drafts")
      .select("id, revision, original_body")
      .eq("organization_id", authz.org.orgId)
      .eq("workbench_run_id", id)
      .eq("workbench_proposal_id", proposalId)
      .maybeSingle();
    if (!draft || !validatedArgs.ok || draft.original_body !== validatedArgs.args.body) {
      return fail("reply_draft_missing", "已确认的回复草稿不可用；没有创建发送任务。", 409, {
        requestId,
      });
    }
    const userDb = await createClient();
    const { error: actionError } = await userDb.rpc("fn_reply_action", {
      p_org: authz.org.orgId,
      p_id: draft.id,
      p_revision: String(draft.revision),
      p_action: decision,
      p_body: decision === "approve" ? draft.original_body : null,
      p_feedback: parsed.data.reason ?? null,
    });
    if (actionError) {
      const { data: changed } = await admin
        .from("ai_agent_action_proposals")
        .select("status, result_summary")
        .eq("organization_id", authz.org.orgId)
        .eq("run_id", id)
        .eq("id", proposalId)
        .maybeSingle();
      if (changed?.status !== (decision === "approve" ? "executed" : "rejected")) {
        return fail(
          actionError.message.includes("stale") ? "reply_context_stale" : "reply_not_authorized",
          actionError.message.includes("stale")
            ? "会话或 Agent 上下文已变化；没有创建发送任务，请重新运行并审核新草稿。"
            : "当前登录会话未满足 CRM 回复批准策略；没有创建发送任务。",
          actionError.message.includes("stale") ? 409 : 403,
          { requestId },
        );
      }
    }
    // fn_reply_action atomically persists the draft, proposal and delivery
    // job. A process can die before the Pi observation/next job; the Worker
    // calls this same idempotent finalizer from the durable proposal facts.
    let receipt: Awaited<ReturnType<typeof finalizeWorkbenchSendDecision>>;
    try {
      receipt = await finalizeWorkbenchSendDecision(getRequestPool(), {
        organizationId: authz.org.orgId, runId: id, proposalId,
      });
    } catch {
      return fail("send_continuation_pending_recovery",
        "发送决定已记录；续跑状态暂未确认，后台将从已保存的决定恢复。", 503,
        { requestId });
    }
    if (!receipt)
      return fail("send_continuation_state_conflict",
        "发送决定已记录，但运行状态已变化；请核对任务与客户发送记录。", 409,
        { requestId });
    void audit({
      action:
        decision === "approve" ? "ai_workbench.action_approved" : "ai_workbench.action_rejected",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "ai_agent_action_proposal",
      resourceId: proposalId,
      requestId,
      metadata: {
        run_id: id,
        tool: proposal.tool_name,
        delivery: decision === "approve" ? "queued" : "not_sent",
      },
    });
    return ok({ proposal_id: proposalId,
      status: decision === "approve" ? "executed" : "rejected",
      run_status: receipt.outcome === "queued" ? "running"
        : receipt.outcome === "awaiting_confirmation" ? "awaiting_confirmation" : "partial",
    }, { requestId });
  }
  const state = run.runtime_state as { versionId?: unknown };
  if (typeof state?.versionId !== "string")
    return fail("run_state_missing", "无法恢复这次运行的 Agent 版本。", 409, { requestId });
  const agentBase = await loadAgentVersionConfig(
    getRequestPool(), authz.org.orgId, run.agent_id, state.versionId,
  );
  const scopeInput = scopeInputFromRun(run.scope);
  const agent = agentBase
    ? { ...agentBase, pipelineIds: scopeInput.pipelineId ? [scopeInput.pipelineId] : [] }
    : null;
  if (!agent || !agent.toolIds.includes(proposal.tool_name))
    return fail("tool_not_allowed", "这个 Agent 当前版本未授权该 CRM 工具。", 409,
      { requestId });
  try {
    await resolveWorkbenchScope(admin, authz.org.orgId, scopeInput);
  } catch {
    return fail("scope_not_found", "CRM 对象范围已变化；操作保持未执行。", 409,
      { requestId });
  }
  const deps = requestTurnDeps();
  const mcp = await buildMcpTurnTools(
    deps.crmCfg,
    { organizationId: authz.org.orgId, jobId: id },
    agent,
    deps.log,
    proposal.tool_name === "crm_request_human_handoff"
      ? { confirmationTools: ["crm_request_human_handoff"] }
      : undefined,
  );
  try {
    const tool = mcp?.tools[proposal.tool_name];
    if (!tool || typeof tool.execute !== "function")
      return fail("tool_not_allowed", "该动作无法通过当前 CRM Harness 安全执行。", 409,
        { requestId });

    let claimed: boolean;
    try {
      claimed = await claimWorkbenchApprovedAction(getRequestPool(), {
        organizationId: authz.org.orgId, runId: id, proposalId,
        toolName: proposal.tool_name, actorUserId: authz.user.id,
        reason: parsed.data.reason,
      });
    } catch {
      return fail("decision_state_unknown", "批准决定状态暂未确认，请刷新运行详情。", 503,
        { requestId });
    }
    if (!claimed)
      return fail("state_conflict", "任务或提案状态已变化；没有执行 CRM 工具。", 409,
        { requestId });
    void audit({
      action: "ai_workbench.action_approved",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "ai_agent_action_proposal",
      resourceId: proposalId,
      requestId,
      metadata: { run_id: id, tool: proposal.tool_name },
    });

    try {
      await assertWorkbenchApprovedActionCurrent(getRequestPool(), {
        organizationId: authz.org.orgId, runId: id, proposalId,
      });
    } catch {
      try {
        await finishWorkbenchApprovedAction(getRequestPool(), {
          organizationId: authz.org.orgId, runId: id, proposalId,
          toolName: proposal.tool_name,
          result: { kind: "safe_failure", code: "approval_no_longer_current" },
        });
      } catch {
        // The worker will reconcile the durable approved intent if needed.
      }
      return fail("approval_no_longer_current",
        "任务状态已变化，未进入 CRM 工具；请刷新运行详情。", 409, { requestId });
    }

    try {
      const { output, reversible } = await executeApprovedWorkbenchTool({
        toolName: proposal.tool_name,
        args: validatedArgs.ok ? validatedArgs.args : proposal.tool_args,
        tools: mcp.tools as never,
      });
      const outcome = await finishWorkbenchApprovedAction(getRequestPool(), {
        organizationId: authz.org.orgId, runId: id, proposalId,
        toolName: proposal.tool_name,
        result: { kind: "success", output,
          ...(reversible ? {
            compensationArgs: reversible.compensationArgs,
            preview: reversible.preview,
          } : {}) },
      });
      if (!outcome)
        return fail("action_result_state_conflict",
          "工具结果已产生，但运行状态已变化；请核对 CRM。", 409, { requestId });
      return ok({ proposal_id: proposalId, status: "executed",
        run_status: outcome === "queued" ? "running" : outcome },
      { requestId });
    } catch (error) {
      if (error instanceof NonCompensableWorkbenchWriteError) {
        try {
          const outcome = await finishWorkbenchApprovedAction(getRequestPool(), {
            organizationId: authz.org.orgId, runId: id, proposalId,
            toolName: proposal.tool_name,
            result: { kind: "safe_failure", code: "non_compensable_reversible_write" },
          });
          if (outcome)
            return ok({ proposal_id: proposalId, status: "failed",
              run_status: outcome === "queued" ? "running" : outcome },
            { requestId });
        } catch {
          // The worker will reconcile the durable approved intent if needed.
        }
      } else {
        try {
          await markWorkbenchApprovedActionUncertain(getRequestPool(), {
            organizationId: authz.org.orgId, runId: id, proposalId,
          });
        } catch {
          // The worker will reconcile the durable approved intent if needed.
        }
      }
      return fail("action_outcome_uncertain",
        "CRM 动作结果尚不能确认，已停止自动续跑；请核对业务状态，系统不会自动重放。", 503,
        { requestId });
    }
  } finally {
    await mcp?.cleanup();
  }
}

function scopeInputFromRun(value: unknown) {
  const scope = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    ...(typeof scope.contactId === "string" ? { contactId: scope.contactId } : {}),
    ...(typeof scope.leadId === "string" ? { leadId: scope.leadId } : {}),
    ...(typeof scope.conversationId === "string" ? { conversationId: scope.conversationId } : {}),
    ...(typeof scope.pipelineId === "string" ? { pipelineId: scope.pipelineId } : {}),
  };
}
