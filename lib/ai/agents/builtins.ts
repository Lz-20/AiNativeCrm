export type BuiltinAgentKey =
  "crm_intelligence" | "sales_operations" | "customer_communications" | "crm_supervisor";

export interface BuiltinScenario {
  title: string;
  task: string;
  harnessFocus: string;
}

export interface BuiltinAgentDefinition {
  key: BuiltinAgentKey;
  revision: number;
  name: string;
  description: string;
  systemPrompt: string;
  toolIds: readonly string[];
  /** What this Agent is allowed/expected to ground itself in. */
  knowledgePolicy: AgentKnowledgePolicy;
  /** Stable acceptance profile used by the workbench eval layer. */
  evalProfile: BuiltinEvalProfileKey;
  defaultBudget: { maxSteps: number; tokenBudget: number; costBudgetCents: number };
  scenarios: readonly [BuiltinScenario, BuiltinScenario, BuiltinScenario];
}

/**
 * Source of truth for the four first-party agents. The prompts explicitly
 * separate CRM facts from inference and require evidence-backed summaries.
 * Tool ids are capabilities, not direct database access.
 */
export const BUILTIN_AGENTS: readonly BuiltinAgentDefinition[] = [
  {
    key: "crm_intelligence",
    revision: 3,
    name: "CRM 情报员",
    description: "汇总客户、会话、商机、任务与知识中的证据，回答业务问题。",
    systemPrompt:
      "你是 CRM 情报员。先通过只读 CRM 工具核对事实，再回答。明确区分数据库事实、推断与未知；引用记录标识或来源，不得修改 CRM 状态、发送消息或声称执行了未执行的操作。",
    toolIds: [
      "crm_search_contacts",
      "crm_get_contact",
      "crm_list_leads",
      "crm_get_lead",
      "crm_list_conversations",
      "crm_get_conversation_history",
      "crm_search_knowledge",
      "crm_get_org_memory",
    ],
    knowledgePolicy: {
      namespaces: [
        "crm_records",
        "conversation_history",
        "organization_memory",
        "organization_wiki",
        "run_history",
      ],
      retrieval: "on_demand",
      citationMode: "required_for_business_claims",
      minimumEvidenceItems: 1,
      unavailableBehavior: "partial_result",
    },
    evalProfile: "crm_intelligence_v1",
    defaultBudget: { maxSteps: 8, tokenBudget: 32000, costBudgetCents: 50 },
    scenarios: [
      {
        title: "客户 360 摘要",
        task: "请总结这个客户近期的沟通、商机和待办，并列出依据。",
        harnessFocus: "上下文读取、跨模块证据与来源",
      },
      {
        title: "停滞商机原因",
        task: "找出最近停滞的商机，基于会话和活动说明可能原因。",
        harnessFocus: "并行读取、证据汇总与事实/推断区分",
      },
      {
        title: "知识依据核对",
        task: "查询知识库中与这个客户问题相关的内容，并指出哪些问题仍缺少依据。",
        harnessFocus: "RAG 检索与引用来源",
      },
    ],
  },
  {
    key: "sales_operations",
    revision: 3,
    name: "销售运营 Agent",
    description: "发现漏斗跟进缺口，并在授权范围内提出或执行 CRM 内部操作。",
    systemPrompt:
      "你是销售运营 Agent。先检查商机和跟进记录，再说明拟议动作及影响对象。只通过 CRM 工具操作；不确定时先询问。不可伪造成功。外部发送和不可逆动作必须停下来等待人工确认。",
    toolIds: [
      "crm_list_leads",
      "crm_get_lead",
      "crm_get_contact",
      "crm_list_conversations",
      "crm_get_conversation_history",
      "crm_update_lead",
      "crm_move_lead_stage",
      "crm_schedule_followup",
      "crm_list_followups",
      "crm_search_knowledge",
      "crm_get_org_memory",
    ],
    knowledgePolicy: {
      namespaces: ["crm_records", "conversation_history", "organization_wiki"],
      retrieval: "on_demand",
      citationMode: "required_for_business_claims",
      minimumEvidenceItems: 1,
      unavailableBehavior: "report_missing",
    },
    evalProfile: "sales_operations_v1",
    defaultBudget: { maxSteps: 12, tokenBudget: 36000, costBudgetCents: 75 },
    scenarios: [
      {
        title: "找出待跟进商机",
        task: "列出超过一周没有跟进的开放商机，并按风险排序。",
        harnessFocus: "多步读取与状态观察",
      },
      {
        title: "补一条跟进任务",
        task: "为选中的商机安排明天的跟进任务，并说明任务内容。",
        harnessFocus: "可撤销 CRM 写入、差异审计与补偿",
      },
      {
        title: "整理商机阶段",
        task: "检查本周新建的商机，找出阶段明显不匹配的记录并提出调整建议。",
        harnessFocus: "计划、写入前检查与失败后续行",
      },
    ],
  },
  {
    key: "customer_communications",
    revision: 4,
    name: "客户沟通 Agent",
    description: "结合会话和知识起草回复；发送、转人工等动作由 Harness 守门。",
    systemPrompt:
      "你是客户沟通 Agent。阅读会话与客户状态，必要时检索已批准的知识，生成准确、克制的回复草稿。必须区分‘创建待确认提案’与‘执行副作用’：调用 crm_request_human_handoff 只会把转人工请求送入 Harness 确认队列，不会立即转交；客户要求真人、涉及重大投诉/敏感事项或自动化无法可靠处理时，必须调用该工具创建提案，不可只用文字建议或先向用户追问是否要创建。target_user_id 是可选字段，缺省即可交由系统路由。未经确认不得发送消息或执行提案；不得声称已转交，直到提案获批并执行。缺少依据时明确说明。",
    toolIds: [
      "crm_get_contact",
      "crm_list_conversations",
      "crm_get_conversation_history",
      "crm_search_knowledge",
      "crm_request_human_handoff",
    ],
    knowledgePolicy: {
      namespaces: [
        "crm_records",
        "conversation_history",
        "organization_memory",
        "organization_wiki",
        "skills",
      ],
      retrieval: "on_demand",
      citationMode: "required_for_business_claims",
      minimumEvidenceItems: 1,
      unavailableBehavior: "partial_result",
    },
    evalProfile: "customer_communications_v1",
    defaultBudget: { maxSteps: 8, tokenBudget: 24000, costBudgetCents: 50 },
    scenarios: [
      {
        title: "拟一条有依据的回复",
        task: "阅读最近会话和相关知识，为客户起草回复，不要发送。",
        harnessFocus: "上下文、知识检索与草稿/发送边界",
      },
      {
        title: "检查承诺风险",
        task: "检查拟发送的回复是否包含知识库没有支持的承诺。",
        harnessFocus: "发送前策略与守护规则",
      },
      {
        title: "识别人工接管",
        task: "查看这段会话是否应交给人工，并解释触发依据。",
        harnessFocus: "handoff 判定和人工责任边界",
      },
    ],
  },
  {
    key: "crm_supervisor",
    revision: 5,
    name: "CRM 主管 Agent",
    description: "跨漏斗、任务与执行记录发现运营异常，给出可审核的修复计划。",
    systemPrompt:
      "你是 CRM 主管 Agent。先跨模块核对异常，再给出优先级、影响范围和可验证的修复计划。每类 CRM 只读工具在结果充分时最多调用一次；不得重复读取相同范围来凑证据。完成关键读取后立即输出清晰的结论和依据，不要以空答复结束。批量修改前逐项确认作用对象；部分成功必须如实列出，失败不得掩盖。若当前商机 Mission 缺少内部事实，可先用 list_internal_colleagues 查找已绑定同事，再用 ask_internal_colleague 提出一个确切问题；此调用只会生成待审提案，绝不代表已发出或收到回复。不可把建议或提案描述成已完成。",
    toolIds: [
      "crm_list_leads",
      "crm_get_lead",
      "crm_get_contact",
      "crm_list_conversations",
      "crm_get_conversation_history",
      "crm_list_followups",
      "crm_list_automation_runs",
      "crm_list_improvement_proposals",
      "crm_search_knowledge",
      "crm_get_org_memory",
    ],
    knowledgePolicy: {
      namespaces: ["crm_records", "organization_memory", "organization_wiki", "run_history"],
      retrieval: "on_demand",
      citationMode: "required_for_business_claims",
      minimumEvidenceItems: 1,
      unavailableBehavior: "report_missing",
    },
    evalProfile: "crm_supervisor_v1",
    defaultBudget: { maxSteps: 16, tokenBudget: 48000, costBudgetCents: 100 },
    scenarios: [
      {
        title: "漏斗健康检查",
        task: "检查各阶段商机数量和停滞情况，指出最值得优先处理的问题。",
        harnessFocus: "跨模块长任务、预算与部分成功",
      },
      {
        title: "跟进队列盘点",
        task: "汇总逾期任务及其关联商机，提出一份分批处理计划。",
        harnessFocus: "多工具编排与可回放执行",
      },
      {
        title: "运行成本复盘",
        task: "汇总近期 Agent 执行的次数、工具失败和用量异常。",
        harnessFocus: "运行事件、预算与失败观察",
      },
    ],
  },
] as const;

export function builtinAgent(key: string): BuiltinAgentDefinition | undefined {
  return BUILTIN_AGENTS.find((agent) => agent.key === key);
}
import type { BuiltinEvalProfileKey } from "@/lib/ai/evals/profiles";
import type { AgentKnowledgePolicy } from "@/lib/ai/knowledge/contracts";
