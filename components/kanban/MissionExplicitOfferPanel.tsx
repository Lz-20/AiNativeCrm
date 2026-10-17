"use client";

import { useRef, useState } from "react";
import { randomId } from "@/lib/random-id";

type Evidence = {
  offerId: string | null;
  verdict: "not_issued" | "not_sent" | "awaiting_reply" | "unverified" | "verified" |
    "expired" | "superseded" | "conflict";
  reason: string;
  terms: { description: string; amountMinor: number; currency: string;
    deliveryDate: string } | null;
  offerText: string | null;
  acceptanceText: string | null;
  outboundMessageId: string | null;
  inboundMessageId: string | null;
  structuredTermsAccepted: boolean;
  legalIdentityVerified: false;
  businessOutcomeVerified: false;
  eligibleConversations: Array<{ id: string; label: string }>;
};

const labels: Record<Evidence["verdict"], string> = {
  not_issued: "尚未固定明确条款",
  not_sent: "确切报价文本尚无完整发送凭证",
  awaiting_reply: "报价已核对发送，等待客户完整确认码",
  unverified: "找到完整确认回复，但渠道回调未验签；不能据此确认客户接受",
  verified: "客户渠道已明确确认这版报价与交期",
  expired: "确认请求已过期",
  superseded: "报价已被新方向、客户变更或取消取代",
  conflict: "发送凭证冲突，需要人工核对",
};

function parseMinor(input: string): number | null {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const minor = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  return minor >= 1n && minor <= 1_000_000_000_000n ? Number(minor) : null;
}

/** UI for an explicit customer action, not an Agent-generated acceptance claim. */
export function MissionExplicitOfferPanel({ missionId, leadId, active }: {
  missionId: string; leadId: string; active: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("CNY");
  const [deliveryDate, setDeliveryDate] = useState("");
  const request = useRef<{ signature: string; key: string } | null>(null);

  async function refresh() {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/ai/missions/${missionId}/explicit-offer`,
        { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "无法核对报价确认凭证");
      const next = body.data as Evidence;
      setEvidence(next);
      setConversationId((current) => current || next.eligibleConversations[0]?.id || "");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法核对报价确认凭证");
    } finally { setBusy(false); }
  }

  async function issue() {
    const amountMinor = parseMinor(amount);
    if (!conversationId || !description.trim() || !deliveryDate || amountMinor === null) {
      setError("请选择客户会话，并填写项目、正数金额和交期。");
      return;
    }
    const input = { conversationId, terms: { description: description.trim(),
      amountMinor, currency, deliveryDate } };
    const signature = JSON.stringify(input);
    if (!request.current || request.current.signature !== signature)
      request.current = { signature, key: randomId() };
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/ai/missions/${missionId}/explicit-offer`, {
        method: "POST", headers: { "Content-Type": "application/json",
          "Idempotency-Key": request.current.key },
        body: signature,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "无法固定报价与交期");
      const issued = body.data as { id: string; offerText: string;
        acceptanceText: string; superseded: boolean };
      setEvidence((current) => ({
        offerId: issued.id, verdict: issued.superseded ? "superseded" : "not_sent",
        reason: "exact_approved_offer_not_delivered", terms: input.terms,
        offerText: issued.offerText, acceptanceText: issued.acceptanceText,
        outboundMessageId: null, inboundMessageId: null,
        structuredTermsAccepted: false, legalIdentityVerified: false,
        businessOutcomeVerified: false,
        eligibleConversations: current?.eligibleConversations ?? [],
      }));
      request.current = null;
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法固定报价与交期");
    } finally { setBusy(false); }
  }

  return (
    <section className="mt-3 rounded-md border border-border p-2 text-xs">
      <button className="underline underline-offset-2" onClick={() => {
        setExpanded((value) => !value);
        if (!expanded && !evidence) void refresh();
      }}>
        明确报价与交期确认
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          <p className="text-text-muted">
            先固定条款，再让 Agent 在对应会话原样提出发送；负责人仍需逐字审批。
            每次重新固定都会取代上一版；仅凭“收到”或模型总结不会通过验收。
          </p>
          {active && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label>客户 WhatsApp 会话
                <select className="mt-1 w-full rounded-md border bg-background p-1"
                  value={conversationId} onChange={(event) => setConversationId(event.target.value)}>
                  {(evidence?.eligibleConversations ?? []).map((item) => (
                    <option key={item.id} value={item.id}>{item.label} · {item.id.slice(0, 8)}</option>
                  ))}
                </select>
              </label>
              <label>项目
                <input className="mt-1 w-full rounded-md border bg-background p-1"
                  value={description} onChange={(event) => setDescription(event.target.value)}
                  maxLength={160} />
              </label>
              <label>报价金额
                <input className="mt-1 w-full rounded-md border bg-background p-1"
                  inputMode="decimal" placeholder="1234.50" value={amount}
                  onChange={(event) => setAmount(event.target.value)} />
              </label>
              <label>币种
                <select className="mt-1 w-full rounded-md border bg-background p-1"
                  value={currency} onChange={(event) => setCurrency(event.target.value)}>
                  {["CNY", "BRL", "USD", "EUR"].map((item) =>
                    <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label>交期
                <input className="mt-1 w-full rounded-md border bg-background p-1"
                  type="date" value={deliveryDate}
                  onChange={(event) => setDeliveryDate(event.target.value)} />
              </label>
              <button className="self-end rounded-md border px-2 py-1 disabled:opacity-50"
                disabled={busy || !evidence?.eligibleConversations.length}
                onClick={() => void issue()}>固定这版条款</button>
            </div>
          )}
          {evidence && <p role="status">{labels[evidence.verdict]}</p>}
          {evidence?.offerText && (
            <div className="rounded-md bg-muted p-2">
              <p>必须原样发送以下完整文本；修改金额、交期或确认码后不会被核验：</p>
              <pre className="mt-1 whitespace-pre-wrap break-words select-all">{evidence.offerText}</pre>
              <a className="mt-2 inline-block underline" href={`/app/ai/workbench?leadId=${encodeURIComponent(leadId)}`}>
                在 Agent 工作台执行并审批发送
              </a>
            </div>
          )}
          {evidence?.structuredTermsAccepted && (
            <p>证据：出站消息 {evidence.outboundMessageId?.slice(0, 8)}，客户入站消息 {evidence.inboundMessageId?.slice(0, 8)}。
              这只证明当前渠道对这版结构化报价和交期作了明确回复；不核验法律身份或任务中的其他条款。</p>
          )}
          <button className="underline disabled:opacity-50" disabled={busy}
            onClick={() => void refresh()}>重新核对渠道证据</button>
          {error && <p role="alert" className="text-destructive">{error}</p>}
        </div>
      )}
    </section>
  );
}
