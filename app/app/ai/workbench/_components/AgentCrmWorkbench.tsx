"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MissionSendControl } from "./MissionSendControl";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

type Scenario = { title: string; task: string; harnessFocus: string };
type Agent = {
  id: string;
  name: string;
  description: string | null;
  builtinKey: string;
  scenarios: readonly Scenario[];
  knowledgePolicy?: {
    namespaces: readonly string[];
    citationMode: string;
    unavailableBehavior: string;
  };
  evalProfile?: string;
};
type Run = {
  id: string;
  agent_id: string;
  task: string;
  mode: string;
  status: string;
  final_text: string | null;
  error_code: string | null;
  created_at: string;
};
type EventRow = {
  id: string;
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};
type Proposal = {
  id: string;
  sequence: number;
  tool_name: string;
  status: string;
  preview: Record<string, unknown>;
  result_summary?: Record<string, unknown> | null;
  draft_body?: string;
  can_undo?: boolean;
};
type Detail = Run & {
  result_document?: {
    revision: number;
    trust: "model_submitted";
    summary: string;
    evidence: Array<{ sourceType: string; sourceId: string; claim: string }>;
    missingInformation: string[];
    nextStep: string;
    wakeCondition: string;
  } | null;
  mission?: {
    id: string;
    lead_id: string;
    goal: string;
    acceptance_criteria: string;
    customer_send_paused: boolean;
    acceptance_contract: {
      revision: 1;
      checks: Array<
        | { kind: "lead_status"; equals: "open" | "won" | "lost" }
        | { kind: "customer_inbound_after_verified_send" }
      >;
    } | null;
    status: string;
    blocked_reason: string | null;
    deadline_at: string | null;
  } | null;
  events: EventRow[];
  proposals: Proposal[];
  specialists: Array<{
    id: string;
    specialist_key: string | null;
    collaboration_key: string | null;
    status: string;
    error_code: string | null;
  }>;
  usage?: { inputTokens: number; outputTokens: number; costCents: number; calls: number };
  evaluation?: EvaluationReport;
  evaluationError?: string;
  observed_evidence?: Array<{
    id: string;
    namespace: string;
    title: string;
    excerpt: string;
    source_id: string;
    revision: string | null;
    revision_kind: string;
    index_status: string | null;
    uri: string | null;
    position?: number;
  }>;
};
type EvaluationReport = {
  savedSemanticEvaluation?: EvaluationReport | null;
  verdict: "pass" | "fail" | "needs_review" | "not_run";
  score: number | null;
  profileKey: string;
  dimensions: Array<{
    key: string;
    label: string;
    verdict: string;
    score: number | null;
    findings: Array<{ code: string; message: string }>;
  }>;
  summary: {
    toolCalls: number;
    toolErrors: number;
    knowledgeSearches: number;
    groundedEvidenceItems: number;
    specialistRuns: number;
    specialistFailures: number;
    structuredClaims: number;
  };
  semanticJudge: {
    status: string;
    verdict?: string;
    score?: number;
    findings?: Array<{ code: string; message: string }>;
  };
};
type ObjectKind = "contact" | "lead" | "conversation" | "pipeline";
type Scope = { contactId?: string; leadId?: string; conversationId?: string; pipelineId?: string };
type ScopeOption = {
  id: string;
  label: string;
  detail?: string | null;
  pipelineId?: string;
  contactId?: string | null;
};

const EVENT_LABELS: Record<string, string> = {
  run_started: "任务开始",
  context_loaded: "CRM 上下文已加载",
  model_decision: "Agent 已完成决策",
  tool_proposed: "提出 CRM 操作",
  policy_checked: "策略检查通过",
  tool_started: "工具开始执行",
  tool_completed: "工具执行结束",
  crm_state_changed: "CRM 状态已变化",
  human_confirmation_requested: "等待人工确认",
  human_confirmation_received: "收到人工决策",
  run_resumed: "运行已恢复",
  run_completed: "运行完成",
  run_partial: "部分完成",
  run_failed: "运行失败",
  run_cancelled: "运行已取消",
  collaboration_started: "多 Agent 审查开始",
  specialist_started: "只读 Specialist 开始",
  specialist_completed: "只读 Specialist 完成",
  specialist_failed: "只读 Specialist 失败",
  collaboration_conflict: "Specialist 证据冲突",
  collaboration_completed: "多 Agent 审查完成",
  usage_reported: "用量已记录",
};

const TOOL_LABELS: Record<string, string> = {
  crm_request_human_handoff: "请求转交人工",
  crm_update_lead: "更新商机字段",
  crm_schedule_followup: "安排客户跟进",
  send_message: "发送客户回复",
  ask_internal_colleague: "向飞书同事提问",
};

function eventLabel(event: EventRow): string {
  if (event.event_type === "policy_checked") {
    const verdict = event.payload.verdict ?? event.payload.decision;
    if (verdict === "veto") return "发送策略拦截";
    if (verdict === "pass") return "发送策略允许";
    if (verdict === "skipped") return "发送策略跳过此项";
    if (verdict === "requires_human_confirmation") return "此 CRM 操作需要人工确认";
    if (verdict === "allowed_reversible_write") return "允许自动执行可逆写入";
  }
  return EVENT_LABELS[event.event_type] ?? event.event_type;
}

const fetchEvaluation = async (
  runId: string,
): Promise<Pick<Detail, "evaluation" | "evaluationError">> => {
  try {
    const response = await fetch(`/api/v1/ai/workbench/runs/${runId}/evaluation`);
    const body = await response.json();
    if (!response.ok)
      return {
        evaluation: undefined,
        evaluationError: body.error?.message ?? "无法读取评测，请重试。",
      };
    return { evaluation: body.data ?? undefined, evaluationError: undefined };
  } catch {
    return { evaluation: undefined, evaluationError: "无法读取评测，请检查连接后重试。" };
  }
};
const fetchDetail = async (runId: string): Promise<Detail> => {
  const [detailResponse, evaluation] = await Promise.all([
    fetch(`/api/v1/ai/workbench/runs/${runId}`),
    fetchEvaluation(runId),
  ]);
  const detailBody = await detailResponse.json();
  if (!detailResponse.ok) throw new Error(detailBody.error?.message ?? "无法读取运行详情");
  return {
    ...detailBody.data,
    ...evaluation,
  };
};

export function AgentCrmWorkbench({
  agents,
  modelConfigured,
  canCopy,
  initialLead,
}: {
  agents: Agent[];
  modelConfigured: boolean;
  canCopy: boolean;
  initialLead?: { id: string; title: string; pipelineId: string } | null;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [task, setTask] = useState("");
  const [mode, setMode] = useState<"inspect" | "act">(initialLead ? "act" : "inspect");
  const [delegateMission, setDelegateMission] = useState(Boolean(initialLead));
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [observableLeadStatus, setObservableLeadStatus] = useState<"" | "open" | "won" | "lost">(
    "",
  );
  const [requireCustomerInbound, setRequireCustomerInbound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<"settings" | "details" | null>(null);
  const [previousTurns, setPreviousTurns] = useState<Detail[]>([]);
  const [submittedTask, setSubmittedTask] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const lastPanel = useRef<"settings" | "details">("settings");
  const messagesRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const cancellingRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const readingHistory = useRef(0);
  const evaluationRequest = useRef<{ runId: string; selection: number } | null>(null);
  const [readingEvaluation, setReadingEvaluation] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [evalExportNotice, setEvalExportNotice] = useState<{ runId: string; text: string } | null>(
    null,
  );
  const [detail, setDetail] = useState<Detail | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [objectKind, setObjectKind] = useState<ObjectKind>(initialLead ? "lead" : "contact");
  const [objectQuery, setObjectQuery] = useState("");
  const [objectOptions, setObjectOptions] = useState<ScopeOption[]>([]);
  const [scope, setScope] = useState<Scope>(
    initialLead ? { leadId: initialLead.id, pipelineId: initialLead.pipelineId } : {},
  );
  const [scopeLabel, setScopeLabel] = useState(initialLead?.title ?? "");
  const selected = agents.find((agent) => agent.id === agentId) ?? agents[0];
  const canDelegateMission = mode === "act" && Boolean(scope.leadId);
  const missionEnabled = canDelegateMission && delegateMission;

  const fetchRuns = async (): Promise<Run[]> => {
    const response = await fetch("/api/v1/ai/workbench/runs");
    const body = await response.json();
    return response.ok && Array.isArray(body.data) ? body.data : [];
  };
  const retryEvaluation = async () => {
    if (
      !detail ||
      busy ||
      cancelling ||
      !["completed", "partial", "failed", "cancelled"].includes(detail.status)
    )
      return;
    const runId = detail.id;
    const selection = readingHistory.current;
    if (
      evaluationRequest.current?.runId === runId &&
      evaluationRequest.current.selection === selection
    )
      return;
    const request = { runId, selection };
    evaluationRequest.current = request;
    setReadingEvaluation(runId);
    setEvalExportNotice(null);
    const evaluation = await fetchEvaluation(runId);
    if (evaluationRequest.current !== request) return;
    evaluationRequest.current = null;
    setReadingEvaluation(null);
    if (readingHistory.current !== selection) return;
    // Only replace this read's evaluation, never a newer run result or status.
    setDetail((current) => (current?.id === runId ? { ...current, ...evaluation } : current));
  };
  const loadRuns = async () => setRuns(await fetchRuns());
  useEffect(() => {
    let active = true;
    void fetchRuns()
      .then((initialRuns) => {
        if (active) setRuns(initialRuns);
      })
      .catch(() => {
        if (active) setError("无法读取最近运行，请刷新重试。");
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const runId = new URLSearchParams(window.location.search).get("run");
    if (!runId) return;
    const request = ++readingHistory.current;
    let active = true;
    void fetchDetail(runId)
      .then((loaded) => {
        if (active && request === readingHistory.current) setDetail(loaded);
      })
      .catch((cause) => {
        if (active && request === readingHistory.current)
          setError(cause instanceof Error ? cause.message : "无法读取运行详情");
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void fetch(
        `/api/v1/ai/workbench/objects?kind=${objectKind}&q=${encodeURIComponent(objectQuery)}`,
      )
        .then((response) => response.json())
        .then((body) => {
          if (active) setObjectOptions(body.data ?? []);
        })
        .catch(() => {
          if (active) setObjectOptions([]);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [objectKind, objectQuery]);

  const chooseScope = (item: ScopeOption) => {
    const next: Scope =
      objectKind === "contact"
        ? { contactId: item.id }
        : objectKind === "lead"
          ? { leadId: item.id, ...(item.pipelineId ? { pipelineId: item.pipelineId } : {}) }
          : objectKind === "conversation"
            ? { conversationId: item.id, ...(item.contactId ? { contactId: item.contactId } : {}) }
            : { pipelineId: item.id };
    setScope(next);
    setScopeLabel(item.label);
    setObjectOptions([]);
  };

  const run = async () => {
    if (busyRef.current || !selected || !task.trim() || !modelConfigured) return;
    if (missionEnabled && !acceptanceCriteria.trim()) {
      openPanel("settings");
      setError("委托商机任务需要选择商机、分级自治模式，并填写业务验收条件。");
      return;
    }
    readingHistory.current += 1;
    busyRef.current = true;
    setBusy(true);
    setPanel(null);
    setError("");
    setSubmittedTask(task.trim());
    if (detail) setPreviousTurns((turns) => [...turns, detail]);
    setDetail(null);
    const observableChecks = [
      ...(observableLeadStatus
        ? [{ kind: "lead_status" as const, equals: observableLeadStatus }]
        : []),
      ...(requireCustomerInbound
        ? [{ kind: "customer_inbound_after_verified_send" as const }]
        : []),
    ];
    try {
      const response = await fetch("/api/v1/ai/workbench/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: selected.id,
          task,
          mode,
          ...(Object.keys(scope).length ? { scope } : {}),
          ...(missionEnabled
            ? {
                mission: {
                  goal: task.trim(),
                  acceptanceCriteria: acceptanceCriteria.trim(),
                  ...(observableChecks.length
                    ? { acceptanceContract: { revision: 1, checks: observableChecks } }
                    : {}),
                },
              }
            : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "运行失败");
      const runId = body.data.run_id as string;
      // The server acknowledged a durable queued run. Retain its identity before
      // reading details, so a temporary read/stream failure cannot invite a
      // duplicate submission and the existing lifecycle refresh can recover it.
      setDetail({
        id: runId,
        agent_id: selected.id,
        task,
        mode,
        status: "queued",
        final_text: null,
        error_code: null,
        created_at: new Date().toISOString(),
        events: [],
        proposals: [],
        specialists: [],
      });
      setTask("");
      setDelegateMission(false);
      setAcceptanceCriteria("");
      setObservableLeadStatus("");
      setRequireCustomerInbound(false);
      const initialDetail = await fetchDetail(runId);
      setDetail(initialDetail);
      await streamRunEvents(runId, initialDetail.events ?? [], initialDetail.status);
      const [finalDetail] = await Promise.all([fetchDetail(runId), loadRuns()]);
      setDetail(finalDetail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "运行失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const streamRunEvents = async (
    runId: string,
    initialEvents: EventRow[],
    initialStatus: string,
  ) => {
    let sequence = initialEvents.reduce((max, event) => Math.max(max, event.sequence), 0);
    // The worker can finish before the first detail request reaches the browser.
    // In that case the initial event page already contains the terminal event;
    // starting the stream at its last sequence would otherwise wait forever for
    // a terminal event that has intentionally been skipped during replay.
    let status = initialStatus;
    while (
      !["completed", "partial", "failed", "cancelled", "awaiting_confirmation"].includes(status)
    ) {
      const response = await fetch(`/api/v1/ai/workbench/runs/${runId}/events?after=${sequence}`);
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(6)) as EventRow;
            if (!event.sequence || event.sequence <= sequence) continue;
            sequence = event.sequence;
            setDetail((current) =>
              current?.id === runId ? { ...current, events: [...current.events, event] } : current,
            );
            if (
              ["run_completed", "run_partial", "run_failed", "run_cancelled"].includes(
                event.event_type,
              )
            ) {
              status =
                event.event_type === "run_completed"
                  ? "completed"
                  : event.event_type === "run_partial"
                    ? "partial"
                    : event.event_type === "run_failed"
                      ? "failed"
                      : "cancelled";
            }
          } catch {
            /* 忽略心跳与不完整片段，下一块继续解析。 */
          }
        }
      }
      if (status === "running" || status === "queued") {
        const latest = await fetch(`/api/v1/ai/workbench/runs/${runId}`).then((r) => r.json());
        status = latest.data?.status ?? "failed";
      }
    }
  };

  const cancelRun = async () => {
    if (!detail || cancellingRef.current) return;
    const runId = detail.id;
    cancellingRef.current = true;
    setCancelling(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/workbench/runs/${runId}/cancel`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          const current = await fetchDetail(runId);
          setDetail((selectedRun) => (selectedRun?.id === runId ? current : selectedRun));
        }
        throw new Error(body.error?.message ?? "取消失败");
      }
      const updated = await fetchDetail(runId);
      setDetail((current) => (current?.id === runId ? updated : current));
      await loadRuns();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消失败");
    } finally {
      cancellingRef.current = false;
      setCancelling(false);
    }
  };

  const runSemanticJudge = async (mode = "semantic") => {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/ai/workbench/runs/${detail.id}/evaluation${mode === "semantic" ? "" : "?mode=deterministic_export"}`,
        {
          method: "POST",
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "评测操作失败");
      if (mode === "deterministic_export")
        setEvalExportNotice({
          runId: detail.id,
          text: "确定性评测已保存；Langfuse 启用时会排队投递，不消耗额外模型额度。",
        });
      setDetail((current) =>
        current?.id === detail.id
          ? { ...current, evaluation: body.data, evaluationError: undefined }
          : current,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "语义 Judge 运行失败");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (proposalId: string, decision: "approve" | "reject") => {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/ai/workbench/runs/${detail.id}/proposals/${proposalId}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "决策失败");
      const updated = await fetchDetail(detail.id);
      setDetail(updated);
      if (body.data?.run_status === "running") {
        await streamRunEvents(detail.id, updated.events ?? [], updated.status);
        setDetail(await fetchDetail(detail.id));
      }
      await loadRuns();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "决策失败");
    } finally {
      setBusy(false);
    }
  };

  const undo = async (proposalId: string) => {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/ai/workbench/runs/${detail.id}/proposals/${proposalId}/undo`,
        { method: "POST" },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "撤销失败");
      setDetail(await fetchDetail(detail.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "撤销失败");
    } finally {
      setBusy(false);
    }
  };

  const copyBuiltin = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/ai/agents/${selected.id}/copy-builtin`, {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "复制 Agent 失败");
      window.location.assign(`/app/ai/agents/${body.data.agent.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "复制 Agent 失败");
    } finally {
      setBusy(false);
    }
  };

  const pending = useMemo(
    () => detail?.proposals.filter((proposal) => proposal.status === "pending") ?? [],
    [detail],
  );

  const activeRun = Boolean(
    detail && ["queued", "running", "awaiting_confirmation"].includes(detail.status),
  );
  const cannotStart = busy || activeRun;
  const displayedTask = detail?.task || submittedTask;
  const latestEvent = detail?.events.at(-1);

  useEffect(() => {
    const messages = messagesRef.current;
    if (messages) messages.scrollTop = messages.scrollHeight;
  }, [detail?.id, detail?.status, detail?.final_text, submittedTask, previousTurns.length]);

  useEffect(() => {
    const runId = detail?.id;
    if (
      !runId ||
      busy ||
      cancelling ||
      !["queued", "running", "awaiting_confirmation"].includes(detail.status)
    )
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const loaded = await fetchDetail(runId);
        if (active) {
          setDetail((current) => (current?.id === runId ? loaded : current));
          setRuns((current) =>
            current.some((run) => run.id === runId)
              ? current.map((run) => (run.id === runId ? loaded : run))
              : [loaded, ...current].sort((a, b) => b.created_at.localeCompare(a.created_at)),
          );
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "无法刷新运行状态");
      } finally {
        // Serial requests prevent a slow older snapshot overwriting a newer one.
        if (active) timer = setTimeout(() => void refresh(), 2_000);
      }
    };
    timer = setTimeout(() => void refresh(), 2_000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [detail?.id, detail?.status, busy, cancelling]);

  const openPanel = (next: "settings" | "details") => {
    lastPanel.current = next;
    setPanel(next);
  };

  const resetConversation = () => {
    if (cannotStart) return;
    readingHistory.current += 1;
    evaluationRequest.current = null;
    setReadingEvaluation(null);
    setDetail(null);
    setPreviousTurns([]);
    setSubmittedTask("");
    setTask("");
    setError("");
    setMode("inspect");
    setDelegateMission(false);
    setAcceptanceCriteria("");
    setObservableLeadStatus("");
    setRequireCustomerInbound(false);
    setPanel(null);
    composerRef.current?.focus();
  };

  const openHistory = async (runId: string) => {
    if (cannotStart) return;
    const request = ++readingHistory.current;
    evaluationRequest.current = null;
    setReadingEvaluation(null);
    setError("");
    try {
      const loaded = await fetchDetail(runId);
      if (request !== readingHistory.current) return;
      setDetail(loaded);
      setPreviousTurns([]);
      setSubmittedTask("");
      setTask("");
      setPanel(null);
    } catch (cause) {
      if (request === readingHistory.current)
        setError(cause instanceof Error ? cause.message : "无法读取运行详情");
    }
  };

  return (
    <div
      data-agent-workbench
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b p-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label htmlFor="agent-picker" className="sr-only">
            内置 Agent
          </label>
          <select
            id="agent-picker"
            value={agentId}
            disabled={cannotStart}
            onChange={(event) => {
              resetConversation();
              setAgentId(event.target.value);
            }}
            className="max-w-full rounded-md border bg-background px-2 py-2 text-sm font-medium"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <span
            className="max-w-40 truncate text-xs text-muted-foreground"
            title={scopeLabel || "当前组织"}
          >
            {scopeLabel || "当前组织"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            ref={settingsButtonRef}
            onClick={() => openPanel("settings")}
            className="min-h-11 rounded-md px-3 py-2 text-sm hover:bg-muted lg:min-h-9"
          >
            任务设置
          </button>
          <button
            ref={detailsButtonRef}
            onClick={() => openPanel("details")}
            className="min-h-11 rounded-md px-3 py-2 text-sm hover:bg-muted lg:min-h-9"
          >
            运行详情{pending.length > 0 ? ` · ${pending.length} 待确认` : ""}
          </button>
          <button
            disabled={cannotStart}
            onClick={resetConversation}
            className="min-h-11 rounded-md border px-3 py-2 text-sm disabled:opacity-50 lg:min-h-9"
          >
            新对话
          </button>
        </div>
      </header>
      <div
        ref={messagesRef}
        role="region"
        aria-label="Agent 对话"
        tabIndex={0}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4 sm:p-6"
      >
        {!detail && !submittedTask && previousTurns.length === 0 && (
          <div className="mx-auto max-w-2xl py-8 sm:py-14">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              今天想推进哪件事？
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {selected?.description || "选择 Agent，输入目标，从真实 CRM 上下文开始。"}
            </p>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {selected?.scenarios.map((scenario) => (
                <button
                  key={scenario.title}
                  onClick={() => {
                    setTask(scenario.task);
                    composerRef.current?.focus();
                  }}
                  className="rounded-lg border border-border bg-surface p-4 text-left text-sm transition-colors hover:bg-muted"
                >
                  <span className="block font-medium">{scenario.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {scenario.harnessFocus}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {previousTurns.map((turn) => (
          <section key={turn.id} className="mx-auto max-w-3xl space-y-3" aria-label="之前的运行">
            <p className="ml-auto w-fit max-w-[90%] rounded-xl bg-muted px-4 py-3 text-sm break-words whitespace-pre-wrap">
              {turn.task}
            </p>
            <article className="rounded-lg bg-surface p-4 text-sm leading-6 break-words whitespace-pre-wrap">
              {turn.final_text || `运行状态：${turn.status}`}
            </article>
          </section>
        ))}
        {displayedTask && (
          <section className="mx-auto max-w-3xl space-y-3" aria-label="当前运行">
            <p className="ml-auto w-fit max-w-[90%] rounded-xl bg-muted px-4 py-3 text-sm break-words whitespace-pre-wrap">
              {displayedTask}
            </p>
            <div role="status" className="text-xs text-muted-foreground">
              {detail
                ? `运行状态：${detail.status}`
                : busy
                  ? "正在提交任务…"
                  : "无法确认运行状态，请先查看最近运行"}
              {latestEvent ? ` · ${eventLabel(latestEvent)}` : ""}
            </div>
            {detail?.final_text && (
              <article className="rounded-lg bg-surface p-4 text-sm leading-6 break-words whitespace-pre-wrap">
                {detail.final_text}
              </article>
            )}
            {detail?.error_code && (
              <p className="text-sm text-destructive">运行错误：{detail.error_code}</p>
            )}
            {detail?.evaluationError && (
              <button
                onClick={() => openPanel("details")}
                className="text-sm text-destructive underline"
              >
                评测暂不可用，查看原因并重试
              </button>
            )}
            {detail?.mission && (
              <p className="text-xs text-muted-foreground">
                业务任务：{detail.mission.status} · Agent 本轮结束不等于业务完成
              </p>
            )}
            {pending.length > 0 && (
              <button
                onClick={() => openPanel("details")}
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm"
              >
                查看 {pending.length} 项待确认动作
              </button>
            )}
          </section>
        )}
      </div>
      <form
        aria-label="发送 Agent 任务"
        className="mx-auto w-full max-w-3xl shrink-0 space-y-3 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!cannotStart) void run();
        }}
      >
        {error && (
          <p
            role="alert"
            className="max-h-20 overflow-auto rounded-md bg-destructive/10 p-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <label htmlFor="run-mode" className="font-medium">
            执行模式
          </label>
          <select
            id="run-mode"
            value={mode}
            disabled={cannotStart}
            onChange={(event) => {
              const nextMode = event.target.value as "inspect" | "act";
              setMode(nextMode);
              if (nextMode !== "act") setDelegateMission(false);
            }}
            className="min-w-0 rounded-md border bg-background px-2 py-1.5"
          >
            <option value="inspect">只读检查</option>
            <option value="act">分级自治（可逆写入自动执行）</option>
          </select>
          {missionEnabled && (
            <button type="button" onClick={() => openPanel("settings")} className="underline">
              已启用商机业务任务
            </button>
          )}
        </div>
        <div className="flex items-end gap-2 rounded-xl border border-border bg-surface p-2 shadow-sm focus-within:border-border-strong">
          <label htmlFor="agent-task" className="sr-only">
            给 Agent 的任务
          </label>
          <textarea
            id="agent-task"
            ref={composerRef}
            value={task}
            rows={2}
            disabled={cannotStart}
            onChange={(event) => setTask(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229
              ) {
                event.preventDefault();
                if (!cannotStart) void run();
              }
            }}
            placeholder="例如：找出停滞商机并建议明天的跟进计划…"
            className="max-h-32 min-h-12 min-w-0 flex-1 resize-none overflow-y-auto rounded-md border-0 bg-transparent p-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
          />
          {activeRun ? (
            <button
              type="button"
              disabled={cancelling}
              onClick={() => void cancelRun()}
              className="shrink-0 rounded-md border px-3 py-3 text-sm"
            >
              {cancelling ? "取消中…" : "取消运行"}
            </button>
          ) : (
            <button
              type="submit"
              disabled={!modelConfigured || cannotStart || !task.trim() || !selected}
              className="shrink-0 rounded-md bg-primary px-3 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? "运行中…" : "运行 Agent"}
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Enter 发送 · Shift+Enter 换行 · 每次发送创建独立运行，CRM 提供上下文
        </p>
      </form>
      <Sheet
        open={panel !== null}
        onOpenChange={(open) => {
          if (!open) setPanel(null);
        }}
      >
        <SheetContent
          className="flex h-dvh w-full flex-col overflow-hidden sm:max-w-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (composerRef.current && !composerRef.current.disabled) composerRef.current.focus();
            else
              (lastPanel.current === "settings"
                ? settingsButtonRef
                : detailsButtonRef
              ).current?.focus();
          }}
        >
          <SheetHeader className="shrink-0 text-left">
            <SheetTitle>{panel === "settings" ? "任务设置" : "运行详情"}</SheetTitle>
            <SheetDescription>
              {panel === "settings"
                ? "选择 CRM 范围和业务验收条件，关闭后继续对话。"
                : "真实运行的策略、业务状态、审批、评估与历史。"}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pb-6">
            {error && (
              <p role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </p>
            )}
            {panel === "settings" ? (
              <fieldset disabled={cannotStart} className="space-y-4 disabled:opacity-60">
                {selected && (
                  <div className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
                    <p>{selected.description}</p>
                    <p className="mt-2">
                      知识域：{selected.knowledgePolicy?.namespaces.join(" · ") || "CRM context"}
                    </p>
                    <p className="mt-1">Eval：{selected.evalProfile ?? "crm_agent_default_v1"}</p>
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-[150px_1fr]">
                  <select
                    aria-label="CRM 对象类型"
                    className="rounded-md border bg-background px-3 py-2 text-sm"
                    value={objectKind}
                    onChange={(event) => {
                      setObjectKind(event.target.value as ObjectKind);
                      setObjectOptions([]);
                      setScope({});
                      setScopeLabel("");
                      setDelegateMission(false);
                    }}
                  >
                    <option value="contact">联系人</option>
                    <option value="lead">商机</option>
                    <option value="conversation">会话</option>
                    <option value="pipeline">销售漏斗</option>
                  </select>
                  <input
                    aria-label="搜索 CRM 对象"
                    value={objectQuery}
                    onChange={(event) => setObjectQuery(event.target.value)}
                    placeholder="按名称或内容搜索 CRM…"
                    className="rounded-md border bg-background px-3 py-2 text-sm"
                  />
                </div>
                {scopeLabel ? (
                  <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-xs">
                    <span>目标对象：{scopeLabel}</span>
                    <button
                      onClick={() => {
                        setScope({});
                        setScopeLabel("");
                        setDelegateMission(false);
                      }}
                      className="underline"
                    >
                      清除
                    </button>
                  </div>
                ) : (
                  <div className="max-h-32 space-y-1 overflow-auto">
                    {objectOptions.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => chooseScope(item)}
                        className="flex w-full justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                      >
                        <span className="truncate">{item.label}</span>
                        {item.detail && (
                          <span className="shrink-0 text-muted-foreground">{item.detail}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {canDelegateMission && (
                  <div className="space-y-2 rounded-md border p-3 text-sm">
                    <label className="flex items-center gap-2 font-medium">
                      <input
                        type="checkbox"
                        checked={missionEnabled}
                        onChange={(event) => setDelegateMission(event.target.checked)}
                      />
                      建立商机业务任务
                    </label>
                    {missionEnabled && (
                      <>
                        <input
                          aria-label="业务验收条件"
                          value={acceptanceCriteria}
                          onChange={(event) => setAcceptanceCriteria(event.target.value)}
                          placeholder="例如：客户确认报价与交期，商机记录和下一次跟进均已更新"
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        />
                        <p className="text-xs text-muted-foreground">
                          Agent
                          本轮结束后，任务仍等待业务结果验收；模型回答本身不会把任务标记为完成。
                        </p>
                        <div className="space-y-2 rounded-md border p-2 text-xs">
                          <p className="font-medium">可观察条件（可选，由 CRM 事实核对）</p>
                          <label className="flex items-center gap-2">
                            商机当前状态
                            <select
                              value={observableLeadStatus}
                              onChange={(event) =>
                                setObservableLeadStatus(
                                  event.target.value as "" | "open" | "won" | "lost",
                                )
                              }
                              className="rounded-md border bg-background px-2 py-1"
                            >
                              <option value="">不要求</option>
                              <option value="open">进行中</option>
                              <option value="won">赢单</option>
                              <option value="lost">丢单</option>
                            </select>
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={requireCustomerInbound}
                              onChange={(event) => setRequireCustomerInbound(event.target.checked)}
                            />
                            已核实发送后，同一会话出现客户后续文本
                          </label>
                          <p className="text-muted-foreground">
                            这些条件只能核对记录和时间；不能证明客户接受价格、交期或其他自由文本承诺。
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {canCopy && (
                  <button
                    disabled={busy}
                    onClick={() => void copyBuiltin()}
                    className="w-full rounded-md border px-3 py-2 text-sm"
                  >
                    复制并定制
                  </button>
                )}
                <a href="/app/ai/providers" className="block text-sm underline">
                  模型与凭据设置
                </a>
                <a href="/app/ai/knowledge/sources" className="block text-sm underline">
                  知识来源与索引设置
                </a>
                <p className="text-xs text-muted-foreground">
                  Wiki 检索还需要可用的 embedding
                  凭据和已完成的来源索引；仅配置聊天模型不代表知识库已就绪。
                </p>
              </fieldset>
            ) : (
              <>
                <div>
                  <h2 className="font-semibold">CRM 变化与策略</h2>
                  <p className="mt-1 text-xs text-muted-foreground">执行状态、待确认动作与用量</p>
                </div>
                {detail ? (
                  <>
                    {detail.mission && (
                      <section
                        className="rounded-lg border p-3 text-sm"
                        data-testid="crm-mission-state"
                      >
                        <h3 className="font-semibold">商机业务任务 · {detail.mission.status}</h3>
                        <p className="mt-2">{detail.mission.goal}</p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          验收条件：{detail.mission.acceptance_criteria}
                        </p>
                        {detail.mission.customer_send_paused && (
                          <p className="text-xs text-destructive">
                            客户发送已被负责人暂停；旧审批不能继续发送。
                          </p>
                        )}
                        <MissionSendControl
                          key={detail.mission.id}
                          mission={detail.mission}
                          onUpdated={async (paused) => {
                            const runId = detail.id;
                            setDetail((current) =>
                              current?.id === runId && current.mission
                                ? {
                                    ...current,
                                    mission: { ...current.mission, customer_send_paused: paused },
                                  }
                                : current,
                            );
                            const updated = await fetchDetail(runId);
                            setDetail((current) => (current?.id === runId ? updated : current));
                          }}
                        />
                        {detail.mission.acceptance_contract?.checks.map((check) => (
                          <p key={check.kind} className="text-xs text-muted-foreground">
                            可观察条件：
                            {check.kind === "lead_status"
                              ? `商机当前状态为 ${check.equals}`
                              : "已核实发送后有同会话入站文本"}
                          </p>
                        ))}
                        {detail.mission.blocked_reason && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            当前原因：{detail.mission.blocked_reason}
                          </p>
                        )}
                      </section>
                    )}
                    <div className="rounded-lg bg-muted/60 p-3 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">状态</span>
                        <span>{detail.status}</span>
                      </div>
                      <div className="mt-2 flex justify-between">
                        <span className="text-muted-foreground">模式</span>
                        <span>{detail.mode === "act" ? "分级自治" : "只读检查"}</span>
                      </div>
                    </div>
                    {(detail.proposals.find((proposal) => proposal.tool_name === "send_message")
                      ?.draft_body ||
                      detail.final_text) && (
                      <section className="rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold">Agent 回复草稿</h3>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                            未发送
                          </span>
                        </div>
                        <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">
                          {detail.proposals.find(
                            (proposal) => proposal.tool_name === "send_message",
                          )?.draft_body ?? detail.final_text}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          草稿仅供审核，不会自动发送给客户。
                        </p>
                      </section>
                    )}
                    {pending.length > 0 && (
                      <div className="space-y-3">
                        <h3 className="text-sm font-semibold">待确认动作</h3>
                        {pending.map((proposal) => (
                          <div key={proposal.id} className="rounded-lg border p-3">
                            <p className="text-sm font-medium">
                              {TOOL_LABELS[proposal.tool_name] ?? proposal.tool_name}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {proposal.tool_name === "send_message"
                                ? "草稿尚未发送。批准后创建 CRM 审核发送任务，由正式 worker 重新检查实时策略和会话状态。"
                                : proposal.tool_name === "ask_internal_colleague"
                                  ? "问题尚未发送。批准后进入飞书发送队列；送达和同事回复会分别记录，任务不会因此自动完成。"
                                  : "Agent 未执行此动作。批准后由 CRM Harness 再次校验并调用。"}
                            </p>
                            {proposal.tool_name === "crm_schedule_followup" && (
                              <div className="mt-2 rounded-md bg-muted p-2 text-xs">
                                <p>
                                  目标 {String(proposal.preview.targetKind ?? "待核对")}：
                                  {String(proposal.preview.targetId ?? "未记录")}
                                </p>
                                <p>
                                  时间：
                                  {typeof proposal.preview.inHours === "number"
                                    ? `执行批准后 ${proposal.preview.inHours} 小时`
                                    : String(proposal.preview.promisedAt ?? "未记录，请先核对")}
                                </p>
                              </div>
                            )}
                            {proposal.tool_name === "ask_internal_colleague" &&
                              typeof proposal.preview.question === "string" && (
                                <div className="mt-2 rounded-md bg-muted p-2 text-xs">
                                  <p>
                                    收件人 CRM 用户：
                                    {String(proposal.preview.recipientUserId ?? "未知")}
                                  </p>
                                  <p className="mt-1 whitespace-pre-wrap">
                                    问题：{proposal.preview.question}
                                  </p>
                                </div>
                              )}
                            <div className="mt-3 flex gap-2">
                              <button
                                disabled={busy}
                                onClick={() => void decide(proposal.id, "approve")}
                                className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
                              >
                                {proposal.tool_name === "send_message" ||
                                proposal.tool_name === "ask_internal_colleague"
                                  ? "批准并进入发送队列"
                                  : "批准执行"}
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => void decide(proposal.id, "reject")}
                                className="rounded-md border px-3 py-1.5 text-xs"
                              >
                                拒绝
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {detail.proposals
                      .filter((proposal) => proposal.status !== "pending")
                      .map((proposal) => (
                        <div key={proposal.id} className="rounded-lg border p-3 text-sm">
                          <span className="font-medium">
                            {TOOL_LABELS[proposal.tool_name] ?? proposal.tool_name}
                          </span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {(proposal.tool_name === "send_message" ||
                              proposal.tool_name === "ask_internal_colleague") &&
                            proposal.status === "executed"
                              ? "已进入 CRM 发送队列"
                              : proposal.status === "approved"
                                ? "批准已记录，执行中"
                                : proposal.result_summary?.outcome === "reconciliation_required"
                                  ? "执行结果待人工对账"
                                  : proposal.status}
                          </span>
                          {proposal.result_summary?.outcome === "reconciliation_required" && (
                            <p className="mt-2 text-xs text-destructive">
                              CRM 动作可能已经生效，系统不会自动重试。请先核对目标对象和执行记录。
                            </p>
                          )}
                          {proposal.status === "executed" && proposal.can_undo && (
                            <button
                              disabled={busy}
                              onClick={() => void undo(proposal.id)}
                              className="ml-3 rounded-md border px-2 py-1 text-xs"
                            >
                              撤销
                            </button>
                          )}
                          {Array.isArray(proposal.preview.changedFields) &&
                            proposal.preview.changedFields.length > 0 && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                变更字段：{proposal.preview.changedFields.join("、")}
                              </p>
                            )}
                        </div>
                      ))}
                    <div className="rounded-lg border p-3 text-xs">
                      <p className="font-medium">Harness 记录</p>
                      <p className="mt-1 text-muted-foreground">
                        {detail.events.length} 个事件 · {detail.proposals.length} 个操作提案
                      </p>
                    </div>
                    {detail.specialists.length > 0 && (
                      <section className="rounded-lg border p-3 text-xs">
                        <p className="font-medium">Specialist 子运行</p>
                        <div className="mt-2 space-y-2">
                          {detail.specialists.map((specialist) => (
                            <div
                              key={specialist.id}
                              className="flex items-center justify-between gap-3 text-muted-foreground"
                            >
                              <span>{specialist.specialist_key ?? "unknown"}</span>
                              <span>{specialist.status}</span>
                            </div>
                          ))}
                        </div>
                        <p className="mt-2 text-muted-foreground">
                          Specialist 只读；CRM 写入仍由父 Agent 和 Harness 单写者路径处理。
                        </p>
                      </section>
                    )}
                    {detail.evaluationError && (
                      <section
                        className="space-y-2 rounded-lg border p-3 text-sm"
                        aria-label="评测读取失败"
                      >
                        <p role="alert" className="text-destructive">
                          评测暂不可用：{detail.evaluationError}
                        </p>
                        <p className="text-muted-foreground">
                          运行结果仍保留。重试只读取评测，不会重新运行 Agent、语义 Judge 或投递
                          Eval。
                        </p>
                        {activeRun && (
                          <p className="text-muted-foreground">
                            运行期间会自动刷新评测，结束后可手动重试。
                          </p>
                        )}
                        <button
                          type="button"
                          disabled={
                            busy || cancelling || activeRun || readingEvaluation === detail.id
                          }
                          onClick={() => void retryEvaluation()}
                          className="rounded-md border px-2 py-1 disabled:opacity-50"
                        >
                          {readingEvaluation === detail.id ? "正在读取评测…" : "重试读取评测"}
                        </button>
                      </section>
                    )}
                    {detail.evaluation && (
                      <section
                        className="rounded-lg border p-3 text-xs"
                        data-testid="agent-run-evaluation"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium">Run Eval</p>
                          <span>
                            {detail.evaluation.verdict}
                            {detail.evaluation.score === null
                              ? ""
                              : ` · ${detail.evaluation.score}`}
                          </span>
                        </div>
                        <div className="mt-2 space-y-1">
                          {detail.evaluation.dimensions.map((dimension) => (
                            <details key={dimension.key} className="rounded-md border p-2">
                              <summary className="cursor-pointer text-muted-foreground">
                                {dimension.label} · {dimension.verdict}
                                {dimension.score === null ? "" : ` · ${dimension.score}`}
                              </summary>
                              {dimension.findings.length > 0 ? (
                                <ul className="mt-2 space-y-1">
                                  {dimension.findings.map((finding) => (
                                    <li key={finding.code}>
                                      {finding.message}
                                      <span className="block text-[10px] text-muted-foreground">
                                        {finding.code}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="mt-2 text-muted-foreground">
                                  此项检查未发现问题；不代表业务结果已验收。
                                </p>
                              )}
                            </details>
                          ))}
                        </div>
                        <p className="mt-2 text-muted-foreground">
                          {detail.evaluation.summary.toolCalls} 次工具 ·{" "}
                          {detail.evaluation.summary.toolErrors} 次失败 ·{" "}
                          {detail.evaluation.summary.groundedEvidenceItems} 条知识证据 ·{" "}
                          {detail.evaluation.summary.specialistRuns} 个 Specialist
                          {detail.evaluation.summary.structuredClaims > 0
                            ? ` · ${detail.evaluation.summary.structuredClaims} 条 Claims`
                            : ""}
                        </p>
                        <button
                          type="button"
                          disabled={
                            busy ||
                            !["completed", "partial", "failed", "cancelled"].includes(detail.status)
                          }
                          onClick={() => void runSemanticJudge("deterministic_export")}
                          className="mt-2 rounded-md border px-2 py-1 font-medium disabled:opacity-50"
                        >
                          保存并投递确定性 Eval
                        </button>
                        {evalExportNotice?.runId === detail.id && (
                          <p className="mt-1 text-muted-foreground">{evalExportNotice.text}</p>
                        )}
                        {(detail.evaluation.savedSemanticEvaluation ?? detail.evaluation).semanticJudge.status === "completed" ? (
                          <div className="mt-2 rounded-md bg-muted p-2 text-muted-foreground">
                            语义 Judge：{(detail.evaluation.savedSemanticEvaluation ?? detail.evaluation).semanticJudge.verdict}
                            {(detail.evaluation.savedSemanticEvaluation ?? detail.evaluation).semanticJudge.score === undefined
                              ? ""
                              : ` · ${(detail.evaluation.savedSemanticEvaluation ?? detail.evaluation).semanticJudge.score}`}
                            {detail.evaluation.savedSemanticEvaluation && <p>已保存的真实评测 · 本次读取未调用模型；上方为独立确定性门禁。</p>}
                            {(detail.evaluation.savedSemanticEvaluation ?? detail.evaluation).semanticJudge.findings?.map(finding => (
                              <p key={finding.code} className="mt-1">{finding.message}</p>
                            ))}
                          </div>
                        ) : (
                          <>
                            <p className="mt-1 text-muted-foreground">
                              {detail.evaluation.semanticJudge.status === "failed"
                                ? "语义 Judge 上次未完成；确定性 Harness 结果仍然有效。"
                                : "当前为确定性 Harness 评测；语义 Judge 需要显式运行。"}
                            </p>
                            <button
                              type="button"
                              disabled={
                                busy ||
                                !modelConfigured ||
                                !["completed", "partial"].includes(detail.status)
                              }
                              onClick={() => void runSemanticJudge()}
                              className="mt-2 rounded-md border px-2 py-1 font-medium disabled:opacity-50"
                            >
                              运行语义 Judge（消耗模型额度）
                            </button>
                          </>
                        )}
                      </section>
                    )}
                  </>
                ) : (
                  <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    运行后这里显示策略结果、待确认动作和 CRM 状态变化。
                  </p>
                )}
                <div className="border-t pt-3">
                  <h3 className="mb-2 text-sm font-semibold">最近运行</h3>
                  <div className="max-h-60 space-y-1 overflow-auto">
                    {runs.slice(0, 8).map((item) => (
                      <button
                        key={item.id}
                        disabled={cannotStart}
                        onClick={() => void openHistory(item.id)}
                        className="w-full rounded-md p-2 text-left hover:bg-muted"
                      >
                        <span className="block truncate text-xs">{item.task}</span>
                        <span className="text-xs text-muted-foreground">
                          {item.status} · {new Date(item.created_at).toLocaleString()}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {detail && (
                  <details className="rounded-lg border p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      执行时间线 · {detail.events.length} 条事件
                    </summary>
                    <div className="mt-3 space-y-3 break-words">
                      {detail?.events.map((event) => (
                        <div key={event.id} className="flex gap-3 text-sm">
                          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" />
                          <div>
                            <p className="font-medium">{eventLabel(event)}</p>
                            <p className="text-xs text-muted-foreground">
                              {new Date(event.created_at).toLocaleTimeString()} ·{" "}
                              {Object.entries(event.payload ?? {})
                                .filter(([key]) => !/id$/.test(key))
                                .map(([key, value]) => `${key}: ${String(value)}`)
                                .join(" · ")}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {Boolean(detail?.observed_evidence?.length) && (
                  <section
                    className="space-y-3 rounded-lg border p-3 text-sm"
                    aria-label="实际读取的知识证据"
                  >
                    <h3 className="font-semibold">实际读取的知识证据</h3>
                    <p className="text-xs text-muted-foreground">
                      来自本次运行成功工具观察，已重新核对当前来源权限。索引版本不等于商业政策批准。
                    </p>
                    {detail!.observed_evidence!.map((item) => (
                      <details
                        key={`${item.id}:${item.revision}`}
                        className="rounded-md border p-2"
                      >
                        <summary className="cursor-pointer font-medium">
                          {item.title}
                          {item.index_status === "superseded" ? " · 索引已有更新，请重查" : ""}
                        </summary>
                        <p className="mt-2 break-words whitespace-pre-wrap">{item.excerpt}</p>
                        <p className="mt-2 text-xs break-all text-muted-foreground">
                          {item.revision_kind === "index_version" ? "索引版本" : "记忆快照"}：
                          {item.revision ?? "未记录"}
                          {item.position === undefined ? "" : ` · 片段 ${item.position + 1}`}
                        </p>
                        <p className="text-xs break-all text-muted-foreground">
                          证据 ID：{item.id}
                        </p>
                        {item.uri && (
                          <a
                            href={item.uri}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-block text-xs underline"
                          >
                            查看来源
                          </a>
                        )}
                      </details>
                    ))}
                  </section>
                )}
                {detail?.result_document && (
                  <section
                    className="mt-3 space-y-2 rounded-lg border p-4 text-sm"
                    aria-label="结构化结果"
                  >
                    <p className="font-medium">
                      结构化结果{" "}
                      <span className="font-normal text-muted-foreground">
                        · Agent 陈述，业务结果尚需核验
                      </span>
                    </p>
                    {detail.result_document.evidence.length > 0 && (
                      <div>
                        <p className="text-muted-foreground">引用线索（未独立核验）</p>
                        {detail.result_document.evidence.map((item, index) => (
                          <p
                            key={`${item.sourceType}-${item.sourceId}-${index}`}
                            className="break-words"
                          >
                            {item.claim} · {item.sourceType} · {item.sourceId}
                          </p>
                        ))}
                      </div>
                    )}
                    {detail.result_document.missingInformation.length > 0 && (
                      <p>缺失信息：{detail.result_document.missingInformation.join("；")}</p>
                    )}
                    {detail.result_document.nextStep && (
                      <p>建议下一步：{detail.result_document.nextStep}</p>
                    )}
                    <p className="text-muted-foreground">
                      建议唤醒条件：{detail.result_document.wakeCondition}（不自动设置）
                    </p>
                  </section>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
