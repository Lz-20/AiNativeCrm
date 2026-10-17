import type { AgentKnowledgeNamespace, KnowledgeEvidence } from "@/lib/ai/knowledge/contracts";

/**
 * CRM-owned boundary for bounded specialist collaboration.
 *
 * It is intentionally narrower than a generic agent graph: specialists are
 * read-only evidence producers, the parent owns synthesis, and only the parent
 * may hand an action to the existing CRM policy/execution path.
 */
export interface AgentSpecialistDefinition {
  key: string;
  role: string;
  objective: string;
  allowedToolIds: readonly string[];
  knowledgeNamespaces: readonly AgentKnowledgeNamespace[];
  effect: "read";
}

export interface AgentCollaborationPlan {
  key: string;
  revision: number;
  maxParallel: number;
  maxTotalToolCalls: number;
  maxTurnsPerSpecialist: number;
  /** Upper bound reserved for all specialists; the parent keeps the remainder. */
  modelBudgetShare: number;
  timeoutMs: number;
  specialists: readonly AgentSpecialistDefinition[];
  conflictPolicy: "surface_to_parent";
  writer: "parent_only";
}

export interface AgentSpecialistTask {
  parentRunId: string;
  organizationId: string;
  task: string;
  specialist: AgentSpecialistDefinition;
  scope: {
    contactId?: string;
    leadId?: string;
    conversationId?: string;
    pipelineId?: string;
  };
}

/**
 * A privacy-preserving factual assertion derived from a tool observation.
 * The value is hashed: synthesis uses the specialist summary, while runtime
 * conflict detection compares claims without copying CRM field values into
 * parent events or manager-readable metadata.
 */
export interface AgentEvidenceClaim {
  id: string;
  specialistKey: string;
  subject: { resource: string; id: string };
  field: string;
  valueHash: string;
  valueType: "string" | "number" | "boolean" | "null" | "scalar_array";
  locator: KnowledgeEvidence["locator"];
}

export interface AgentSpecialistResult {
  childRunId: string;
  specialistKey: string;
  status: "complete" | "partial" | "failed";
  summary: string;
  evidence: KnowledgeEvidence[];
  claims: AgentEvidenceClaim[];
  missingMaterial: string[];
  toolCalls: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costCents: number | null;
    modelTurns: number;
  };
}

export interface AgentCollaborationConflict {
  code: "evidence_disagreement" | "stale_state" | "specialist_failure";
  specialistKeys: string[];
  field?: string;
  message: string;
}

export interface AgentCollaborationOutcome {
  planKey: string;
  status: "complete" | "partial" | "failed";
  results: AgentSpecialistResult[];
  conflicts: AgentCollaborationConflict[];
  usage: {
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    costCents: number | null;
    modelTurns: number;
  };
}

export interface AgentCollaborationPort {
  runReadOnlySpecialists(
    plan: AgentCollaborationPlan,
    tasks: AgentSpecialistTask[],
    signal: AbortSignal,
  ): Promise<AgentCollaborationOutcome>;
}

export const OPPORTUNITY_REVIEW_PLAN: AgentCollaborationPlan = {
  key: "opportunity_review_v1",
  revision: 2,
  maxParallel: 3,
  maxTotalToolCalls: 18,
  maxTurnsPerSpecialist: 3,
  modelBudgetShare: 0.55,
  timeoutMs: 90_000,
  conflictPolicy: "surface_to_parent",
  writer: "parent_only",
  specialists: [
    {
      key: "customer_evidence",
      role: "客户事实分析员",
      objective: "核对联系人、近期会话、异议和明确承诺，只报告可引用事实。",
      allowedToolIds: ["crm_get_contact", "crm_list_conversations", "crm_get_conversation_history"],
      knowledgeNamespaces: ["crm_records", "conversation_history"],
      effect: "read",
    },
    {
      key: "opportunity_diagnosis",
      role: "商机诊断员",
      objective: "核对商机阶段、停滞时间、跟进和漏斗约束，给出风险诊断。",
      allowedToolIds: ["crm_get_lead", "crm_list_followups"],
      knowledgeNamespaces: ["crm_records"],
      effect: "read",
    },
    {
      key: "policy_advisor",
      role: "业务政策顾问",
      objective: "从组织 Wiki、政策和记忆中寻找下一步动作的依据与限制。",
      allowedToolIds: ["crm_search_knowledge", "crm_get_org_memory"],
      knowledgeNamespaces: ["organization_wiki", "organization_memory"],
      effect: "read",
    },
  ],
};

/** A Mission shares one cumulative budget across all of its model calls.
 * Run specialists in sequence so sibling calls cannot all pass a stale
 * preflight balance at the same time. Standalone reviews stay parallel. */
export function collaborationPlanForMission(
  plan: AgentCollaborationPlan,
  missionId: string | null,
): AgentCollaborationPlan {
  return missionId ? { ...plan, maxParallel: 1 } : plan;
}

export function validateCollaborationPlan(plan: AgentCollaborationPlan): string[] {
  const errors: string[] = [];
  if (plan.maxParallel < 1 || plan.maxParallel > plan.specialists.length)
    errors.push("max_parallel_out_of_range");
  if (plan.maxTurnsPerSpecialist < 1) errors.push("max_turns_per_specialist_out_of_range");
  if (plan.modelBudgetShare <= 0 || plan.modelBudgetShare >= 0.8)
    errors.push("model_budget_share_out_of_range");
  if (plan.writer !== "parent_only") errors.push("single_writer_required");
  const keys = new Set<string>();
  for (const specialist of plan.specialists) {
    if (specialist.effect !== "read") errors.push(`specialist_not_read_only:${specialist.key}`);
    if (keys.has(specialist.key)) errors.push(`duplicate_specialist:${specialist.key}`);
    keys.add(specialist.key);
  }
  return errors;
}

export function selectCollaborationPlan(input: {
  builtinKey?: string | null;
  leadId?: string | null;
  task?: string | null;
  disabled?: boolean;
}): AgentCollaborationPlan | null {
  if (input.disabled || !input.leadId) return null;
  if (input.builtinKey !== "sales_operations" && input.builtinKey !== "crm_supervisor")
    return null;
  // Simple, bounded CRM edits do not need three evidence specialists. If the
  // same task asks for diagnosis or evidence, preserve the collaborative path.
  const task = input.task?.trim() ?? "";
  const asksForDirectEdit = /补一条|新增|创建|安排|添加|更新|修改|移动|改为|改到|\b(?:add|create|schedule|update|move)\b/i.test(task);
  const asksForInvestigation = /复盘|分析|原因|风险|依据|核对|调查|为什么|为何|诊断|评估|compare|review|investigate|why|evidence/i.test(task);
  if (asksForDirectEdit && !asksForInvestigation) return null;
  return OPPORTUNITY_REVIEW_PLAN;
}
