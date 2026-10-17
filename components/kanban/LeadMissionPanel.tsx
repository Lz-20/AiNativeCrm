"use client";

import { useEffect, useRef, useState } from "react";
import { randomId } from "@/lib/random-id";
import { MissionExplicitOfferPanel } from "./MissionExplicitOfferPanel";

type Mission = {
  id: string;
  goal: string;
  acceptance_criteria: string;
  current_direction?: string | null;
  direction_revision?: number;
  direction_consumed_revision?: number;
  status: string;
  blocked_reason: string | null;
  resolution_reason: string | null;
  customer_send_paused?: boolean;
  latest_run_id: string | null;
  latest_question_status?: "pending" | "sent" | "needs_review" | "expired" | null;
};

type MissionEvaluation = {
  verdict: "in_progress" | "needs_review" | "human_attested" | "policy_failed";
  businessOutcomeVerified: false;
  observableConditionsMet: boolean | null;
  observableChecks: Array<{
    kind: "lead_status" | "customer_inbound_after_verified_send";
    verdict: "met" | "unmet" | "unverified";
    reason: string;
  }>;
  summary: {
    rootRuns: number;
    failedOrPartialRuns: number;
    specialistRuns: number;
    failedOrPartialSpecialists: number;
    crmChangesObserved: number;
    crmChangeEvidenceConflicts: number;
    crmChangesUnverified: number;
    externalProposalsApproved: number;
    customerMessagesSent: number;
    customerMessagesNotSent: number;
    customerDeliveryEvidenceConflicts: number;
    customerRepliesObserved: number;
    pendingApprovals: number;
    customerTouchRisk: boolean;
    budget: {
      usedTokens: number;
      maxTotalTokens: number;
      usedCostCents: number;
      maxTotalCostCents: number;
      unknownCostCalls: number;
    };
  };
  findings: Array<{ code: string }>;
  customerDeliveries: Array<{
    proposalId: string;
    messageId: string | null;
    verdict: "verified" | "unverified" | "conflict";
    reason: string;
  }>;
  customerReplies: Array<{
    proposalId: string;
    inboundMessageId: string | null;
    verdict: "observed" | "not_observed" | "unverified" | "conflict";
  }>;
  structuredOffer: {
    offerId: string | null;
    verdict: "not_issued" | "not_sent" | "awaiting_reply" | "unverified" |
      "verified" | "expired" | "superseded" | "conflict";
    reason: string;
    terms: { description: string; amountMinor: number; currency: string;
      deliveryDate: string } | null;
    outboundMessageId: string | null;
    inboundMessageId: string | null;
    structuredTermsAccepted: boolean;
  };
};

type CustomerAcceptanceAssessment = {
  verdict: "supported" | "contradicted" | "ambiguous" | "insufficient";
  rationale?: string;
  reason?: string;
  businessOutcomeVerified: false;
  evidence: Array<{ messageId: string; quote: string; stance: "accepts" | "rejects" | "qualifies" }>;
  missingTerms?: string[];
};

type FeishuRecipient = { user_id: string; full_name: string | null };
type SendPolicyCommand = {
  id: number;
  kind: "pause_customer_send" | "resume_customer_send";
  reason: string;
  created_at: string;
};

const VERDICT_LABEL: Record<MissionEvaluation["verdict"], string> = {
  in_progress: "仍在推进",
  needs_review: "需要复核",
  human_attested: "已由人工确认，尚未独立核验",
  policy_failed: "策略证据异常",
};

const STATUS_LABEL: Record<string, string> = {
  queued: "待执行",
  running: "执行中",
  waiting_approval: "等待审批",
  waiting_internal: "等待同事",
  waiting_customer: "等待客户",
  needs_review: "待验收",
  completed: "已由负责人验收",
  cancelled: "已取消",
};

const QUESTION_STATUS_LABEL: Record<string, string> = {
  pending: "飞书问题待发送，尚无送达回执",
  sent: "飞书问题已由渠道接受，回复线程已关联",
  needs_review: "飞书提问需要人工核对发送结果",
  expired: "飞书提问超过自动发送期限，需要人工处理",
};

export function LeadMissionPanel({ leadId, pipelineId, open }: {
  leadId: string;
  pipelineId: string;
  open: boolean;
}) {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [available, setAvailable] = useState(false);
  const [reason, setReason] = useState("");
  const [sendPolicyReason, setSendPolicyReason] = useState("");
  const sendPolicyRequest = useRef<{
    missionId: string; command: "pause_customer_send" | "resume_customer_send";
    reason: string; key: string;
  } | null>(null);
  const [internalResponse, setInternalResponse] = useState("");
  const internalRequest = useRef<{ missionId: string; content: string; key: string } | null>(null);
  const [managerDirection, setManagerDirection] = useState("");
  const directionRequest = useRef<{ missionId: string; direction: string; key: string } | null>(null);
  const [questionMissionId, setQuestionMissionId] = useState<string | null>(null);
  const [questionRecipients, setQuestionRecipients] = useState<FeishuRecipient[]>([]);
  const [questionRecipientId, setQuestionRecipientId] = useState("");
  const [questionText, setQuestionText] = useState("");
  const [questionNotice, setQuestionNotice] = useState("");
  const questionRequest = useRef<{
    missionId: string; recipientUserId: string; question: string; key: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [evaluations, setEvaluations] = useState<Record<string, MissionEvaluation>>({});
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null);
  const [acceptanceAssessments, setAcceptanceAssessments] = useState<Record<string, CustomerAcceptanceAssessment>>({});
  const [assessingId, setAssessingId] = useState<string | null>(null);
  const [commandHistory, setCommandHistory] = useState<Record<string, SendPolicyCommand[]>>({});

  useEffect(() => {
    if (!open) return;
    let active = true;
    let inFlight = false;
    let loaded = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch(`/api/v1/ai/missions?leadId=${encodeURIComponent(leadId)}`);
        if (!response.ok) throw new Error("mission_list_unavailable");
        const body = await response.json();
        if (!active) return;
        loaded = true;
        setAvailable(true);
        setMissions(Array.isArray(body.data) ? body.data as Mission[] : []);
      } catch {
        if (active && !loaded) setAvailable(false);
      } finally {
        inFlight = false;
      }
    };
    void load();
    // The model-consumption receipt is committed by the Worker after a model
    // turn, not by the command POST. Refresh while this panel is visible.
    const timer = setInterval(() => { void load(); }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [leadId, open]);

  if (!available) return null;
  const decide = async (missionId: string, action: "complete" | "wait_for_customer" | "wait_for_internal" | "cancel") => {
    if (reason.trim().length < 5) {
      setError("请写明至少 5 个字符的业务依据。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/missions/${missionId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason: reason.trim() }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "任务状态更新失败");
      setMissions((current) => current.map((mission) =>
        mission.id === missionId ? { ...mission, status: body.data.status, blocked_reason: body.data.blocked_reason, resolution_reason: body.data.resolution_reason } : mission,
      ));
      setReason("");
      setEvaluations((current) => {
        const next = { ...current };
        delete next[missionId];
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务状态更新失败");
    } finally {
      setBusy(false);
    }
  };

  const changeSendPolicy = async (missionId: string, paused: boolean) => {
    const reason = sendPolicyReason.trim();
    if (reason.length < 5 || reason.length > 2000) {
      setError("请填写 5 至 2000 个字符的发送策略原因。");
      return;
    }
    const command = paused ? "pause_customer_send" : "resume_customer_send";
    if (!sendPolicyRequest.current || sendPolicyRequest.current.missionId !== missionId ||
        sendPolicyRequest.current.command !== command || sendPolicyRequest.current.reason !== reason)
      sendPolicyRequest.current = { missionId, command, reason, key: randomId() };
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/missions/${missionId}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, reason, requestKey: sendPolicyRequest.current.key }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "无法更新客户发送策略");
      setMissions((current) => current.map((mission) => mission.id === missionId
        ? { ...mission, customer_send_paused: body.data.customerSendPaused } : mission));
      setSendPolicyReason("");
      sendPolicyRequest.current = null;
      setCommandHistory((current) => {
        const next = { ...current };
        delete next[missionId];
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法更新客户发送策略");
    } finally {
      setBusy(false);
    }
  };

  const loadCommandHistory = async (missionId: string) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/missions/${missionId}/commands`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "无法读取发送策略记录");
      setCommandHistory((current) => ({ ...current,
        [missionId]: Array.isArray(body.data) ? body.data as SendPolicyCommand[] : [] }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取发送策略记录");
    } finally {
      setBusy(false);
    }
  };

  const submitInternalResponse = async (missionId: string) => {
    const content = internalResponse.trim();
    if (content.length < 5 || content.length > 2000) {
      setError("内部补充内容需要 5 至 2000 个字符。");
      return;
    }
    if (!internalRequest.current || internalRequest.current.missionId !== missionId || internalRequest.current.content !== content)
      internalRequest.current = { missionId, content, key: randomId() };
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/missions/${missionId}/internal-response`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": internalRequest.current.key },
        body: JSON.stringify({ content }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "内部补充提交失败");
      setMissions((current) => current.map((mission) =>
        mission.id === missionId ? {
          ...mission,
          status: body.data.missionStatus,
          blocked_reason: null,
          latest_run_id: body.data.runId,
        } : mission,
      ));
      setInternalResponse("");
      internalRequest.current = null;
      setEvaluations((current) => {
        const next = { ...current };
        delete next[missionId];
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "内部补充提交失败");
    } finally {
      setBusy(false);
    }
  };

  const submitManagerDirection = async (missionId: string) => {
    const direction = managerDirection.trim();
    if (direction.length < 5 || direction.length > 2000) {
      setError("补充方向需要 5 至 2000 个字符。");
      return;
    }
    if (!directionRequest.current || directionRequest.current.missionId !== missionId ||
        directionRequest.current.direction !== direction)
      directionRequest.current = { missionId, direction, key: randomId() };
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/missions/${missionId}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": directionRequest.current.key },
        body: JSON.stringify({ direction }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "无法补充任务方向");
      if (body.data.replayed) {
        const current = await fetch(`/api/v1/ai/missions?leadId=${encodeURIComponent(leadId)}`);
        if (current.ok) {
          const fresh = await current.json();
          if (Array.isArray(fresh.data)) setMissions(fresh.data as Mission[]);
        }
      } else setMissions((current) => current.map((mission) => mission.id === missionId
        ? { ...mission, status: body.data.missionStatus, blocked_reason: null,
          current_direction: direction,
          direction_revision: body.data.directionRevision ?? mission.direction_revision,
          latest_run_id: body.data.runId, customer_send_paused: body.data.customerSendPaused } : mission));
      setManagerDirection("");
      directionRequest.current = null;
      setEvaluations((current) => {
        const next = { ...current };
        delete next[missionId];
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法补充任务方向");
    } finally {
      setBusy(false);
    }
  };

  const openQuestionComposer = async (missionId: string) => {
    setBusy(true);
    setError("");
    setQuestionNotice("");
    try {
      const response = await fetch("/api/v1/ai/internal-collaboration/feishu/recipients");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "无法读取飞书同事");
      const data = body.data as { available: boolean; recipients: FeishuRecipient[] };
      if (!data.available || !Array.isArray(data.recipients) || data.recipients.length === 0) {
        setError("尚未配置可用的飞书同事映射；可继续在 CRM 内录入补充信息。");
        return;
      }
      setQuestionRecipients(data.recipients);
      setQuestionRecipientId(data.recipients[0]!.user_id);
      setQuestionMissionId(missionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取飞书同事");
    } finally {
      setBusy(false);
    }
  };

  const submitQuestion = async (missionId: string) => {
    const question = questionText.trim();
    if (!questionRecipientId || question.length < 5 || question.length > 1_000) {
      setError("请选择已绑定的同事，并填写 5 至 1000 个字符的具体问题。");
      return;
    }
    if (!questionRequest.current || questionRequest.current.missionId !== missionId ||
        questionRequest.current.recipientUserId !== questionRecipientId ||
        questionRequest.current.question !== question)
      questionRequest.current = { missionId, recipientUserId: questionRecipientId,
        question, key: randomId() };
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/missions/${missionId}/internal-question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientUserId: questionRecipientId,
          requestKey: questionRequest.current.key, question }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "飞书提问提交失败");
      setQuestionNotice("问题已进入发送队列；请等待发送回执，同事回复后任务才会继续。排队不代表已送达。");
      setMissions((current) => current.map((mission) =>
        mission.id === missionId ? { ...mission, latest_question_status: "pending" } : mission,
      ));
      setQuestionText("");
      setQuestionMissionId(null);
      questionRequest.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "飞书提问提交失败");
    } finally {
      setBusy(false);
    }
  };

  const evaluate = async (missionId: string) => {
    setEvaluatingId(missionId);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/missions/${missionId}/evaluation`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "业务评测失败");
      setEvaluations((current) => ({ ...current, [missionId]: body.data as MissionEvaluation }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "业务评测失败");
    } finally {
      setEvaluatingId(null);
    }
  };

  const assessCustomerAcceptance = async (missionId: string) => {
    setAssessingId(missionId);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/missions/${missionId}/customer-acceptance`, {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "客户答复审查失败");
      setAcceptanceAssessments((current) => ({
        ...current, [missionId]: body.data as CustomerAcceptanceAssessment,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "客户答复审查失败");
    } finally {
      setAssessingId(null);
    }
  };

  return (
    <section className="border-b border-border py-3" data-testid="lead-missions">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">Agent 业务任务</h3>
        <a
          className="text-xs underline underline-offset-2"
          href={`/app/ai/workbench?leadId=${encodeURIComponent(leadId)}&pipelineId=${encodeURIComponent(pipelineId)}`}
        >
          委托新任务
        </a>
      </div>
      {missions.length === 0 && <p className="mt-2 text-xs text-text-muted">这个商机还没有委托任务。</p>}
      <div className="mt-2 space-y-3">
        {missions.map((mission) => {
          const evaluation = evaluations[mission.id];
          const acceptanceAssessment = acceptanceAssessments[mission.id];
          const history = commandHistory[mission.id];
          return (
          <article key={mission.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{mission.goal}</span>
              <span className="shrink-0 text-xs text-text-muted">{STATUS_LABEL[mission.status] ?? mission.status}</span>
            </div>
            <p className="mt-1 text-xs text-text-muted">验收：{mission.acceptance_criteria}</p>
            {mission.current_direction && <p className="mt-1 text-xs text-text-muted">负责人方向：{mission.current_direction}</p>}
            {mission.current_direction && typeof mission.direction_revision === "number" && (
              <p className="mt-1 text-xs text-text-muted">
                {typeof mission.direction_consumed_revision === "number" &&
                  mission.direction_consumed_revision >= mission.direction_revision
                  ? "新方向已由模型读取（不等于业务完成）"
                  : "新方向已接受，等待模型消费"}
              </p>
            )}
            {mission.blocked_reason && <p className="mt-1 text-xs text-text-muted">当前原因：{mission.blocked_reason}</p>}
            {mission.resolution_reason && <p className="mt-1 text-xs text-text-muted">人工结论：{mission.resolution_reason}</p>}
            {mission.customer_send_paused && <p className="mt-1 text-xs text-destructive">客户发送已暂停；Agent 可继续读取和内部协作，但不能凭旧审批发出消息。</p>}
            <button disabled={busy} onClick={() => void loadCommandHistory(mission.id)}
              className="mt-1 text-xs underline underline-offset-2 disabled:opacity-50">
              查看发送策略记录
            </button>
            {history && (
              <div className="mt-1 space-y-1 text-xs text-text-muted">
                {history.length === 0 && <p>暂无发送策略命令。</p>}
                {history.map((command) => (
                  <p key={command.id}>
                    {command.kind === "pause_customer_send" ? "暂停" : "恢复"}：{command.reason}
                    {command.created_at ? `（${new Date(command.created_at).toLocaleString()}）` : ""}
                  </p>
                ))}
              </div>
            )}
            {mission.latest_question_status && (
              <p className="mt-1 text-xs text-text-muted">
                内部提问：{QUESTION_STATUS_LABEL[mission.latest_question_status] ?? mission.latest_question_status}
              </p>
            )}
            {mission.latest_run_id && (
              <a className="mt-2 block text-xs underline underline-offset-2"
                href={`/app/ai/workbench?run=${encodeURIComponent(mission.latest_run_id)}`}>
                查看最近一次执行
              </a>
            )}
            <MissionExplicitOfferPanel missionId={mission.id} leadId={leadId}
              active={!['completed', 'cancelled'].includes(mission.status)} />
            <button
              disabled={evaluatingId === mission.id}
              onClick={() => void evaluate(mission.id)}
              className="mt-2 text-xs underline underline-offset-2 disabled:opacity-50"
            >
              {evaluatingId === mission.id ? "评测中…" : "查看业务评测"}
            </button>
            <button disabled={assessingId === mission.id}
              onClick={() => void assessCustomerAcceptance(mission.id)}
              className="ml-3 mt-2 text-xs underline underline-offset-2 disabled:opacity-50">
              {assessingId === mission.id ? "审查中…" : "用真实模型审查客户答复（会产生费用）"}
            </button>
            {acceptanceAssessment && (
              <div className="mt-2 rounded-md border border-border p-2 text-xs text-text-muted">
                <p>独立客户答复审查：{{ supported: "有支持性原文", contradicted: "有明确反对原文",
                  ambiguous: "答复含糊或附条件", insufficient: "证据不足" }[acceptanceAssessment.verdict]}。
                  模型判断不是客户身份或合同成立的证明，业务结果仍须负责人核对。</p>
                {acceptanceAssessment.rationale && <p className="mt-1">判断依据：{acceptanceAssessment.rationale}</p>}
                {acceptanceAssessment.reason && <p className="mt-1">原因：{acceptanceAssessment.reason}</p>}
                {acceptanceAssessment.evidence.map((item) => (
                  <p key={item.messageId} className="mt-1 break-words">
                    客户消息 {item.messageId.slice(0, 8)}：「{item.quote}」
                  </p>
                ))}
                {Boolean(acceptanceAssessment.missingTerms?.length) &&
                  <p>未获明确确认：{acceptanceAssessment.missingTerms?.join("；")}</p>}
              </div>
            )}
            {evaluation && (
              <div className="mt-2 rounded-md border border-border p-2 text-xs text-text-muted">
                <p>{VERDICT_LABEL[evaluation.verdict]}；业务结果未由系统独立核验。</p>
                {evaluation.structuredOffer?.offerId && (
                  <p>
                    结构化报价与交期：{evaluation.structuredOffer.verdict === "verified"
                      ? "已核对渠道签名及原样确认，仅证明这版条款获明确回复"
                      : evaluation.structuredOffer.verdict === "unverified"
                        ? "发现同文回复，但缺少可信渠道签名，不能算确认"
                        : evaluation.structuredOffer.verdict === "conflict"
                          ? "报价或确认凭证冲突，需人工核对"
                          : "尚未取得有效的渠道确认"}；不等于完整业务验收。
                    {evaluation.structuredOffer.inboundMessageId &&
                      `（入站消息 ${evaluation.structuredOffer.inboundMessageId.slice(0, 8)}）`}
                  </p>
                )}
                {evaluation.observableChecks.length > 0 && (
                  <div className="mt-1">
                    <p>可观察条件：{evaluation.observableConditionsMet === true ? "全部满足"
                      : evaluation.observableConditionsMet === false ? "存在未满足项" : "证据不完整"}；不等于自由文本业务验收。</p>
                    {evaluation.observableChecks.map((check) => (
                      <p key={check.kind}>
                        {check.kind === "lead_status" ? "商机当前状态" : "发送后同会话入站文本"}：
                        {check.verdict === "met" ? "满足" : check.verdict === "unmet" ? "未满足" : "无法核实"}
                      </p>
                    ))}
                  </div>
                )}
                <p>运行 {evaluation.summary.rootRuns} 次 · specialist {evaluation.summary.specialistRuns} 次 · 与当前商机匹配的 CRM 变更事件 {evaluation.summary.crmChangesObserved} 次</p>
                {evaluation.summary.crmChangeEvidenceConflicts > 0 && (
                  <p className="text-destructive">CRM 变更目标或提案冲突 {evaluation.summary.crmChangeEvidenceConflicts} 次。</p>
                )}
                {evaluation.summary.crmChangesUnverified > 0 && (
                  <p>CRM 变更事件缺少完整执行凭证 {evaluation.summary.crmChangesUnverified} 次，需人工核对。</p>
                )}
                <p>外部提案已执行 {evaluation.summary.externalProposalsApproved} 次 · 已核实发送回执 {evaluation.summary.customerMessagesSent} 次 · 发送未核实 {evaluation.summary.customerMessagesNotSent} 次</p>
                <p>观察到后续入站文本的发送提案 {evaluation.summary.customerRepliesObserved} 个（不证明是针对该消息的回复，更不证明客户接受）</p>
                {evaluation.summary.customerDeliveryEvidenceConflicts > 0 && (
                  <p className="text-destructive">发送凭证冲突 {evaluation.summary.customerDeliveryEvidenceConflicts} 次，需核对原始消息与账本。</p>
                )}
                {evaluation.customerDeliveries.map((delivery) => (
                  <p key={delivery.proposalId}>
                    发送提案 {delivery.proposalId.slice(0, 8)}：
                    {delivery.verdict === "verified" ? "CRM 消息及发送账本已核对；不代表客户已收到或接受"
                      : delivery.verdict === "conflict" ? "凭证冲突" : "尚无完整发送回执"}
                    {delivery.messageId ? `（消息 ${delivery.messageId.slice(0, 8)}）` : ""}
                  </p>
                ))}
                {evaluation.customerReplies.map((reply) => (
                  <p key={reply.proposalId}>
                    后续入站 {reply.proposalId.slice(0, 8)}：
                    {reply.verdict === "observed" ? "已观察到发送后同会话文本"
                      : reply.verdict === "not_observed" ? "未观察到发送后的同会话文本"
                        : reply.verdict === "conflict" ? "消息身份或时间证据冲突"
                          : "发送或入站证据不完整"}
                    {reply.inboundMessageId ? `（消息 ${reply.inboundMessageId.slice(0, 8)}）` : ""}
                  </p>
                ))}
                <p>累计 Token {evaluation.summary.budget.usedTokens}/{evaluation.summary.budget.maxTotalTokens} · 成本 {evaluation.summary.budget.usedCostCents}/{evaluation.summary.budget.maxTotalCostCents} 分</p>
                {evaluation.summary.budget.unknownCostCalls > 0 && <p>存在成本未知的模型调用，自动续跑已关闭。</p>}
                {evaluation.summary.customerTouchRisk && <p>多次客户触达，需核对是否重复。</p>}
                {evaluation.summary.failedOrPartialRuns > 0 && <p>存在失败或部分完成的运行。</p>}
                {evaluation.summary.failedOrPartialSpecialists > 0 && <p>存在失败或部分完成的 specialist。</p>}
              </div>
            )}
            {!['completed', 'cancelled'].includes(mission.status) && (
              <div className="mt-3 space-y-2">
                <div className="space-y-2 rounded-md border border-border p-2">
                  <label htmlFor={`send-policy-reason-${mission.id}`} className="block text-xs font-medium">
                    客户发送策略原因
                  </label>
                  <input id={`send-policy-reason-${mission.id}`} value={sendPolicyReason}
                    onChange={(event) => { setSendPolicyReason(event.target.value); sendPolicyRequest.current = null; }}
                    maxLength={2000} placeholder="例如先核对新的报价，再决定是否发送"
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs" />
                  <button disabled={busy}
                    onClick={() => void changeSendPolicy(mission.id, !mission.customer_send_paused)}
                    className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50">
                    {mission.customer_send_paused ? "恢复客户发送权限" : "暂停客户发送"}
                  </button>
                  <p className="text-xs text-text-muted">暂停会进入发送闸门；已被渠道接受的消息无法撤回。恢复权限不会自动重发或复用失效草稿。</p>
                </div>
                {mission.status === "waiting_internal" && (
                  <div className="space-y-2 rounded-md border border-border p-2">
                    <button disabled={busy} onClick={() => void openQuestionComposer(mission.id)}
                      className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50">
                      向飞书同事提问
                    </button>
                    {questionMissionId === mission.id && (
                      <div className="space-y-2 rounded-md border border-border p-2">
                        <label htmlFor={`question-recipient-${mission.id}`} className="block text-xs font-medium">
                          已绑定的飞书同事
                        </label>
                        <select id={`question-recipient-${mission.id}`} value={questionRecipientId}
                          onChange={(event) => { setQuestionRecipientId(event.target.value); questionRequest.current = null; }}
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs">
                          {questionRecipients.map((recipient) => (
                            <option key={recipient.user_id} value={recipient.user_id}>
                              {recipient.full_name ?? `成员 ${recipient.user_id.slice(0, 8)}`}
                            </option>
                          ))}
                        </select>
                        <label htmlFor={`question-text-${mission.id}`} className="block text-xs font-medium">
                          需要同事核实的问题
                        </label>
                        <textarea id={`question-text-${mission.id}`} value={questionText}
                          onChange={(event) => { setQuestionText(event.target.value); questionRequest.current = null; }}
                          maxLength={1000} rows={3}
                          placeholder="例如请核对 500 件的最早可承诺交期"
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs" />
                        <p className="text-xs text-text-muted">发送给同事是外部动作；提交即表示负责人批准这段确切内容。回复仅作为待核查事实，不是客户报价审批。</p>
                        <button disabled={busy} onClick={() => void submitQuestion(mission.id)}
                          className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50">
                          确认并加入发送队列
                        </button>
                      </div>
                    )}
                    <label htmlFor={`internal-response-${mission.id}`} className="block text-xs font-medium">
                      同事补充的业务信息
                    </label>
                    <textarea
                      id={`internal-response-${mission.id}`}
                      value={internalResponse}
                      onChange={(event) => { setInternalResponse(event.target.value); internalRequest.current = null; }}
                      maxLength={2000}
                      rows={3}
                      placeholder="例如已确认的交期、报价依据或仍缺少的信息"
                      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                    />
                    <p className="text-xs text-text-muted">此处只补充待核查事实，不等于批准报价或向客户发送消息。</p>
                    <button disabled={busy} onClick={() => void submitInternalResponse(mission.id)}
                      className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50">
                      提交补充并继续任务
                    </button>
                  </div>
                )}
                {['queued', 'running', 'needs_review', 'waiting_customer', 'waiting_approval'].includes(mission.status) && (
                  <div className="space-y-2 rounded-md border border-border p-2">
                    <label htmlFor={`manager-direction-${mission.id}`} className="block text-xs font-medium">
                      负责人补充任务方向
                    </label>
                    <textarea id={`manager-direction-${mission.id}`} value={managerDirection}
                      onChange={(event) => { setManagerDirection(event.target.value); directionRequest.current = null; }}
                      maxLength={2000} rows={3}
                      placeholder="例如改用最新报价依据，先核对已执行动作，再提出新方案"
                      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs" />
                    <p className="text-xs text-text-muted">提交会停止旧运行，旧提案会撤销，客户发送会暂停；已完成的动作不会回滚，新运行会重新核对。此文字不批准报价或外发，恢复发送须另行操作。</p>
                    <button disabled={busy} onClick={() => void submitManagerDirection(mission.id)}
                      className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50">
                      保存方向并继续任务
                    </button>
                  </div>
                )}
                <input
                  aria-label="任务验收依据"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="填写本次决定的业务依据"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                />
                <div className="flex gap-2">
                  {mission.status === "needs_review" && (
                    <>
                      <button disabled={busy} onClick={() => void decide(mission.id, "complete")}
                        className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50">
                        人工验收完成
                      </button>
                      <button disabled={busy} onClick={() => void decide(mission.id, "wait_for_customer")}
                        className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50">
                        等待客户新消息
                      </button>
                      <button disabled={busy} onClick={() => void decide(mission.id, "wait_for_internal")}
                        className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50">
                        等待同事补充
                      </button>
                    </>
                  )}
                  <button disabled={busy} onClick={() => void decide(mission.id, "cancel")}
                    className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50">
                    停止自动任务
                  </button>
                </div>
                <p className="text-xs text-text-muted">停止会拦截尚未发送的动作；渠道已接受的消息无法撤回。</p>
              </div>
            )}
          </article>
          );
        })}
      </div>
      {questionNotice && <p role="status" className="mt-2 text-xs text-text-muted">{questionNotice}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}
