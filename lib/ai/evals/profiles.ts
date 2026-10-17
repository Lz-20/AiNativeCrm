import type { AgentEvalProfile } from "@/lib/ai/evals/contracts";

export type BuiltinEvalProfileKey =
  | "crm_intelligence_v1"
  | "sales_operations_v1"
  | "customer_communications_v1"
  | "crm_supervisor_v1";

const completion = {
  key: "task_completion",
  label: "任务完成",
  weight: 25,
  required: true,
} as const;
const answerQuality = {
  key: "answer_quality",
  label: "答案质量",
  weight: 20,
  required: true,
} as const;
const grounding = {
  key: "knowledge_grounding",
  label: "知识与证据",
  weight: 25,
  required: true,
} as const;
const reliability = {
  key: "tool_reliability",
  label: "工具可靠性",
  weight: 20,
  required: true,
} as const;
const policy = { key: "policy_compliance", label: "策略合规", weight: 20, required: true } as const;
const efficiency = { key: "efficiency", label: "执行效率", weight: 10, required: false } as const;
const collaboration = {
  key: "collaboration_quality",
  label: "多 Agent 协作",
  weight: 10,
  required: false,
} as const;

export const BUILTIN_EVAL_PROFILES: Readonly<Record<BuiltinEvalProfileKey, AgentEvalProfile>> = {
  crm_intelligence_v1: {
    key: "crm_intelligence_v1",
    revision: 8,
    criteria: [completion, answerQuality, grounding, reliability, policy, efficiency, collaboration],
    knowledgeUse: "conditional",
    maxToolCalls: 12,
    collaborationUse: "disabled",
  },
  sales_operations_v1: {
    key: "sales_operations_v1",
    revision: 8,
    criteria: [completion, answerQuality, reliability, policy, grounding, efficiency, collaboration],
    knowledgeUse: "optional",
    maxToolCalls: 16,
    collaborationUse: "conditional",
  },
  customer_communications_v1: {
    key: "customer_communications_v1",
    revision: 8,
    criteria: [policy, grounding, completion, answerQuality, reliability, efficiency, collaboration],
    knowledgeUse: "conditional",
    maxToolCalls: 12,
    collaborationUse: "disabled",
  },
  crm_supervisor_v1: {
    key: "crm_supervisor_v1",
    revision: 8,
    criteria: [completion, answerQuality, reliability, policy, efficiency, grounding, collaboration],
    knowledgeUse: "optional",
    maxToolCalls: 20,
    collaborationUse: "conditional",
  },
};

export const DEFAULT_AGENT_EVAL_PROFILE: AgentEvalProfile = {
  key: "crm_agent_default_v1",
  revision: 8,
  criteria: [completion, answerQuality, reliability, policy, efficiency, grounding, collaboration],
  knowledgeUse: "optional",
  maxToolCalls: 16,
  collaborationUse: "disabled",
};

export function resolveAgentEvalProfile(key?: string | null): AgentEvalProfile {
  if (key && key in BUILTIN_EVAL_PROFILES)
    return BUILTIN_EVAL_PROFILES[key as BuiltinEvalProfileKey];
  return DEFAULT_AGENT_EVAL_PROFILE;
}
