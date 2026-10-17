import { z } from "zod";
import { projectLangfuseEvaluation } from "@/lib/ai/integrations/langfuse";
import { integrationBinding } from "@/lib/ai/integrations/config";
import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { audit } from "@/lib/audit";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { BUILTIN_AGENTS } from "@/lib/ai/agents/builtins";
import { parseRuntimeMessages } from "@/lib/ai/agents/workbench-state";
import type { AgentEvalReport, AgentEvalRunInput } from "@/lib/ai/evals/contracts";
import { resolveAgentEvalProfile } from "@/lib/ai/evals/profiles";
import { runAgentEvaluation } from "@/lib/ai/evals/run-evaluation";
import { matchingSavedSemanticReview } from "@/lib/ai/evals/saved-semantic-review";
import {
  LlmAgentSemanticJudge,
  WORKBENCH_SEMANTIC_RUBRIC_REVISION,
} from "@/lib/ai/evals/semantic-judge";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RouteCtx = { params: Promise<{ id: string }> };
type Admin = ReturnType<typeof createAdminClient>;

class EvaluationMaterialError extends Error {
  constructor(
    readonly code: "read_failed" | "not_found" | "state_corrupt",
    message: string,
  ) {
    super(message);
  }
}

interface EvaluationMaterial {
  input: AgentEvalRunInput;
  profile: ReturnType<typeof resolveAgentEvalProfile>;
  baseFingerprint: string;
  versionId: string | null;
}

function resultCounts(runtimeState: unknown): { claimCount: number; evidenceCount: number } {
  if (!runtimeState || typeof runtimeState !== "object") return { claimCount: 0, evidenceCount: 0 };
  const result = (runtimeState as { specialistResult?: unknown }).specialistResult;
  if (!result || typeof result !== "object") return { claimCount: 0, evidenceCount: 0 };
  const value = result as { claims?: unknown; evidence?: unknown };
  return {
    claimCount: Array.isArray(value.claims) ? value.claims.length : 0,
    evidenceCount: Array.isArray(value.evidence) ? value.evidence.length : 0,
  };
}

async function loadEvaluationMaterial(
  admin: Admin,
  organizationId: string,
  runId: string,
): Promise<EvaluationMaterial> {
  const { data: run, error: runError } = await admin
    .from("ai_workbench_runs")
    .select("id, agent_id, task, mode, status, final_text, result_document, created_at, started_at, updated_at, runtime_state")
    .eq("organization_id", organizationId)
    .eq("id", runId)
    .maybeSingle();
  if (runError) throw new EvaluationMaterialError("read_failed", "无法读取评测运行。");
  if (!run) throw new EvaluationMaterialError("not_found", "run 不存在。");

  const materials = await Promise.all([
    admin
      .from("ai_agents")
      .select("id, origin, builtin_key")
      .eq("organization_id", organizationId)
      .eq("id", run.agent_id)
      .maybeSingle(),
    admin
      .from("ai_agent_run_events")
      .select("id, sequence, event_type, payload")
      .eq("organization_id", organizationId)
      .eq("run_id", runId)
      .order("sequence", { ascending: true }),
    admin
      .from("ai_agent_action_proposals")
      .select("id, tool_name, status")
      .eq("organization_id", organizationId)
      .eq("run_id", runId),
    admin
      .from("ai_agent_run_states")
      .select("messages")
      .eq("organization_id", organizationId)
      .eq("run_id", runId)
      .maybeSingle(),
    admin
      .from("ai_workbench_runs")
      .select("id, specialist_key, status, error_code, runtime_state")
      .eq("organization_id", organizationId)
      .eq("parent_run_id", runId)
      .eq("run_kind", "specialist")
      .order("created_at", { ascending: true }),
  ]);

  if (materials.some((material) => material.error))
    throw new EvaluationMaterialError("read_failed", "评测材料读取不完整，无法给出可信评分。");
  const [{ data: agent }, { data: events }, { data: proposals }, { data: state },
    { data: collaborationRuns }] = materials;

  const definition =
    agent?.origin === "builtin"
      ? BUILTIN_AGENTS.find((candidate) => candidate.key === agent.builtin_key)
      : undefined;
  const profile = resolveAgentEvalProfile(definition?.evalProfile);
  const childIds = (collaborationRuns ?? []).map((child) => child.id);
  const childMaterials = childIds.length
    ? await Promise.all([
        admin
          .from("ai_agent_run_states")
          .select("run_id, messages")
          .eq("organization_id", organizationId)
          .in("run_id", childIds),
        admin
          .from("ai_agent_run_events")
          .select("id, run_id, sequence, event_type, payload, created_at")
          .eq("organization_id", organizationId)
          .in("run_id", childIds)
          .order("created_at", { ascending: true }),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  if (childMaterials.some((material) => material.error))
    throw new EvaluationMaterialError("read_failed", "专家评测材料读取不完整。");
  const [{ data: childStates }, { data: childEvents }] = childMaterials;
  if ((childStates ?? []).some((child) => !parseRuntimeMessages(child.messages)))
    throw new EvaluationMaterialError("state_corrupt", "专家运行状态无法安全解析。");
  if (!state && ["completed", "partial"].includes(run.status))
    throw new EvaluationMaterialError("state_corrupt", "已结束运行缺少持久化模型观察，无法给出可信评分。");
  const childStateIds = new Set((childStates ?? []).map((child) => child.run_id));
  if ((collaborationRuns ?? []).some((child) =>
    ["completed", "partial"].includes(child.status) && !childStateIds.has(child.id)))
    throw new EvaluationMaterialError("state_corrupt", "已结束专家运行缺少持久化模型观察。");
  const parsedRootMessages = parseRuntimeMessages(state?.messages);
  if (state && !parsedRootMessages)
    throw new EvaluationMaterialError("state_corrupt", "运行状态无法安全解析。");
  const runtimeMessages = [
    ...(parsedRootMessages ?? []),
    ...(childStates ?? []).flatMap((child) => parseRuntimeMessages(child.messages) ?? []),
  ];
  const contactIds = [...new Set(runtimeMessages.flatMap(message => {
    if (message.role !== "tool" || message.toolName !== "crm_get_contact" || message.isError) return [];
    try {
      const text = typeof message.content === "string" ? message.content : message.content
        .filter(part => part.type === "text").map(part => part.text).join("\n");
      const value = message.details ?? JSON.parse(text);
      return typeof value?.id === "string" && UUID_RX.test(value.id) ? [value.id as string] : [];
    } catch { return []; }
  }))];
  if (contactIds.length > 50)
    throw new EvaluationMaterialError("read_failed", "记忆覆盖校验超出安全读取上限。");
  let confirmedMemoryExpectations: AgentEvalRunInput["confirmedMemoryExpectations"] = [];
  if (contactIds.length) {
    // Only facts present throughout this run count. Later additions/deletions
    // cannot manufacture a historical failure. Current privacy always wins.
    const contacts = await admin.from("contacts").select("id")
      .eq("organization_id", organizationId).in("id", contactIds)
      .eq("is_anonymized", false).is("is_merged_into", null);
    if (contacts.error) throw new EvaluationMaterialError("read_failed", "无法独立校验客户记忆作用域。");
    const allowed = (contacts.data ?? []).map(contact => contact.id);
    if (allowed.length) {
      const memories = await admin.from("ai_customer_memories").select("id, contact_id")
        .eq("organization_id", organizationId).in("contact_id", allowed)
        .lte("created_at", run.started_at ?? run.created_at)
        .or(`deleted_at.is.null,deleted_at.gt.${run.updated_at}`).limit(1001);
      if (memories.error || (memories.data?.length ?? 0) > 1000)
        throw new EvaluationMaterialError("read_failed", "确认记忆存在性读取不完整。");
      confirmedMemoryExpectations = allowed.map(contactId => ({ contactId,
        memoryIds: (memories.data ?? []).filter(memory => memory.contact_id === contactId).map(memory => memory.id),
        asOf: run.started_at ?? run.created_at,
      }));
    }
  }
  const parentEvents = (events ?? []).map((event) => ({
    id: event.id,
    sequence: event.sequence,
    eventType: event.event_type,
    payload:
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {},
  }));
  const lastParentSequence = parentEvents.at(-1)?.sequence ?? 0;
  const aggregateEvents = [
    ...parentEvents,
    ...(childEvents ?? []).map((event, index) => ({
      id: event.id,
      sequence: lastParentSequence + index + 1,
      eventType: event.event_type,
      payload:
        event.payload && typeof event.payload === "object"
          ? { ...(event.payload as Record<string, unknown>), childRunId: event.run_id }
          : { childRunId: event.run_id },
    })),
  ];
  const input: AgentEvalRunInput = {
    runId: run.id,
    agentId: run.agent_id,
    task: run.task,
    mode: run.mode as "inspect" | "act",
    status: run.status,
    finalText: run.final_text,
    resultDocument: run.result_document,
    events: aggregateEvents,
    proposals: (proposals ?? []).map((proposal) => ({
      id: proposal.id,
      toolName: proposal.tool_name,
      status: proposal.status,
    })),
    runtimeMessages,
    confirmedMemoryExpectations,
    collaborationRuns: (collaborationRuns ?? []).map((child) => ({
      id: child.id,
      specialistKey: child.specialist_key,
      status: child.status,
      errorCode: child.error_code,
      ...resultCounts(child.runtime_state),
    })),
  };
  const baseFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        run: {
          id: run.id,
          task: run.task,
          status: run.status,
          updatedAt: run.updated_at,
          finalText: run.final_text,
          resultDocument: run.result_document,
        },
        events: aggregateEvents,
        proposals,
        collaborationRuns,
        runtimeMessages,
        confirmedMemoryExpectations,
        profile: { key: profile.key, revision: profile.revision },
      }),
    )
    .digest("hex");
  const runtimeState =
    run.runtime_state && typeof run.runtime_state === "object"
      ? (run.runtime_state as { versionId?: unknown })
      : {};
  return {
    input,
    profile,
    baseFingerprint,
    versionId: typeof runtimeState.versionId === "string" ? runtimeState.versionId : null,
  };
}

function evaluationFingerprint(base: string, evaluator: string): string {
  return createHash("sha256").update(`${base}:${evaluator}`).digest("hex");
}

async function persistReport(
  admin: Admin,
  organizationId: string,
  report: AgentEvalReport,
  inputFingerprint: string,
): Promise<boolean> {
  const { error } = await admin.from("ai_agent_eval_reports").upsert(
    {
      organization_id: organizationId,
      run_id: report.runId,
      profile_key: report.profileKey,
      profile_revision: report.profileRevision,
      input_fingerprint: inputFingerprint,
      verdict: report.verdict,
      score: report.score,
      report: report as never,
    },
    {
      onConflict: "run_id,profile_key,profile_revision,input_fingerprint",
      ignoreDuplicates: true,
    },
  );
  return !error;
}

function materialFailure(error: unknown, requestId: string): Response {
  if (error instanceof EvaluationMaterialError) {
    if (error.code === "not_found") return fail("not_found", error.message, 404, { requestId });
    if (error.code === "state_corrupt")
      return fail("evaluation_state_corrupt", error.message, 409, { requestId });
    return fail("internal_error", error.message, 500, { requestId });
  }
  return fail("internal_error", "无法准备运行评测。", 500, { requestId });
}

/** Read-only deterministic evaluation plus matching saved semantic review; no model calls. */
export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "run id 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  let material: EvaluationMaterial;
  try {
    material = await loadEvaluationMaterial(admin, authz.org.orgId, id);
  } catch (error) {
    return materialFailure(error, requestId);
  }
  const report = await runAgentEvaluation({ run: material.input, profile: material.profile });
  const inputFingerprint = evaluationFingerprint(material.baseFingerprint, "deterministic");
  const saved = await admin.from("ai_agent_eval_reports").select("report, input_fingerprint")
    .eq("organization_id", authz.org.orgId).eq("run_id", id)
    .eq("profile_key", material.profile.key).eq("profile_revision", material.profile.revision)
    .order("created_at", { ascending: false }).limit(20);
  if (saved.error) return fail("evaluation_read_failed", "无法读取已保存的语义评测。", 503, { requestId });
  const savedSemanticEvaluation = matchingSavedSemanticReview(saved.data ?? [], {
    runId: id, profileKey: material.profile.key, profileRevision: material.profile.revision,
    baseFingerprint: material.baseFingerprint, rubricRevision: WORKBENCH_SEMANTIC_RUBRIC_REVISION,
  });
  return ok({ ...report, inputFingerprint, savedSemanticEvaluation: savedSemanticEvaluation ?? null }, { requestId });
}

/** Explicit, cost-bearing semantic review using the run's published model binding. */
export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const mode = z.enum(["semantic", "deterministic_export"]).safeParse(new URL(req.url).searchParams.get("mode") ?? "semantic");
  if (!mode.success) return fail("invalid_request", "Unknown evaluation operation.", 400, { requestId });
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "run id 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const supportDenied = await requireSupportWrite(authz.org.orgId);
  if (supportDenied) return supportDenied;
  const admin = createAdminClient();
  let material: EvaluationMaterial;
  try {
    material = await loadEvaluationMaterial(admin, authz.org.orgId, id);
  } catch (error) {
    return materialFailure(error, requestId);
  }
  // Explicit projection of deterministic evaluation preserves the read-only GET contract.
  if (mode.data === "deterministic_export") {
    const report = await runAgentEvaluation({ run: material.input, profile: material.profile });
    const fingerprint = evaluationFingerprint(material.baseFingerprint, "deterministic");
    if (!(await persistReport(admin, authz.org.orgId, report, fingerprint)))
      return fail("evaluation_persist_failed", "无法保存确定性评测。", 500, { requestId });
    try {
      await projectLangfuseEvaluation(getRequestPool(), authz.org.orgId, report, fingerprint);
    } catch { return fail("internal_error", "评测已保存，但投递排队失败。可安全重试。", 503, { requestId }); }
    await audit({ action: "ai.integration_export_requested", actorUserId: authz.user.id, organizationId: authz.org.orgId,
      resourceType: "ai_workbench_runs", resourceId: id, requestId });
    return ok({ ...report, inputFingerprint: fingerprint, projection: "queued_if_enabled" }, { requestId });
  }
  if (!material.versionId)
    return fail(
      "evaluation_model_binding_missing",
      "运行没有可复现的模型版本，无法启动语义 Judge。",
      409,
      {
        requestId,
      },
    );
  const pool = getRequestPool();
  const agentConfig = await loadAgentVersionConfig(
    pool,
    authz.org.orgId,
    material.input.agentId,
    material.versionId,
  );
  if (!agentConfig)
    return fail("evaluation_model_binding_missing", "无法读取该运行使用的模型版本。", 409, {
      requestId,
    });
  const evaluatorKey = `semantic:v${WORKBENCH_SEMANTIC_RUBRIC_REVISION}:${agentConfig.provider}:${agentConfig.model}`;
  const inputFingerprint = evaluationFingerprint(material.baseFingerprint, evaluatorKey);
  const { data: cached } = await admin
    .from("ai_agent_eval_reports")
    .select("report")
    .eq("organization_id", authz.org.orgId)
    .eq("run_id", id)
    .eq("profile_key", material.profile.key)
    .eq("profile_revision", material.profile.revision)
    .eq("input_fingerprint", inputFingerprint)
    .maybeSingle();
  if (cached?.report) {
    const cachedReport = cached.report as unknown as AgentEvalReport;
    if (cachedReport.semanticJudge?.status === "completed") {
      if (integrationBinding(authz.org.orgId, "langfuse"))
        await projectLangfuseEvaluation(pool, authz.org.orgId, cachedReport, inputFingerprint).catch(() => {});
      return ok({ ...cachedReport, inputFingerprint, cached: true }, { requestId });
    }
  }
  const deps = requestTurnDeps();
  const judge = new LlmAgentSemanticJudge({
    pool,
    llmCfg: deps.llmCfg,
    log: deps.log,
    organizationId: authz.org.orgId,
    workbenchRunId: id,
    agentId: material.input.agentId,
    model: agentConfig.model,
    llmOverride: {
      provider: agentConfig.provider,
      credentialId: agentConfig.credentialId,
    },
  });
  const report = await runAgentEvaluation({
    run: material.input,
    profile: material.profile,
    judge,
    signal: AbortSignal.timeout(120_000),
  });
  const persistedFingerprint =
    report.semanticJudge.status === "completed"
      ? inputFingerprint
      : evaluationFingerprint(material.baseFingerprint, `${evaluatorKey}:failed:${randomUUID()}`);
  if (!(await persistReport(admin, authz.org.orgId, report, persistedFingerprint)))
    return fail("evaluation_persist_failed", "语义评测已计算，但无法持久化结果。", 500, {
      requestId,
    });
  if (integrationBinding(authz.org.orgId, "langfuse")) {
    await projectLangfuseEvaluation(pool, authz.org.orgId, report, persistedFingerprint).catch(() => {});
  }
  return ok({ ...report, inputFingerprint: persistedFingerprint, cached: false }, { requestId });
}
