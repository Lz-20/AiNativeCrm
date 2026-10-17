"use client";

import { useRef, useState } from "react";
import { randomId } from "@/lib/random-id";

type Command = "pause_customer_send" | "resume_customer_send";
export function MissionSendControl({
  mission,
  onUpdated,
}: {
  mission: { id: string; status: string; customer_send_paused: boolean };
  onUpdated: (paused: boolean) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const pending = useRef<{ command: Command; reason: string; requestKey: string } | null>(null);
  const terminal = ["completed", "cancelled"].includes(mission.status);
  const submit = async () => {
    if (inFlight.current || terminal || reason.trim().length < 5) return;
    inFlight.current = true;
    setSending(true);
    setError("");
    const command = mission.customer_send_paused ? "resume_customer_send" : "pause_customer_send";
    if (
      !pending.current ||
      pending.current.command !== command ||
      pending.current.reason !== reason.trim()
    )
      pending.current = { command, reason: reason.trim(), requestKey: randomId() };
    try {
      const response = await fetch(`/api/v1/ai/missions/${mission.id}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending.current),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "发送策略修改失败，请重试。");
      if (typeof body.data?.customerSendPaused !== "boolean")
        throw new Error("无法确认发送策略，请刷新后核对。");
      pending.current = null;
      setReason("");
      await onUpdated(body.data.customerSendPaused);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法确认发送策略，请重试。");
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  if (terminal) return null;
  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <label className="block text-xs">
        发送策略调整原因
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={sending}
          maxLength={2000}
          rows={2}
          className="mt-1 w-full rounded-md border bg-background p-2"
          placeholder="说明暂停或恢复的原因（至少 5 个字符）"
        />
      </label>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={sending || reason.trim().length < 5}
        className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
      >
        {sending
          ? "正在保存发送策略…"
          : mission.customer_send_paused
            ? "恢复客户发送"
            : "暂停客户发送"}
      </button>
      <p className="text-xs text-muted-foreground">
        只控制此任务的客户发送；调查仍可继续。在途消息可能已送达。恢复后仍须重新审核，旧审批不会复活。
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
