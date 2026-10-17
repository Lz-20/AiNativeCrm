import { randomUUID } from "node:crypto";

import type { ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";
import { executePiTurnModelCall } from "@/lib/agent-engine/agent/pi-turn-execution";
import type { PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import type { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { buildMcpTurnTools } from "@/lib/agent-engine/edge/crm/mcp-tools";
import type { RuntimeMessage } from "@/lib/agent-runtime";
import type {
  AgentCollaborationOutcome,
  AgentCollaborationPlan,
  AgentSpecialistResult,
  AgentSpecialistTask,
} from "@/lib/ai/agents/collaboration";
import {
  BoundedAgentCollaborationRuntime,
  type AgentCollaborationStore,
  type AgentSpecialistExecutor,
  type DurableSpecialistRun,
} from "@/lib/ai/agents/collaboration-runtime";
import { appendWorkbenchEvent } from "@/lib/ai/agents/workbench-events";
import { workbenchToolEffect } from "@/lib/ai/agents/tool-effects";
import type { KnowledgeEvidence } from "@/lib/ai/knowledge/contracts";
import { normalizeKnowledgeEvidence } from "@/lib/ai/knowledge/evidence";
import type { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { extractProductFinalAnswer } from "@/lib/ai/agents/final-answer";
import { extractToolClaims } from "@/lib/ai/agents/evidence-claims";
import { specialistObservationEnvelope } from "@/lib/ai/agents/workbench-state";

type Admin = ReturnType<typeof createAdminClient>;
type TurnDeps = ReturnType<typeof requestTurnDeps>;

interface WorkbenchScope {
  contactId: string | null;
  leadId: string | null;
  conversationId: string | null;
  pipelineId: string | null;
}

interface RootRunMetadata {
  organizationId: string;
  parentRunId: string;
  rootJobId: string;
  agentId: string;
  actorUserId: string | null;
  task: string;
  scope: WorkbenchScope;
  budget: {
    maxSteps?: number | null;
    tokenBudget?: number | null;
    costBudgetCents?: number | null;
  };
}

function parseSpecialistResult(value: unknown): AgentSpecialistResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Partial<AgentSpecialistResult>;
  if (!(
    typeof result.childRunId === "string" &&
    typeof result.specialistKey === "string" &&
    (result.status === "complete" || result.status === "partial" || result.status === "failed") &&
    typeof result.summary === "string" &&
    Array.isArray(result.evidence) &&
    Array.isArray(result.missingMaterial) &&
    typeof result.toolCalls === "number" &&
    Boolean(result.usage)
  ))
    return null;
  return {
    ...result,
    claims: Array.isArray(result.claims) ? result.claims : [],
  } as AgentSpecialistResult;
}

class SupabaseCollaborationStore implements AgentCollaborationStore {
  constructor(
    private readonly admin: Admin,
    private readonly root: RootRunMetadata,
  ) {}

  async ensureChild(
    plan: AgentCollaborationPlan,
    task: AgentSpecialistTask,
  ): Promise<DurableSpecialistRun> {
    const existing = await this.admin
      .from("ai_workbench_runs")
      .select("id,status,runtime_state")
      .eq("organization_id", this.root.organizationId)
      .eq("parent_run_id", this.root.parentRunId)
      .eq("specialist_key", task.specialist.key)
      .maybeSingle();
    if (existing.error) throw new Error("specialist_run_read_failed");
    if (existing.data) {
      const state = existing.data.runtime_state as { specialistResult?: unknown } | null;
      const parsedResult = parseSpecialistResult(state?.specialistResult);
      return {
        id: existing.data.id,
        status: existing.data.status as DurableSpecialistRun["status"],
        ...(parsedResult ? { result: parsedResult } : {}),
      };
    }
    const id = randomUUID();
    const specialistBudget = {
      maxSteps: plan.maxTurnsPerSpecialist,
      tokenBudget:
        typeof this.root.budget.tokenBudget === "number"
          ? Math.max(
              512,
              Math.floor(
                (this.root.budget.tokenBudget * plan.modelBudgetShare) / plan.specialists.length,
              ),
            )
          : null,
      costBudgetCents:
        typeof this.root.budget.costBudgetCents === "number"
          ? (this.root.budget.costBudgetCents * plan.modelBudgetShare) / plan.specialists.length
          : null,
      maxToolCalls: Math.max(1, Math.floor(plan.maxTotalToolCalls / plan.specialists.length)),
    };
    const { error } = await this.admin.from("ai_workbench_runs").insert({
      id,
      organization_id: this.root.organizationId,
      agent_id: this.root.agentId,
      actor_user_id: this.root.actorUserId,
      task: `${this.root.task}\n\nSpecialist objective: ${task.specialist.objective}`,
      mode: "inspect",
      scope: this.root.scope as never,
      status: "queued",
      budget: specialistBudget as never,
      run_kind: "specialist",
      parent_run_id: this.root.parentRunId,
      specialist_key: task.specialist.key,
      collaboration_key: plan.key,
      runtime_state: {
        parentRunId: this.root.parentRunId,
        planKey: plan.key,
        planRevision: plan.revision,
        specialistKey: task.specialist.key,
      },
    });
    if (error) {
      if (error.code !== "23505") throw new Error("specialist_run_create_failed");
      return this.ensureChild(plan, task);
    }
    await appendWorkbenchEvent(this.admin, {
      organizationId: this.root.organizationId,
      runId: id,
      type: "run_started",
      payload: {
        agentId: this.root.agentId,
        mode: "inspect",
        taskLength: this.root.task.length,
        evalProfile: "specialist_readonly_v1",
        knowledgeNamespaces: task.specialist.knowledgeNamespaces,
      },
    });
    return { id, status: "queued" };
  }

  async claimChild(childRunId: string, leaseSeconds: number): Promise<string> {
    const executionAttemptId = randomUUID();
    const { data, error } = await this.admin.rpc("fn_claim_ai_specialist_run", {
      p_org: this.root.organizationId,
      p_parent: this.root.parentRunId,
      p_run: childRunId,
      p_attempt: executionAttemptId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error("specialist_run_claim_failed");
    if (!data?.length || data[0]?.execution_attempt_id !== executionAttemptId)
      throw new Error("specialist_lease_busy");
    return executionAttemptId;
  }

  async completeChild(
    childRunId: string,
    executionAttemptId: string,
    result: AgentSpecialistResult,
  ): Promise<void> {
    const status = result.status === "complete" ? "completed" : "partial";
    const { data, error } = await this.admin
      .from("ai_workbench_runs")
      .update({
        status,
        final_text: result.summary || null,
        completed_at: new Date().toISOString(),
        error_code: status === "partial" ? "specialist_partial" : null,
        runtime_state: {
          parentRunId: this.root.parentRunId,
          specialistResult: result,
        } as never,
        execution_lease_expires_at: null,
      })
      .eq("organization_id", this.root.organizationId)
      .eq("id", childRunId)
      .eq("parent_run_id", this.root.parentRunId)
      .eq("status", "running")
      .eq("execution_attempt_id", executionAttemptId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("specialist_run_complete_failed");
    if (!data) throw new Error("specialist_execution_attempt_stale");
    await appendWorkbenchEvent(this.admin, {
      organizationId: this.root.organizationId,
      runId: childRunId,
      type: status === "completed" ? "run_completed" : "run_partial",
      payload: { status, hasAnswer: Boolean(result.summary), pendingProposals: 0 },
    });
    await appendWorkbenchEvent(this.admin, {
      organizationId: this.root.organizationId,
      runId: childRunId,
      type: "usage_reported",
      payload: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costCents: result.usage.costCents,
        calls: 1,
      },
    });
  }

  async failChild(
    childRunId: string,
    executionAttemptId: string,
    code: string,
    errorType: string,
  ): Promise<void> {
    const { data, error } = await this.admin
      .from("ai_workbench_runs")
      .update({
        status: "failed",
        error_code: code,
        error_summary: errorType,
        completed_at: new Date().toISOString(),
        execution_lease_expires_at: null,
      })
      .eq("organization_id", this.root.organizationId)
      .eq("id", childRunId)
      .eq("parent_run_id", this.root.parentRunId)
      .eq("status", "running")
      .eq("execution_attempt_id", executionAttemptId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("specialist_run_fail_failed");
    if (!data) throw new Error("specialist_execution_attempt_stale");
    await appendWorkbenchEvent(this.admin, {
      organizationId: this.root.organizationId,
      runId: childRunId,
      type: "run_failed",
      payload: { code, errorType },
    });
  }

  async cancelChild(childRunId: string, executionAttemptId: string): Promise<void> {
    const { data: cancelled, error } = await this.admin
      .from("ai_workbench_runs")
      .update({
        status: "cancelled",
        completed_at: new Date().toISOString(),
        execution_lease_expires_at: null,
      })
      .eq("organization_id", this.root.organizationId)
      .eq("id", childRunId)
      .eq("parent_run_id", this.root.parentRunId)
      .eq("status", "running")
      .eq("execution_attempt_id", executionAttemptId)
      .select("id")
      .maybeSingle();
    if (error) throw new Error("specialist_run_cancel_failed");
    if (cancelled)
      await appendWorkbenchEvent(this.admin, {
        organizationId: this.root.organizationId,
        runId: childRunId,
        type: "run_cancelled",
        payload: {},
      });
  }

  async cancelPendingChildren(): Promise<void> {
    const { data, error } = await this.admin
      .from("ai_workbench_runs")
      .update({
        status: "cancelled",
        completed_at: new Date().toISOString(),
        execution_lease_expires_at: null,
      })
      .eq("organization_id", this.root.organizationId)
      .eq("parent_run_id", this.root.parentRunId)
      .in("status", ["queued", "running"])
      .select("id");
    if (error) throw new Error("specialist_children_cancel_failed");
    await Promise.all(
      (data ?? []).map((child) =>
        appendWorkbenchEvent(this.admin, {
          organizationId: this.root.organizationId,
          runId: child.id,
          type: "run_cancelled",
          payload: {},
        }),
      ),
    );
  }

  appendParentEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    return appendWorkbenchEvent(this.admin, {
      organizationId: this.root.organizationId,
      runId: this.root.parentRunId,
      type: type as Parameters<typeof appendWorkbenchEvent>[1]["type"],
      payload,
    }).then(() => undefined);
  }
}

function textOfMessage(message: Extract<RuntimeMessage, { role: "tool" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function structuredValue(message: Extract<RuntimeMessage, { role: "tool" }>): unknown {
  if (message.details && typeof message.details === "object") return message.details;
  try {
    return JSON.parse(textOfMessage(message));
  } catch {
    return null;
  }
}


function toolEvidence(
  message: Extract<RuntimeMessage, { role: "tool" }>,
  specialistKey: string,
): KnowledgeEvidence[] {
  if (message.isError) return [];
  if (["crm_search_knowledge", "crm_get_org_memory"].includes(message.toolName)) {
    const evidence = normalizeKnowledgeEvidence(structuredValue(message));
    if (evidence.length || message.toolName === "crm_search_knowledge") return evidence;
  }
  const namespace = message.toolName.includes("conversation")
    ? "conversation_history"
    : message.toolName === "crm_get_org_memory"
      ? "organization_memory"
      : "crm_records";
  const kind =
    namespace === "conversation_history"
      ? "conversation"
      : namespace === "organization_memory"
        ? "organization_memory"
        : "crm_record";
  return [
    {
      id: `${specialistKey}:${message.toolCallId}`,
      namespace,
      kind,
      title: message.toolName,
      excerpt: textOfMessage(message).slice(0, 1200),
      locator: { provider: "crm_tool", sourceId: message.toolCallId },
      metadata: { toolName: message.toolName },
    },
  ];
}

function unavailableKnowledge(message: Extract<RuntimeMessage, { role: "tool" }>): boolean {
  if (message.toolName !== "crm_search_knowledge") return false;
  const text = textOfMessage(message);
  return /"status"\s*:\s*"(?:unavailable|empty)"|published_knowledge_sources/i.test(text);
}

class PiWorkbenchSpecialistExecutor implements AgentSpecialistExecutor {
  constructor(
    private readonly admin: Admin,
    private readonly deps: TurnDeps,
    private readonly root: RootRunMetadata,
    private readonly agentConfig: PublishedAgentConfig,
  ) {}

  async execute(input: Parameters<AgentSpecialistExecutor["execute"]>[0]) {
    input.signal.throwIfAborted();
    const allowed = new Set(input.task.specialist.allowedToolIds);
    const childConfig: PublishedAgentConfig = {
      ...this.agentConfig,
      toolIds: this.agentConfig.toolIds.filter((toolId) => allowed.has(toolId)),
      pipelineIds: this.root.scope.pipelineId ? [this.root.scope.pipelineId] : [],
    };
    const mcp = await buildMcpTurnTools(
      this.deps.crmCfg,
      { organizationId: this.root.organizationId, jobId: input.childRunId },
      childConfig,
      this.deps.log,
      { readOnly: true },
    );
    let toolCalls = 0;
    let toolErrors = 0;
    try {
      const scopeLines = Object.entries(this.root.scope)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
      const tools = Object.fromEntries(
        Object.entries(mcp?.tools ?? {}).filter(([name]) => allowed.has(name)),
      ) as ToolSet;
      const modelResult = await executePiTurnModelCall(
        {
          pool: getRequestPool(),
          llmCfg: this.deps.llmCfg,
          log: this.deps.log,
          runtime: this.deps.runtime,
        },
        {
          tenantId: this.root.organizationId,
          jobId: this.root.rootJobId,
          workbenchRunId: input.childRunId,
          agentId: this.root.agentId,
          purpose: "agent_specialist",
          model: childConfig.model,
          llmOverride: {
            provider: childConfig.provider,
            credentialId: childConfig.credentialId,
          },
          system: [
            childConfig.systemPrompt,
            `你是${input.task.specialist.role}，是父 Agent 的只读 specialist。`,
            input.task.specialist.objective,
            "只允许使用分配给你的只读工具。必须至少调用一个相关工具取得 observation 后再输出；每个相同范围的工具最多调用一次。",
            "如果工具返回空结果，应把空结果作为事实并说明边界；如果没有可用工具或关键字段，应明确列为缺失材料。",
            "最终报告不超过 800 个中文字符；优先保留对象 ID、时间、金额、阶段、引用来源、缺失材料与冲突。",
            "只输出报告正文，不输出内部计划、写作指令或思维过程。不得声称执行了写入。",
          ].join("\n"),
          messages: [
            {
              role: "user",
              content: `${input.task.task}\n\n已校验 CRM 范围：\n${scopeLines || "未指定对象"}`,
            },
          ],
          tools,
          maxSteps: input.plan.maxTurnsPerSpecialist,
          abortSignal: input.signal,
          beforeToolCall: ({ name }) => {
            const effect = workbenchToolEffect(name);
            if (!allowed.has(name) || effect?.effect !== "read")
              return { block: true, terminate: true, reason: "specialist_read_only_boundary" };
            if (!input.claimToolCall())
              return {
                block: true,
                terminate: true,
                reason: "collaboration_tool_budget_exhausted",
              };
            return undefined;
          },
          shouldStopAfterTurn: ({ cumulativeUsage }) => {
            const allocated =
              typeof this.root.budget.tokenBudget === "number"
                ? Math.max(
                    512,
                    Math.floor(
                      (this.root.budget.tokenBudget * input.plan.modelBudgetShare) /
                        input.plan.specialists.length,
                    ),
                  )
                : null;
            return allocated !== null && cumulativeUsage.totalTokens >= allocated;
          },
          onEvent: async (event) => {
            const data = event.data;
            const tool = typeof data.tool_name === "string" ? data.tool_name : undefined;
            const toolCallId =
              typeof data.tool_call_id === "string" ? data.tool_call_id : undefined;
            if (event.type === "tool_execution_start" && tool)
              await appendWorkbenchEvent(this.admin, {
                organizationId: this.root.organizationId,
                runId: input.childRunId,
                type: "tool_started",
                payload: { tool, toolCallId },
              });
            else if (event.type === "tool_execution_end") {
              toolCalls += 1;
              if (data.is_error) toolErrors += 1;
              await appendWorkbenchEvent(this.admin, {
                organizationId: this.root.organizationId,
                runId: input.childRunId,
                type: "tool_completed",
                payload: { tool, toolCallId, status: data.is_error ? "error" : "success" },
              });
            } else if (event.type === "turn_end")
              await appendWorkbenchEvent(this.admin, {
                organizationId: this.root.organizationId,
                runId: input.childRunId,
                type: "model_decision",
                payload: { toolResultCount: toolCalls },
              });
          },
        },
      );
      const messages = modelResult.result.runtimeMessages as RuntimeMessage[];
      const toolMessages = messages.filter(
        (message): message is Extract<RuntimeMessage, { role: "tool" }> => message.role === "tool",
      );
      const evidence = toolMessages.flatMap((message) =>
        toolEvidence(message, input.task.specialist.key),
      );
      const claims = toolMessages.flatMap((message) =>
        extractToolClaims({
          message,
          specialistKey: input.task.specialist.key,
          scope: input.task.scope,
        }),
      );
      const missingMaterial = [
        ...(toolErrors ? ["failed_tool_observations"] : []),
        ...(toolMessages.some(unavailableKnowledge) ? ["published_knowledge_sources"] : []),
        ...(toolCalls === 0 ? ["tool_observations"] : []),
      ];
      const extractedAnswer = extractProductFinalAnswer(modelResult.result.text);
      if (extractedAnswer.inspection.internalDraftCodes.length > 0 && !extractedAnswer.sanitized)
        missingMaterial.push("safe_specialist_summary");
      if (extractedAnswer.inspection.likelyTruncated)
        missingMaterial.push("complete_specialist_summary");
      const status = toolErrors > 0 || missingMaterial.length > 0 ? "partial" : "complete";
      const { error: stateError } = await this.admin.from("ai_agent_run_states").upsert(
        {
          organization_id: this.root.organizationId,
          run_id: input.childRunId,
          messages: messages as never,
          observations: specialistObservationEnvelope(evidence, claims) as never,
        },
        { onConflict: "run_id" },
      );
      if (stateError) throw new Error("specialist_state_persist_failed");
      return {
        status,
        summary: extractedAnswer.text,
        evidence,
        claims,
        missingMaterial: [...new Set(missingMaterial)],
        toolCalls,
        usage: {
          inputTokens: modelResult.usage.inputTokens,
          outputTokens: modelResult.usage.outputTokens,
          costCents: modelResult.costCents,
          modelTurns: modelResult.events.filter((event) => event.type === "turn_end").length,
        },
      } satisfies Omit<AgentSpecialistResult, "childRunId" | "specialistKey">;
    } finally {
      await mcp?.cleanup();
    }
  }
}

export async function runWorkbenchCollaboration(input: {
  admin: Admin;
  deps: TurnDeps;
  plan: AgentCollaborationPlan;
  root: RootRunMetadata;
  agentConfig: PublishedAgentConfig;
  signal: AbortSignal;
}): Promise<AgentCollaborationOutcome> {
  const tasks = input.plan.specialists.map<AgentSpecialistTask>((specialist) => ({
    parentRunId: input.root.parentRunId,
    organizationId: input.root.organizationId,
    task: input.root.task,
    specialist,
    scope: {
      ...(input.root.scope.contactId ? { contactId: input.root.scope.contactId } : {}),
      ...(input.root.scope.leadId ? { leadId: input.root.scope.leadId } : {}),
      ...(input.root.scope.conversationId
        ? { conversationId: input.root.scope.conversationId }
        : {}),
      ...(input.root.scope.pipelineId ? { pipelineId: input.root.scope.pipelineId } : {}),
    },
  }));
  const runtime = new BoundedAgentCollaborationRuntime(
    new SupabaseCollaborationStore(input.admin, input.root),
    new PiWorkbenchSpecialistExecutor(input.admin, input.deps, input.root, input.agentConfig),
  );
  return runtime.runReadOnlySpecialists(input.plan, tasks, input.signal);
}
