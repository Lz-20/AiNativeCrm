import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { appendWorkbenchEvent } from "@/lib/ai/agents/workbench-events";
import { BUILTIN_AGENTS } from "@/lib/ai/agents/builtins";
import { ensureBuiltinAgents } from "@/lib/ai/agents/ensure-builtins";
import { resolveWorkbenchScope } from "@/lib/ai/agents/workbench-scope";
import { loadMissionContinuationAgent } from "@/lib/ai/agents/mission-continuation-agent";
import { missionAcceptanceContractSchema } from "@/lib/ai/evals/mission-acceptance-contract";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import {
  LlmNotConfiguredError,
  resolveOrgLlmConfig,
} from "@/lib/agent-engine/edge/llm/credentials";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const startSchema = z
  .object({
    agentId: z.string().uuid(),
    task: z.string().trim().min(1).max(8000),
    mode: z.enum(["inspect", "act"]),
    collaboration: z.enum(["auto", "disabled"]).optional().default("auto"),
    mission: z.object({
      goal: z.string().trim().min(1).max(8000),
      acceptanceCriteria: z.string().trim().min(1).max(4000),
      acceptanceContract: missionAcceptanceContractSchema.optional(),
      deadlineAt: z.string().datetime({ offset: true }).optional(),
    }).strict().optional(),
    scope: z
      .object({
        contactId: z.string().uuid().optional(),
        leadId: z.string().uuid().optional(),
        conversationId: z.string().uuid().optional(),
        pipelineId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const { data, error } = await createAdminClient()
    .from("ai_workbench_runs")
    .select("id, agent_id, mission_id, task, mode, status, final_text, error_code, created_at, completed_at")
    .eq("organization_id", authz.org.orgId)
    .eq("run_kind", "root")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return fail("internal_error", "无法读取工作台历史。", 500, { requestId });
  return ok(data ?? [], { requestId });
}

/** Persist and enqueue a real-model Pi-backed CRM run. */
export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;
  const supportDenied = await requireSupportWrite(org.orgId);
  if (supportDenied) return supportDenied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", "请求体必须是 JSON。", 400, { requestId });
  }
  const parsed = startSchema.safeParse(raw);
  if (!parsed.success)
    return fail("validation_failed", "工作台任务或 CRM 范围无效。", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  if (process.env.INTERNAL_AGENT_RUN_STUB === "true")
    return fail("real_model_required", "工作台要求真实模型；请关闭预览桩并配置组织模型。", 503, {
      requestId,
    });

  const admin = createAdminClient();
  try {
    await ensureBuiltinAgents(org.orgId);
  } catch {
    return fail("builtin_agents_unavailable", "暂时无法准备内置 Agent。", 503, { requestId });
  }

  const { data: agent } = await admin
    .from("ai_agents")
    .select("id, origin, builtin_key, published_version_id, operation_revision")
    .eq("id", parsed.data.agentId)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!agent) return fail("not_found", "Agent 不存在或不属于当前组织。", 404, { requestId });
  const definition =
    agent.origin === "builtin"
      ? BUILTIN_AGENTS.find((candidate) => candidate.key === agent.builtin_key)
      : undefined;
  if (agent.origin === "builtin" && !definition)
    return fail("builtin_definition_missing", "这个内置 Agent 版本尚未安装在当前应用中。", 409, {
      requestId,
    });

  let versionQuery = admin
    .from("ai_agent_versions")
    .select("id, status, provider, model, tool_ids, max_steps, token_budget, cost_budget_cents")
    .eq("organization_id", org.orgId)
    .eq("agent_id", agent.id)
    .order("version_number", { ascending: false })
    .limit(1);
  if (!definition && agent.published_version_id)
    versionQuery = versionQuery.eq("id", agent.published_version_id) as typeof versionQuery;
  const { data: version } = await versionQuery.maybeSingle();
  if (!version)
    return fail(
      "model_not_configured",
      "此 Agent 尚无可运行版本。请先配置组织默认模型；用户 Agent 需先保存版本。",
      422,
      { requestId },
    );

  let provider = version.provider;
  let model = version.model;
  if (definition) {
    const { data: organization } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", org.orgId)
      .maybeSingle();
    const llm = (organization?.settings as { llm?: unknown } | null)?.llm as
      { provider?: unknown; default_model?: unknown } | undefined;
    if (typeof llm?.provider !== "string" || typeof llm.default_model !== "string")
      return fail("model_not_configured", "先配置组织默认模型；不会发送模拟请求。", 422, {
        requestId,
      });
    provider = llm.provider;
    model = llm.default_model;
  }
  const { data: modelCapability } = await admin
    .from("ai_models")
    .select("supports_tools, deprecated_at")
    .eq("provider", provider)
    .eq("model_id", model)
    .maybeSingle();
  if (!modelCapability?.supports_tools)
    return fail(
      "model_tool_calling_unsupported",
      "所选模型未在 CRM 目录中声明支持工具调用，尚未发起模型请求。",
      422,
      { requestId },
    );
  if (modelCapability.deprecated_at)
    return fail("model_deprecated", "所选模型已停用，请更新组织模型配置。", 422, { requestId });
  try {
    const deps = requestTurnDeps();
    await resolveOrgLlmConfig(
      getRequestPool(),
      deps.llmCfg,
      org.orgId,
      definition ? undefined : { provider },
    );
  } catch (error) {
    if (error instanceof LlmNotConfiguredError)
      return fail(
        "model_credentials_missing",
        "该模型没有有效凭据。请在模型与凭据设置中连接该 Provider；没有请求模型。",
        422,
        { requestId },
      );
    return fail(
      "model_configuration_unavailable",
      "暂时无法验证组织模型配置；没有请求模型，请稍后重试。",
      503,
      { requestId },
    );
  }
  let resolvedScope;
  try {
    resolvedScope = await resolveWorkbenchScope(admin, org.orgId, parsed.data.scope);
  } catch {
    return fail("scope_not_found", "所选 CRM 对象不存在或不属于当前组织。", 422, { requestId });
  }
  if (parsed.data.mission && (parsed.data.mode !== "act" || !resolvedScope.leadId))
    return fail("mission_scope_required", "委托业务任务需要 act 模式和当前组织的商机。", 422, {
      requestId,
    });
  let missionAgentRevision: number | null = null;
  if (parsed.data.mission) {
    try {
      const continuationAgent = await loadMissionContinuationAgent(
        getRequestPool(), org.orgId, agent.id, version.id,
      );
      if (!continuationAgent)
        return fail(
          "mission_agent_not_eligible",
          "持续业务任务需要未暂停的自动 Agent；用户 Agent 必须发布当前版本，内置 Agent 使用锁定版本。",
          422,
          { requestId },
        );
      missionAgentRevision = continuationAgent.operationRevision;
    } catch {
      return fail("mission_agent_unavailable", "无法核对 Agent 的持续运行资格。", 503, { requestId });
    }
  }

  const budget = definition?.defaultBudget ?? {
    maxSteps: version.max_steps,
    tokenBudget: version.token_budget,
    costBudgetCents: version.cost_budget_cents,
  };
  const runId = randomUUID();
  const missionId = parsed.data.mission ? randomUUID() : null;
  if (missionId && parsed.data.mission && resolvedScope.leadId) {
    const { error: missionError } = await admin.from("ai_missions").insert({
      id: missionId,
      organization_id: org.orgId,
      lead_id: resolvedScope.leadId,
      actor_user_id: user.id,
      goal: parsed.data.mission.goal,
      acceptance_criteria: parsed.data.mission.acceptanceCriteria,
      acceptance_contract: parsed.data.mission.acceptanceContract ?? null,
      deadline_at: parsed.data.mission.deadlineAt ?? null,
      max_total_tokens: Math.min(1_000_000, Math.max(1_000, 2 * (budget.tokenBudget ?? 36_000))),
      max_total_cost_cents: Math.min(100_000, Math.max(1, 2 * (budget.costBudgetCents ?? 75))),
      status: "queued",
    });
    if (missionError)
      return missionError.code === "23505"
        ? fail("mission_active_exists", "这个商机已有进行中的业务任务，请先处理现有任务。", 409, { requestId })
        : fail("mission_create_failed", "无法持久化商机任务。", 500, { requestId });
  }
  const { error: insertError } = await admin.from("ai_workbench_runs").insert({
    id: runId,
    organization_id: org.orgId,
    agent_id: agent.id,
    mission_id: missionId,
    actor_user_id: user.id,
    task: parsed.data.task,
    mode: parsed.data.mode,
    scope: (parsed.data.scope ?? {}) as never,
    status: "queued",
    budget: budget as never,
    runtime_state: {
      versionId: version.id,
      runner: "pi_crm_preview",
      replyContextRevision: resolvedScope.replyContextRevision,
      agentOperationRevision: missionAgentRevision ?? agent.operation_revision,
      collaborationMode: parsed.data.collaboration,
      ...(missionId ? { directionRevision: 0 } : {}),
    },
  });
  if (insertError) {
    if (missionId)
      await admin.from("ai_missions")
        .update({ status: "needs_review", blocked_reason: "run_create_failed" })
        .eq("organization_id", org.orgId).eq("id", missionId);
    return fail("run_create_failed", "无法持久化工作台运行。", 500, { requestId });
  }
  try {
    await appendWorkbenchEvent(admin, {
      organizationId: org.orgId,
      runId,
      type: "run_started",
      payload: {
        agentId: agent.id,
        mode: parsed.data.mode,
        taskLength: parsed.data.task.length,
        evalProfile: definition?.evalProfile ?? "crm_agent_default_v1",
        knowledgeNamespaces: definition?.knowledgePolicy.namespaces ?? [],
      },
    });
  } catch {
    await admin
      .from("ai_workbench_runs")
      .update({
        status: "failed",
        error_code: "start_event_persist_failed",
        completed_at: new Date().toISOString(),
      })
      .eq("organization_id", org.orgId)
      .eq("id", runId)
      .eq("status", "queued");
    return fail("run_event_create_failed", "无法持久化运行事件。", 500, { requestId });
  }
  try {
    await enqueueJob(getRequestPool(), org.orgId, {
      kind: "workbench_start",
      sourceEventId: runId,
      payload: { runId },
      maxAttempts: 3,
    });
  } catch {
    await admin
      .from("ai_workbench_runs")
      .update({
        status: "failed",
        error_code: "start_queue_unavailable",
        completed_at: new Date().toISOString(),
      })
      .eq("organization_id", org.orgId)
      .eq("id", runId)
      .eq("status", "queued");
    await appendWorkbenchEvent(admin, {
      organizationId: org.orgId,
      runId,
      type: "run_failed",
      payload: { code: "start_queue_unavailable" },
    });
    return fail("start_queue_unavailable", "运行已保存，但任务队列暂不可用。", 503, { requestId });
  }
  return ok({ run_id: runId, mission_id: missionId, status: "queued" }, { status: 201, requestId });
}
