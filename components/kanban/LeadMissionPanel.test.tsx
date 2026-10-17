import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LeadMissionPanel } from "./LeadMissionPanel";

const MISSION = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";

function response(data: unknown) {
  return { ok: true, json: async () => ({ data }) };
}

afterEach(() => vi.unstubAllGlobals());

describe("LeadMissionPanel internal information", () => {
  it("submits a manager follow-up at a waiting Mission boundary", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response([{ id: MISSION, goal: "推进报价", acceptance_criteria: "客户确认",
        status: "needs_review", blocked_reason: "报价需核对", resolution_reason: null,
        latest_run_id: "run-old" }]))
      .mockResolvedValueOnce(response({ missionId: MISSION, runId: "run-new",
        missionStatus: "queued", customerSendPaused: true }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", { randomUUID: () => KEY });
    render(<LeadMissionPanel leadId="lead-a" pipelineId="pipeline-a" open />);
    fireEvent.change(await screen.findByLabelText("负责人补充任务方向"), {
      target: { value: "改用新报价依据，先核对客户需求" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存方向并继续任务" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const [url, options] = fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`/api/v1/ai/missions/${MISSION}/follow-up`);
    expect(options.headers).toMatchObject({ "Idempotency-Key": KEY });
    expect(JSON.parse(String(options.body))).toEqual({ direction: "改用新报价依据，先核对客户需求" });
    expect(await screen.findByText("待执行")).toBeInTheDocument();
    expect(screen.getByText("负责人方向：改用新报价依据，先核对客户需求")).toBeInTheDocument();
    expect(screen.getByText(/客户发送已暂停/)).toBeInTheDocument();
  });

  it("offers controlled restart while a Mission is running", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response([{ id: MISSION, goal: "推进报价", acceptance_criteria: "客户确认",
        status: "running", blocked_reason: null, latest_run_id: "run-old" }]))
      .mockResolvedValueOnce(response({ missionId: MISSION, runId: "run-new",
        missionStatus: "queued", customerSendPaused: true }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", { randomUUID: () => KEY });
    render(<LeadMissionPanel leadId="lead-a" pipelineId="pipeline-a" open />);
    expect(await screen.findByText(/提交会停止旧运行/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("负责人补充任务方向"), {
      target: { value: "停止旧分析，先核对最新客户需求" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存方向并继续任务" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/v1/ai/missions/${MISSION}/follow-up`);
  });

  it("distinguishes an accepted direction from one consumed by the model", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response([
      { id: MISSION, goal: "报价 A", acceptance_criteria: "客户确认", status: "queued",
        current_direction: "先核对报价", direction_revision: 2,
        direction_consumed_revision: 1, latest_run_id: "run-a" },
      { id: "44444444-4444-4444-8444-444444444444", goal: "报价 B",
        acceptance_criteria: "客户确认", status: "running",
        current_direction: "先核对合同", direction_revision: 3,
        direction_consumed_revision: 3, latest_run_id: "run-b" },
    ]));
    vi.stubGlobal("fetch", fetch);
    render(<LeadMissionPanel leadId="lead-a" pipelineId="pipeline-a" open />);
    expect(await screen.findByText("新方向已接受，等待模型消费")).toBeInTheDocument();
    expect(screen.getByText("新方向已由模型读取（不等于业务完成）")).toBeInTheDocument();
  });

  it("offers a replacement direction while an old action is waiting for approval", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response([{ id: MISSION, goal: "核对交期", acceptance_criteria: "客户确认",
        status: "waiting_approval", blocked_reason: "action_approval_required",
        latest_run_id: "run-old" }]))
      .mockResolvedValueOnce(response({ missionId: MISSION, runId: "run-new",
        missionStatus: "queued", customerSendPaused: true }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", { randomUUID: () => KEY });
    render(<LeadMissionPanel leadId="lead-a" pipelineId="pipeline-a" open />);
    expect(await screen.findByText(/旧提案会撤销/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("负责人补充任务方向"), {
      target: { value: "停止旧交期问题，按新合同重新核查" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存方向并继续任务" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/v1/ai/missions/${MISSION}/follow-up`);
  });

  it("sends a durable pause command and shows the customer-send fence", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response([{ id: MISSION, goal: "核对报价", acceptance_criteria: "客户确认",
        status: "waiting_customer", blocked_reason: null, resolution_reason: null,
        customer_send_paused: false, latest_run_id: "run-1" }]))
      .mockResolvedValueOnce(response({ missionId: MISSION, customerSendPaused: true,
        policyRevision: 1, commandId: 8, changed: true }))
      .mockResolvedValueOnce(response([{ id: 8, kind: "pause_customer_send",
        reason: "先核对最新报价", created_at: "2026-09-30T04:00:00Z" }]));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", { randomUUID: () => KEY });
    render(<LeadMissionPanel leadId="lead-a" pipelineId="pipeline-a" open />);
    fireEvent.change(await screen.findByLabelText("客户发送策略原因"), {
      target: { value: "先核对最新报价" },
    });
    fireEvent.click(screen.getByRole("button", { name: "暂停客户发送" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const [url, options] = fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`/api/v1/ai/missions/${MISSION}/commands`);
    expect(JSON.parse(String(options.body))).toEqual({ command: "pause_customer_send",
      reason: "先核对最新报价", requestKey: KEY });
    expect(await screen.findByText(/客户发送已暂停/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复客户发送权限" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看发送策略记录" }));
    expect(await screen.findByText(/暂停：先核对最新报价/)).toBeInTheDocument();
  });

  it("shows observable conditions separately from free-text business acceptance", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response([{ id: MISSION, goal: "推进报价", acceptance_criteria: "客户接受报价",
        status: "completed", blocked_reason: null, resolution_reason: "负责人验收", latest_run_id: "run-1" }]))
      .mockResolvedValueOnce(response({
        verdict: "human_attested", businessOutcomeVerified: false, observableConditionsMet: true,
        observableChecks: [{ kind: "lead_status", verdict: "met", reason: "crm_lead_status_matches" }],
        summary: {
          rootRuns: 1, specialistRuns: 0, crmChangesObserved: 0, crmChangeEvidenceConflicts: 0,
          crmChangesUnverified: 0, externalProposalsApproved: 0, customerMessagesSent: 0,
          customerMessagesNotSent: 0, customerDeliveryEvidenceConflicts: 0,
          customerRepliesObserved: 0, customerTouchRisk: false, failedOrPartialRuns: 0,
          failedOrPartialSpecialists: 0,
          budget: { usedTokens: 100, maxTotalTokens: 1000, usedCostCents: 1,
            maxTotalCostCents: 50, unknownCostCalls: 0 },
        },
        customerDeliveries: [], customerReplies: [], findings: [],
        structuredOffer: { offerId: "offer-1", verdict: "verified",
          reason: "exact_customer_channel_confirmation",
          terms: { description: "设备", amountMinor: 123450, currency: "CNY",
            deliveryDate: "2026-10-15" }, outboundMessageId: "message-1",
          inboundMessageId: "inbound-1", structuredTermsAccepted: true },
      }));
    vi.stubGlobal("fetch", fetch);
    render(<LeadMissionPanel leadId="lead-a" pipelineId="pipeline-a" open />);
    fireEvent.click(await screen.findByRole("button", { name: "查看业务评测" }));
    expect(await screen.findByText(/可观察条件：全部满足/)).toBeInTheDocument();
    expect(screen.getByText(/业务结果未由系统独立核验/)).toBeInTheDocument();
    expect(screen.getByText(/不等于自由文本业务验收/)).toBeInTheDocument();
    expect(screen.getByText(/已核对渠道签名及原样确认，仅证明这版条款获明确回复/)).toBeInTheDocument();
    expect(screen.getByText(/不等于完整业务验收/)).toBeInTheDocument();
  });

  it("shows cited customer text as a cost-bearing independent review, not verified completion", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response([{ id: MISSION, goal: "推进报价",
        acceptance_criteria: "客户接受报价和交期", status: "needs_review",
        blocked_reason: null, resolution_reason: null, latest_run_id: "run-1" }]))
      .mockResolvedValueOnce(response({ verdict: "supported", businessOutcomeVerified: false,
        rationale: "客户明确提及两项", evidence: [{ messageId: KEY,
          quote: "接受报价和交期", stance: "accepts" }], missingTerms: [] }));
    vi.stubGlobal("fetch", fetch);
    render(<LeadMissionPanel leadId="lead-a" pipelineId="pipeline-a" open />);
    fireEvent.click(await screen.findByRole("button", {
      name: "用真实模型审查客户答复（会产生费用）",
    }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/v1/ai/missions/${MISSION}/customer-acceptance`);
    expect((fetch.mock.calls[1]?.[1] as RequestInit).method).toBe("POST");
    expect(await screen.findByText(/有支持性原文/)).toBeInTheDocument();
    expect(screen.getByText(/模型判断不是客户身份或合同成立的证明/)).toBeInTheDocument();
    expect(screen.getByText(/客户消息 33333333：「接受报价和交期」/)).toBeInTheDocument();
  });

  it("offers a CRM response for a waiting Mission and sends one idempotent request", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response([{ id: MISSION, goal: "确认交期", acceptance_criteria: "客户接受交期",
        status: "waiting_internal", blocked_reason: "待仓储核对", resolution_reason: null,
        latest_run_id: "run-old" }]))
      .mockResolvedValueOnce(response({ missionId: MISSION, runId: "run-new", runStatus: "queued",
        missionStatus: "queued", replayed: false }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", { randomUUID: () => KEY });
    render(<LeadMissionPanel leadId="lead-a" pipelineId="pipeline-a" open />);

    fireEvent.change(await screen.findByLabelText("同事补充的业务信息"), {
      target: { value: "仓储确认下周二发货" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交补充并继续任务" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const [url, options] = fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`/api/v1/ai/missions/${MISSION}/internal-response`);
    expect(options.headers).toMatchObject({ "Idempotency-Key": KEY });
    expect(JSON.parse(String(options.body))).toEqual({ content: "仓储确认下周二发货" });
    expect(await screen.findByText("待执行")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看最近一次执行" }))
      .toHaveAttribute("href", "/app/ai/workbench?run=run-new");
  });

  it("lets a manager request internal information from needs_review", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response([{ id: MISSION, goal: "确认交期", acceptance_criteria: "客户接受交期",
        status: "needs_review", blocked_reason: "缺少仓储数据", resolution_reason: null,
        latest_run_id: "run-old" }]))
      .mockResolvedValueOnce(response({ id: MISSION, status: "waiting_internal",
        blocked_reason: "需要仓储确认交期", resolution_reason: null }));
    vi.stubGlobal("fetch", fetch);
    render(<LeadMissionPanel leadId="lead-a" pipelineId="pipeline-a" open />);

    fireEvent.change(await screen.findByLabelText("任务验收依据"), {
      target: { value: "需要仓储确认交期" },
    });
    fireEvent.click(screen.getByRole("button", { name: "等待同事补充" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetch.mock.calls[1] as [string, RequestInit])[1].body)))
      .toEqual({ action: "wait_for_internal", reason: "需要仓储确认交期" });
    expect(await screen.findByRole("button", { name: "提交补充并继续任务" })).toBeInTheDocument();
  });

  it("requires an explicit recipient and exact question before queueing a Feishu send", async () => {
    const colleague = "44444444-4444-4444-8444-444444444444";
    const fetch = vi.fn()
      .mockResolvedValueOnce(response([{ id: MISSION, goal: "确认交期", acceptance_criteria: "客户接受交期",
        status: "waiting_internal", blocked_reason: "待仓储核对", resolution_reason: null,
        latest_run_id: "run-old" }]))
      .mockResolvedValueOnce(response({ available: true,
        recipients: [{ user_id: colleague, full_name: "交付同事" }] }))
      .mockResolvedValueOnce(response({ questionId: "outbox-id", status: "pending", replayed: false }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", { randomUUID: () => KEY });
    render(<LeadMissionPanel leadId="lead-a" pipelineId="pipeline-a" open />);
    fireEvent.click(await screen.findByRole("button", { name: "向飞书同事提问" }));
    expect(await screen.findByLabelText("已绑定的飞书同事")).toHaveValue(colleague);
    fireEvent.change(screen.getByLabelText("需要同事核实的问题"), {
      target: { value: "请确认 500 件最早何时能交付？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认并加入发送队列" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const [url, options] = fetch.mock.calls[2] as [string, RequestInit];
    expect(url).toBe(`/api/v1/ai/missions/${MISSION}/internal-question`);
    expect(JSON.parse(String(options.body))).toEqual({ recipientUserId: colleague,
      requestKey: KEY, question: "请确认 500 件最早何时能交付？" });
    expect(await screen.findByRole("status")).toHaveTextContent("排队不代表已送达");
  });
});
