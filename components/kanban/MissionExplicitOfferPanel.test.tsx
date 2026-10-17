import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MissionExplicitOfferPanel } from "./MissionExplicitOfferPanel";

const MISSION = "33333333-3333-4333-8333-333333333333";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const KEY = "55555555-5555-4555-8555-555555555555";
vi.mock("@/lib/random-id", () => ({ randomId: () => KEY }));
afterEach(() => vi.unstubAllGlobals());

describe("explicit quote confirmation UI", () => {
  it("fixes exact terms and distinguishes explicit channel evidence from full business completion", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: {
        offerId: null, verdict: "not_issued", reason: "explicit_offer_missing",
        terms: null, offerText: null, acceptanceText: null,
        outboundMessageId: null, inboundMessageId: null,
        structuredTermsAccepted: false, legalIdentityVerified: false,
        businessOutcomeVerified: false,
        eligibleConversations: [{ id: CONVERSATION, label: "客户会话" }],
      } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: {
        id: KEY, offerText: "请确认报价：CNY 1234.50", acceptanceText: "确认报价交期 code",
        superseded: false,
      } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: {
        offerId: KEY, verdict: "verified", reason: "exact_customer_channel_confirmation",
        terms: { description: "500 件设备", amountMinor: 123450, currency: "CNY",
          deliveryDate: "2026-10-15" },
        offerText: "请确认报价：CNY 1234.50", acceptanceText: "确认报价交期 code",
        outboundMessageId: KEY, inboundMessageId: CONVERSATION,
        structuredTermsAccepted: true, legalIdentityVerified: false,
        businessOutcomeVerified: false,
        eligibleConversations: [{ id: CONVERSATION, label: "客户会话" }],
      } }) });
    vi.stubGlobal("fetch", fetch);
    render(<MissionExplicitOfferPanel missionId={MISSION} leadId="lead-a" active />);
    fireEvent.click(screen.getByRole("button", { name: "明确报价与交期确认" }));
    expect(await screen.findByText("尚未固定明确条款")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("项目"), { target: { value: "500 件设备" } });
    fireEvent.change(screen.getByLabelText("报价金额"), { target: { value: "1234.50" } });
    fireEvent.change(screen.getByLabelText("交期"), { target: { value: "2026-10-15" } });
    fireEvent.click(screen.getByRole("button", { name: "固定这版条款" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const [url, options] = fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`/api/v1/ai/missions/${MISSION}/explicit-offer`);
    expect(options.headers).toMatchObject({ "Idempotency-Key": KEY });
    expect(JSON.parse(String(options.body))).toEqual({ conversationId: CONVERSATION,
      terms: { description: "500 件设备", amountMinor: 123450, currency: "CNY",
        deliveryDate: "2026-10-15" } });
    expect(await screen.findByText("请确认报价：CNY 1234.50")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新核对渠道证据" }));
    expect(await screen.findByText(/客户渠道已明确确认这版报价与交期/)).toBeInTheDocument();
    expect(screen.getByText(/不核验法律身份或任务中的其他条款/)).toBeInTheDocument();
  });
});
