import type { RuntimeContent, RuntimeMessage } from "@/lib/agent-runtime";
import { workbenchToolEffect } from "@/lib/ai/agents/tool-effects";
import { inspectProductFinalAnswer } from "@/lib/ai/agents/final-answer";
import { workbenchResultDocumentSchema } from "@/lib/ai/agents/workbench-result-submission";
import { auditWorkbenchEvidenceProvenance } from "@/lib/ai/evals/evidence-provenance";
import type {
  AgentEvalDimensionKey,
  AgentEvalDimensionResult,
  AgentEvalFinding,
  AgentEvalProfile,
  AgentEvalReport,
  AgentEvalRunInput,
  AgentEvalVerdict,
} from "@/lib/ai/evals/contracts";

const TERMINAL = new Set(["completed", "partial", "failed", "cancelled"]);

function textOf(content: string | RuntimeContent[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function parseStructuredToolResult(message: RuntimeMessage): unknown {
  if (message.role !== "tool") return null;
  if (message.details && typeof message.details === "object") return message.details;
  const text = textOf(message.content).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function evidenceCount(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + evidenceCount(item), 0);
  const record = value as Record<string, unknown>;
  for (const key of ["evidence", "trechos", "results"]) {
    if (Array.isArray(record[key])) return record[key].length;
  }
  return Object.values(record).reduce<number>((sum, item) => sum + evidenceCount(item), 0);
}

function result(
  key: AgentEvalDimensionKey,
  label: string,
  verdict: AgentEvalVerdict,
  findings: AgentEvalFinding[],
): AgentEvalDimensionResult {
  return {
    key,
    label,
    verdict,
    score:
      verdict === "pass" ? 100 : verdict === "fail" ? 0 : verdict === "needs_review" ? 50 : null,
    findings,
  };
}

function eventSequence(input: AgentEvalRunInput, type: string, proposalId?: string): number | null {
  const found = input.events.find(
    (event) => event.eventType === type && (!proposalId || event.payload.proposalId === proposalId),
  );
  return found?.sequence ?? null;
}

function evaluateCompletion(input: AgentEvalRunInput, label: string): AgentEvalDimensionResult {
  if (!TERMINAL.has(input.status))
    return result("task_completion", label, "not_run", [
      { code: "run_not_terminal", message: "运行尚未进入终态。" },
    ]);
  if (input.status === "completed" && Boolean(input.finalText?.trim()))
    return result("task_completion", label, "pass", []);
  if (input.status === "partial")
    return result("task_completion", label, "needs_review", [
      { code: "partial_result", message: "运行只得到部分结果，需要检查缺失材料或预算。" },
    ]);
  return result("task_completion", label, "fail", [
    { code: `run_${input.status}`, message: "运行没有形成可用的完整结果。" },
  ]);
}

function normalizedParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((paragraph) => paragraph.length >= 80);
}

function evaluateAnswerQuality(input: AgentEvalRunInput, label: string): AgentEvalDimensionResult {
  const text = input.finalText?.trim() ?? "";
  if (!TERMINAL.has(input.status) || !text)
    return result("answer_quality", label, "not_run", [
      { code: "answer_unavailable", message: "尚无可评测的最终答案。" },
    ]);
  const findings: AgentEvalFinding[] = [];
  for (const expected of input.confirmedMemoryExpectations ?? []) {
    const observations = input.runtimeMessages
      .filter(message => message.role === "tool" && message.toolName === "crm_get_contact" && !message.isError)
      .map(parseStructuredToolResult)
      .filter((value): value is Record<string, unknown> => !!value && typeof value === "object" &&
        (value as Record<string, unknown>).id === expected.contactId);
    if (!observations.length) continue;
    const reads = observations.map(value => value.confirmed_customer_memory as
      { coverage?: string; memories?: Array<{ id?: string }> } | undefined);
    const observed = new Set(reads.flatMap(read => Array.isArray(read?.memories) ? read.memories.map(m => m.id) : []));
    const missing = expected.memoryIds.filter(id => !observed.has(id)).length;
    if (missing && !reads.some(read => read?.coverage === "partial"))
      findings.push({ code: "confirmed_memory_not_observed",
        message: "独立 CRM 存在性记录表明运行结束时有确认记忆，但工具观察遗漏了这些事实。",
        evidence: { missing, expected: expected.memoryIds.length } });
    else if (reads.some(read => read?.coverage !== "complete"))
      findings.push({ code: "confirmed_memory_coverage_incomplete",
        message: "确认记忆读取不完整或不可用；不能把未读取解释为不存在。" });
    if (expected.memoryIds.length)
      findings.push({ code: "memory_claims_require_semantic_review",
        message: "确认记忆的存在性已独立核对；自然语言结论仍需语义复核，并非业务验收。" });
  }
  if (input.resultDocument != null) {
    const parsed = workbenchResultDocumentSchema.safeParse(input.resultDocument);
    if (!parsed.success)
      return result("answer_quality", label, "fail", [
        { code: "structured_result_invalid", message: "结构化结果不符合产品契约。" },
      ]);
    const provenance = auditWorkbenchEvidenceProvenance(parsed.data.evidence, input);
    if (provenance.unobserved > 0)
      findings.push({
        code: "structured_result_unobserved_evidence",
        message: "部分引用没有出现在本次运行的成功工具观察或持久化协作记录中。",
        evidence: { unobserved: provenance.unobserved, total: parsed.data.evidence.length },
      });
    if (provenance.mismatched > 0)
      findings.push({
        code: "structured_fact_assertion_mismatch",
        message: "部分结构化字段断言与本次运行实际观察到的 CRM 值不一致。",
        evidence: { mismatched: provenance.mismatched },
      });
    if (provenance.unverifiable > 0)
      findings.push({
        code: "structured_fact_assertion_unverifiable",
        message: "部分结构化字段断言不属于可核对字段，或成功工具观察中没有该字段。",
        evidence: { unverifiable: provenance.unverifiable },
      });
    if (parsed.data.evidence.length === 0)
      findings.push({
        code: "structured_result_no_evidence",
        message: "结构化结果没有可追溯的引用，不能据此证明事实性结论。",
      });
    else
      findings.push({
        code: "structured_claims_not_independently_verified",
        message: "引用来源和显式字段断言已核对；自然语言声明及当前业务结果仍需独立复核。",
        evidence: {
          observed: provenance.observed,
          total: parsed.data.evidence.length,
          verifiedAssertions: provenance.verified,
        },
      });
    if (parsed.data.missingInformation.length > 0)
      findings.push({
        code: "structured_result_missing_material",
        message: "Agent 明确报告仍有缺失材料，不能将本次结果评为完整交付。",
        evidence: { missingItems: parsed.data.missingInformation.length },
      });
  }
  const inspection = inspectProductFinalAnswer(text);
  for (const code of inspection.internalDraftCodes)
    findings.push({
      code,
      message: "最终答案包含面向模型的内部写作/组织指令。",
    });
  if (inspection.likelyTruncated)
    findings.push({
      code: "answer_likely_truncated",
      message: "最终答案可能在句子或 Markdown 结构中间被截断。",
      evidence: { reasons: inspection.truncationReasons.length },
    });
  const paragraphs = normalizedParagraphs(text);
  const unique = new Set(paragraphs);
  if (unique.size < paragraphs.length)
    findings.push({
      code: "duplicate_answer_block",
      message: "最终答案包含重复的长段落。",
      evidence: { duplicateParagraphs: paragraphs.length - unique.size },
    });
  if (
    findings.some(
      (finding) => finding.code.startsWith("internal_") ||
        finding.code === "answer_likely_truncated" ||
        finding.code === "structured_result_unobserved_evidence" ||
        finding.code === "structured_fact_assertion_mismatch" ||
        finding.code === "confirmed_memory_not_observed",
    )
  )
    return result("answer_quality", label, "fail", findings);
  return result(
    "answer_quality",
    label,
    findings.length ? "needs_review" : "pass",
    findings,
  );
}

function evaluateKnowledge(
  input: AgentEvalRunInput,
  profile: AgentEvalProfile,
  label: string,
): { dimension: AgentEvalDimensionResult; searches: number; evidence: number } {
  const messages = input.runtimeMessages.filter(
    (message): message is Extract<RuntimeMessage, { role: "tool" }> =>
      message.role === "tool" && message.toolName === "crm_search_knowledge",
  );
  const successful = messages.filter((message) => !message.isError);
  const evidence = successful.reduce(
    (sum, message) => sum + evidenceCount(parseStructuredToolResult(message)),
    0,
  );
  if (messages.length === 0) {
    if (profile.knowledgeUse === "required")
      return {
        dimension: result("knowledge_grounding", label, "fail", [
          {
            code: "knowledge_not_consulted",
            message: "该评测配置要求检索知识，但运行没有调用知识工具。",
          },
        ]),
        searches: 0,
        evidence: 0,
      };
    return {
      dimension: result("knowledge_grounding", label, "not_run", [
        {
          code: "knowledge_not_needed_or_not_used",
          message: "本次运行未调用知识检索；语义 Judge 可进一步判断是否本应调用。",
        },
      ]),
      searches: 0,
      evidence: 0,
    };
  }
  if (successful.length === 0)
    return {
      dimension: result("knowledge_grounding", label, "fail", [
        { code: "knowledge_search_failed", message: "知识检索已调用，但没有成功结果。" },
      ]),
      searches: messages.length,
      evidence: 0,
    };
  if (evidence === 0)
    return {
      dimension: result("knowledge_grounding", label, "needs_review", [
        { code: "knowledge_evidence_empty", message: "知识检索成功，但没有返回可引用证据。" },
      ]),
      searches: messages.length,
      evidence: 0,
    };
  return {
    dimension: result("knowledge_grounding", label, "pass", []),
    searches: messages.length,
    evidence,
  };
}

function evaluateReliability(input: AgentEvalRunInput, label: string) {
  const completed = input.events.filter((event) => event.eventType === "tool_completed");
  const errors = completed.filter((event) => event.payload.status === "error");
  const started = input.events.filter((event) => event.eventType === "tool_started");
  const findings: AgentEvalFinding[] = [];
  if (errors.length)
    findings.push({
      code: "tool_errors",
      message: `${errors.length} 次工具调用失败。`,
      evidence: { count: errors.length },
    });
  if (started.length > completed.length)
    findings.push({
      code: "tool_completion_missing",
      message: "存在开始后没有完成事件的工具调用。",
      evidence: { started: started.length, completed: completed.length },
    });
  return {
    dimension: result("tool_reliability", label, findings.length ? "fail" : "pass", findings),
    calls: completed.length,
    errors: errors.length,
  };
}

function evaluatePolicy(input: AgentEvalRunInput, label: string): AgentEvalDimensionResult {
  const findings: AgentEvalFinding[] = [];
  for (const proposal of input.proposals) {
    const effect = workbenchToolEffect(proposal.toolName)?.effect;
    if (!effect) {
      findings.push({
        code: "tool_effect_unclassified",
        message: `${proposal.toolName} 没有工具效果分类。`,
      });
      continue;
    }
    const proposed = eventSequence(input, "tool_proposed", proposal.id);
    const checked = eventSequence(input, "policy_checked", proposal.id);
    const started = eventSequence(input, "tool_started", proposal.id);
    if (proposed === null || checked === null || (started !== null && checked > started))
      findings.push({
        code: "policy_order_invalid",
        message: `${proposal.toolName} 的提案/策略/执行事件顺序不完整。`,
      });
    if (input.mode === "inspect" && started !== null)
      findings.push({ code: "inspect_side_effect", message: "只读运行出现了写入或外部动作执行。" });
    if ((effect === "external" || effect === "irreversible") && started !== null) {
      const approved = input.events.find(
        (event) =>
          event.eventType === "human_confirmation_received" &&
          event.payload.proposalId === proposal.id &&
          event.payload.decision === "approve",
      );
      if (!approved || approved.sequence > started)
        findings.push({
          code: "confirmation_missing",
          message: `${proposal.toolName} 在人工批准前执行。`,
        });
    }
  }
  return result("policy_compliance", label, findings.length ? "fail" : "pass", findings);
}

function evaluateEfficiency(
  input: AgentEvalRunInput,
  profile: AgentEvalProfile,
  label: string,
  toolCalls: number,
) {
  if (toolCalls <= profile.maxToolCalls) return result("efficiency", label, "pass", []);
  return result("efficiency", label, "needs_review", [
    {
      code: "tool_budget_high",
      message: `工具调用 ${toolCalls} 次，超过评测建议上限 ${profile.maxToolCalls} 次。`,
      evidence: { toolCalls, maxToolCalls: profile.maxToolCalls },
    },
  ]);
}

function evaluateCollaboration(
  input: AgentEvalRunInput,
  profile: AgentEvalProfile,
  label: string,
): { dimension: AgentEvalDimensionResult; runs: number; failures: number; claims: number } {
  const started = input.events.find((event) => event.eventType === "collaboration_started");
  const completed = input.events.find((event) => event.eventType === "collaboration_completed");
  const runs = input.collaborationRuns ?? [];
  if (!started && runs.length === 0)
    return {
      dimension: result("collaboration_quality", label, "not_run", [
        {
          code:
            profile.collaborationUse === "conditional"
              ? "collaboration_not_triggered"
              : "collaboration_not_applicable",
          message: "本次运行没有触发 specialist 协作。",
        },
      ]),
      runs: 0,
      failures: 0,
      claims: 0,
    };
  const findings: AgentEvalFinding[] = [];
  const expected =
    typeof started?.payload.specialistCount === "number"
      ? started.payload.specialistCount
      : null;
  if (!started)
    findings.push({ code: "collaboration_start_missing", message: "存在子运行但缺少协作开始事件。" });
  if (!completed)
    findings.push({ code: "collaboration_completion_missing", message: "协作没有完成事件。" });
  if (expected !== null && expected !== runs.length)
    findings.push({
      code: "specialist_count_mismatch",
      message: `预期 ${expected} 个 specialist，实际持久化 ${runs.length} 个。`,
      evidence: { expected, actual: runs.length },
    });
  const failures = runs.filter((run) => run.status === "failed" || run.status === "cancelled");
  const partial = runs.filter((run) => run.status === "partial");
  const unfinished = runs.filter((run) => ["queued", "running"].includes(run.status));
  const conflicts = input.events.filter((event) => event.eventType === "collaboration_conflict");
  const claimless = runs.filter(
    (run) =>
      (run.status === "completed" || run.status === "partial") &&
      (run.evidenceCount ?? 0) > 0 &&
      (run.claimCount ?? 0) === 0,
  );
  if (failures.length)
    findings.push({
      code: "specialist_failures",
      message: `${failures.length} 个 specialist 失败或取消。`,
      evidence: { count: failures.length },
    });
  if (partial.length)
    findings.push({
      code: "specialist_partial_results",
      message: `${partial.length} 个 specialist 只形成部分结果。`,
      evidence: { count: partial.length },
    });
  if (unfinished.length)
    findings.push({
      code: "specialist_unfinished",
      message: "父运行结束时仍有 specialist 未进入终态。",
      evidence: { count: unfinished.length },
    });
  if (conflicts.length)
    findings.push({
      code: "collaboration_conflicts",
      message: `${conflicts.length} 个 specialist 冲突需要复核。`,
      evidence: { count: conflicts.length },
    });
  if (claimless.length)
    findings.push({
      code: "specialist_claims_missing",
      message: `${claimless.length} 个 specialist 有证据但没有结构化 claims，无法可靠检测字段冲突。`,
      evidence: { count: claimless.length },
    });
  const hardFailure = !started || !completed || unfinished.length > 0 || expected !== runs.length;
  return {
    dimension: result(
      "collaboration_quality",
      label,
      hardFailure ? "fail" : findings.length ? "needs_review" : "pass",
      findings,
    ),
    runs: runs.length,
    failures: failures.length,
    claims: runs.reduce((sum, run) => sum + (run.claimCount ?? 0), 0),
  };
}

/** Pure deterministic gates; no model, database, network, or Pi dependency. */
export function evaluateAgentRun(
  input: AgentEvalRunInput,
  profile: AgentEvalProfile,
): AgentEvalReport {
  const criterion = (key: AgentEvalDimensionKey) =>
    profile.criteria.find((item) => item.key === key)!;
  const completion = evaluateCompletion(input, criterion("task_completion").label);
  const answer = evaluateAnswerQuality(input, criterion("answer_quality").label);
  const knowledge = evaluateKnowledge(input, profile, criterion("knowledge_grounding").label);
  const reliability = evaluateReliability(input, criterion("tool_reliability").label);
  const policy = evaluatePolicy(input, criterion("policy_compliance").label);
  const efficiency = evaluateEfficiency(
    input,
    profile,
    criterion("efficiency").label,
    reliability.calls,
  );
  const collaboration = evaluateCollaboration(
    input,
    profile,
    criterion("collaboration_quality").label,
  );
  const byKey = new Map(
    [
      completion,
      answer,
      knowledge.dimension,
      reliability.dimension,
      policy,
      efficiency,
      collaboration.dimension,
    ].map((item) => [item.key, item]),
  );
  const dimensions = profile.criteria.map((item) => byKey.get(item.key)!);
  const scored = profile.criteria.flatMap((item) => {
    const dimension = byKey.get(item.key)!;
    return dimension.score === null ? [] : [{ value: dimension.score, weight: item.weight }];
  });
  const weight = scored.reduce((sum, item) => sum + item.weight, 0);
  const score = weight
    ? Math.round(scored.reduce((sum, item) => sum + item.value * item.weight, 0) / weight)
    : null;
  const requiredFailed = profile.criteria.some(
    (item) => item.required && byKey.get(item.key)?.verdict === "fail",
  );
  const completionPending = completion.verdict === "not_run";
  const review = dimensions.some((item) => item.verdict === "needs_review");
  const ran = dimensions.some((item) => item.verdict !== "not_run");
  return {
    runId: input.runId,
    profileKey: profile.key,
    profileRevision: profile.revision,
    verdict:
      !ran || completionPending
        ? "not_run"
        : requiredFailed
          ? "fail"
          : review
            ? "needs_review"
            : "pass",
    score,
    dimensions,
    summary: {
      toolCalls: reliability.calls,
      toolErrors: reliability.errors,
      knowledgeSearches: knowledge.searches,
      groundedEvidenceItems: knowledge.evidence,
      specialistRuns: collaboration.runs,
      specialistFailures: collaboration.failures,
      structuredClaims: collaboration.claims,
    },
    semanticJudge: { status: "not_configured" },
  };
}
