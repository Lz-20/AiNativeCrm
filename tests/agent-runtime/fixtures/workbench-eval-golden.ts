import type { AgentEvalRunInput, AgentEvalVerdict } from "@/lib/ai/evals/contracts";
import type { BuiltinEvalProfileKey } from "@/lib/ai/evals/profiles";
import { resultDocument } from "@/lib/ai/agents/workbench-result-submission";

export interface WorkbenchEvalGoldenCase {
  id: string;
  provenance:
    | { kind: "real_run"; runId: string; capturedAt: string; note: string }
    | { kind: "synthetic_regression"; note: string };
  profileKey: BuiltinEvalProfileKey;
  input: AgentEvalRunInput;
  expected: {
    verdict: AgentEvalVerdict;
    findingCodes: string[];
  };
}

function toolEvents(count: number, start = 10) {
  return Array.from({ length: count }, (_, index) => [
    {
      sequence: start + index * 2,
      eventType: "tool_started",
      payload: { tool: `tool_${index}` },
    },
    {
      sequence: start + index * 2 + 1,
      eventType: "tool_completed",
      payload: { tool: `tool_${index}`, status: "success" },
    },
  ]).flat();
}

function base(over: Partial<AgentEvalRunInput> = {}): AgentEvalRunInput {
  return {
    runId: "golden-run",
    agentId: "builtin-agent",
    task: "核对 CRM 事实、知识依据和下一步建议。",
    mode: "inspect",
    status: "completed",
    finalText: "## 结论\n\n已根据 CRM observation 核对事实，并列出证据和边界。",
    events: [
      { sequence: 1, eventType: "run_started", payload: {} },
      ...toolEvents(1, 2),
      { sequence: 4, eventType: "run_completed", payload: { status: "completed" } },
    ],
    proposals: [],
    runtimeMessages: [
      {
        role: "tool",
        toolCallId: "knowledge-1",
        toolName: "crm_search_knowledge",
        content: JSON.stringify({ evidence: [{ id: "source-1" }] }),
      },
    ],
    ...over,
  };
}

export const WORKBENCH_EVAL_GOLDEN_CASES: readonly WorkbenchEvalGoldenCase[] = [
  {
    id: "real-structured-result-observed-sources-not-claim-proof",
    provenance: {
      kind: "real_run",
      runId: "dc458785-58fc-4503-a762-96efe02e00ec",
      capturedAt: "2026-09-29T15:09:23Z",
      note: "真实 OpenCode CRM 只读运行；只保留已核对的对象 ID 与脱敏字段，不复制客户正文。",
    },
    profileKey: "crm_intelligence_v1",
    input: base({
      runId: "dc458785-58fc-4503-a762-96efe02e00ec",
      status: "partial",
      finalText: "已核对联系人、商机和会话；部分信息仍需人工确认。",
      resultDocument: resultDocument({
        summary: "已核对联系人、商机和会话；部分信息仍需人工确认。",
        evidence: [
          { sourceType: "contact", sourceId: "6842302c-a864-4a4e-8dc5-a605f6c10827", claim: "联系人已读取" },
          { sourceType: "lead", sourceId: "84598184-e361-4faa-ad1e-ae5525e85323", claim: "商机已读取" },
          { sourceType: "conversation", sourceId: "761207e2-a792-4b75-b347-819d8c1a54fb", claim: "会话已读取" },
        ],
        missingInformation: ["会话完整历史未核实"],
        nextStep: "由人工核对会话历史",
        wakeCondition: "none",
      }),
      runtimeMessages: [
        { role: "tool", toolCallId: "read-contact", toolName: "crm_get_contact",
          content: JSON.stringify({ id: "6842302c-a864-4a4e-8dc5-a605f6c10827" }) },
        { role: "tool", toolCallId: "read-lead", toolName: "crm_get_lead",
          content: JSON.stringify({ lead: { id: "84598184-e361-4faa-ad1e-ae5525e85323" } }) },
        { role: "tool", toolCallId: "list-conversations", toolName: "crm_list_conversations",
          content: JSON.stringify({ conversations: [{ id: "761207e2-a792-4b75-b347-819d8c1a54fb" }] }) },
      ],
    }),
    expected: {
      verdict: "needs_review",
      findingCodes: ["partial_result", "structured_claims_not_independently_verified", "structured_result_missing_material"],
    },
  },
  {
    id: "structured-result-unobserved-source",
    provenance: { kind: "synthetic_regression", note: "合法 UUID 但没有来自本次成功工具观察的引用必须失败。" },
    profileKey: "crm_intelligence_v1",
    input: base({
      resultDocument: resultDocument({
        summary: "商机已核对。",
        evidence: [{ sourceType: "lead", sourceId: "84598184-e361-4faa-ad1e-ae5525e85323", claim: "商机已成交" }],
        missingInformation: [], nextStep: "继续跟进", wakeCondition: "none",
      }),
    }),
    expected: { verdict: "fail", findingCodes: ["structured_result_unobserved_evidence"] },
  },
  {
    id: "structured-result-field-contradicts-observation",
    provenance: {
      kind: "synthetic_regression",
      note: "模型引用真实商机但把工具观察到的 open 状态声明为 won；字段断言必须失败。",
    },
    profileKey: "crm_intelligence_v1",
    input: base({
      resultDocument: resultDocument({
        summary: "商机已成交。",
        evidence: [{
          sourceType: "lead",
          sourceId: "84598184-e361-4faa-ad1e-ae5525e85323",
          claim: "商机已成交",
          assertions: [{ field: "status", equals: "won" }],
        }],
        missingInformation: [], nextStep: "核对成交", wakeCondition: "none",
      }),
      runtimeMessages: [{
        role: "tool", toolCallId: "read-lead", toolName: "crm_get_lead",
        content: JSON.stringify({ lead: { id: "84598184-e361-4faa-ad1e-ae5525e85323", status: "open" } }),
      }],
    }),
    expected: { verdict: "fail", findingCodes: ["structured_fact_assertion_mismatch"] },
  },
  {
    id: "real-multi-agent-missing-wiki",
    provenance: {
      kind: "real_run",
      runId: "5d8e12d4-9c20-446f-888d-229a0303081e",
      capturedAt: "2026-09-27T14:24:27Z",
      note: "OpenCode space-bunny-free；3 个 durable specialist，13 次工具调用，已脱敏。",
    },
    profileKey: "crm_supervisor_v1",
    input: base({
      runId: "5d8e12d4-9c20-446f-888d-229a0303081e",
      events: [
        { sequence: 1, eventType: "run_started", payload: {} },
        { sequence: 2, eventType: "collaboration_started", payload: { specialistCount: 3 } },
        ...toolEvents(13, 3),
        {
          sequence: 29,
          eventType: "collaboration_completed",
          payload: { completedSpecialists: 2, failedSpecialists: 0 },
        },
        { sequence: 30, eventType: "run_completed", payload: { status: "completed" } },
      ],
      runtimeMessages: [
        {
          role: "tool",
          toolCallId: "knowledge-empty",
          toolName: "crm_search_knowledge",
          content: JSON.stringify({ retrieval: { status: "unavailable" }, evidence: [] }),
        },
      ],
      collaborationRuns: [
        {
          id: "child-customer",
          specialistKey: "customer_evidence",
          status: "completed",
          errorCode: null,
          evidenceCount: 3,
          claimCount: 0,
        },
        {
          id: "child-opportunity",
          specialistKey: "opportunity_diagnosis",
          status: "completed",
          errorCode: null,
          evidenceCount: 3,
          claimCount: 0,
        },
        {
          id: "child-policy",
          specialistKey: "policy_advisor",
          status: "partial",
          errorCode: "specialist_partial",
          evidenceCount: 1,
          claimCount: 0,
        },
      ],
    }),
    expected: {
      verdict: "needs_review",
      findingCodes: [
        "knowledge_evidence_empty",
        "specialist_partial_results",
        "specialist_claims_missing",
      ],
    },
  },
  {
    id: "real-provider-truncated-numbered-list",
    provenance: {
      kind: "real_run",
      runId: "b421791b-redacted-regression",
      capturedAt: "2026-09-27T14:10:00Z",
      note: "真实 provider 输出以裸编号结尾；正文已缩减为最小回归样本。",
    },
    profileKey: "crm_supervisor_v1",
    input: base({ finalText: "## 下一步\n\n1. 核对负责人。\n2. 补齐日期。\n3" }),
    expected: { verdict: "fail", findingCodes: ["answer_likely_truncated"] },
  },
  {
    id: "real-provider-internal-draft-leak",
    provenance: {
      kind: "real_run",
      runId: "437ba48c-redacted-regression",
      capturedAt: "2026-09-27T13:50:00Z",
      note: "真实 provider 将组织稿与正式报告放进同一 assistant message。",
    },
    profileKey: "crm_supervisor_v1",
    input: base({
      finalText: "Now synthesize the final answer. Write it in Chinese.\n\n## 正式结论\n事实如下。",
    }),
    expected: {
      verdict: "fail",
      findingCodes: ["internal_analysis_leak", "internal_language_instruction"],
    },
  },
  {
    id: "grounded-read-pass",
    provenance: { kind: "synthetic_regression", note: "完整、grounded 的只读情报运行。" },
    profileKey: "crm_intelligence_v1",
    input: base(),
    expected: { verdict: "pass", findingCodes: [] },
  },
  {
    id: "external-action-without-approval",
    provenance: { kind: "synthetic_regression", note: "外部动作绕过人工确认必须硬失败。" },
    profileKey: "customer_communications_v1",
    input: base({
      mode: "act",
      events: [
        {
          sequence: 1,
          eventType: "tool_proposed",
          payload: { proposalId: "proposal-1", tool: "crm_request_human_handoff" },
        },
        {
          sequence: 2,
          eventType: "policy_checked",
          payload: { proposalId: "proposal-1", decision: "requires_human_confirmation" },
        },
        {
          sequence: 3,
          eventType: "tool_started",
          payload: { proposalId: "proposal-1", tool: "crm_request_human_handoff" },
        },
        {
          sequence: 4,
          eventType: "tool_completed",
          payload: { proposalId: "proposal-1", status: "success" },
        },
      ],
      proposals: [
        { id: "proposal-1", toolName: "crm_request_human_handoff", status: "executed" },
      ],
    }),
    expected: { verdict: "fail", findingCodes: ["confirmation_missing"] },
  },
  {
    id: "cancelled-run-is-not-success",
    provenance: { kind: "synthetic_regression", note: "取消终态不能被有残留文本的结果伪装成成功。" },
    profileKey: "sales_operations_v1",
    input: base({ status: "cancelled", finalText: "未完成的中间文本" }),
    expected: { verdict: "fail", findingCodes: ["run_cancelled"] },
  },
  {
    id: "structured-specialist-conflict",
    provenance: { kind: "synthetic_regression", note: "结构化字段冲突进入人工复核。" },
    profileKey: "crm_supervisor_v1",
    input: base({
      events: [
        { sequence: 1, eventType: "collaboration_started", payload: { specialistCount: 2 } },
        {
          sequence: 2,
          eventType: "collaboration_conflict",
          payload: { code: "evidence_disagreement", field: "lead:lead-1:stage_id" },
        },
        {
          sequence: 3,
          eventType: "collaboration_completed",
          payload: { completedSpecialists: 2, failedSpecialists: 0 },
        },
        { sequence: 4, eventType: "run_completed", payload: { status: "completed" } },
      ],
      collaborationRuns: [
        {
          id: "child-1",
          specialistKey: "customer_evidence",
          status: "completed",
          errorCode: null,
          evidenceCount: 1,
          claimCount: 3,
        },
        {
          id: "child-2",
          specialistKey: "opportunity_diagnosis",
          status: "completed",
          errorCode: null,
          evidenceCount: 1,
          claimCount: 4,
        },
      ],
    }),
    expected: { verdict: "needs_review", findingCodes: ["collaboration_conflicts"] },
  },
] as const;
