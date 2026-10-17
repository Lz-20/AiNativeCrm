"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { randomId } from "@/lib/random-id";

type Memory = {
  id: string;
  category: string;
  body: string;
  sync_state: string;
  write_outcome: string;
  deleted_at: string | null;
  remote_deleted_at: string | null;
};
export function CustomerMemoryPanel({
  contactId,
  readOnly = false,
}: {
  contactId: string;
  readOnly?: boolean;
}) {
  const [rows, setRows] = useState<Memory[]>([]);
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("preference");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [settled, setSettled] = useState<Record<string, boolean>>({});
  const requestKey = useRef<string | null>(null);
  async function load(signal?: AbortSignal) {
    const response = await fetch(
      `/api/v1/ai/customer-memory?contact_id=${encodeURIComponent(contactId)}`,
      { signal },
    );
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message ?? "无法读取客户记忆");
    if (!signal?.aborted) setRows(value.data);
  }
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal)).catch((err) => {
      if (!controller.signal.aborted) setError(err.message);
    });
    return () => controller.abort();
    // The parent keys this panel by contact ID, so form state cannot cross contacts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);
  async function mutate(method: string, payload: unknown) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v1/ai/customer-memory", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? "无法保存客户记忆");
      if (method === "POST") {
        setBody("");
        requestKey.current = null;
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求未完成，可用相同内容安全重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded-xl border p-4" aria-label="客户记忆">
      <h2 className="font-semibold">客户记忆</h2>
      <p className="text-sm text-muted-foreground">
        仅保存已确认的客户偏好、事实和沟通背景。公司产品、价格与承诺请放入知识库。Mem0
        启用后会同步这些内容，任务状态和审批仍由 CRM 管理。
      </p>
      {!readOnly && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            requestKey.current ??= randomId();
            void mutate("POST", {
              contact_id: contactId,
              request_key: requestKey.current,
              category,
              body,
              confirmed: true,
            });
          }}
        >
          <select
            aria-label="记忆类型"
            className="rounded-md border bg-background p-2"
            value={category}
            disabled={busy}
            onChange={(event) => {
              setCategory(event.target.value);
              requestKey.current = null;
            }}
          >
            <option value="preference">客户偏好</option>
            <option value="confirmed_fact">已确认事实</option>
            <option value="communication_context">沟通背景</option>
          </select>
          <Input
            aria-label="已确认的记忆内容"
            className="min-w-48 flex-1"
            maxLength={2000}
            value={body}
            disabled={busy}
            onChange={(event) => {
              setBody(event.target.value);
              requestKey.current = null;
            }}
          />
          <Button type="submit" disabled={busy || !body.trim()}>确认并保存</Button>
        </form>
      )}
      {rows.map((row) => (
        <div key={row.id} className="space-y-2 rounded-md bg-muted p-3 text-sm">
          <p>{row.deleted_at ? "已停止使用此记忆" : row.body}</p>
          <p className="text-muted-foreground">
            {row.sync_state} ·{" "}
            {row.deleted_at
              ? row.remote_deleted_at
                ? "外部清理已验证"
                : "外部清理待验证"
              : "已由负责人确认"}
          </p>
          {!readOnly && !row.deleted_at && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void mutate("DELETE", { id: row.id })}
            >
              删除此记忆
            </Button>
          )}
          {!readOnly && ["unknown", "in_flight"].includes(row.write_outcome) && (
            <div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settled[row.id] ?? false}
                  onChange={(event) => setSettled({ ...settled, [row.id]: event.target.checked })}
                />
                我已在 Mem0 服务确认先前请求已结束
              </label>
              <Button
                className="mt-2"
                variant="outline"
                disabled={busy || !settled[row.id]}
                onClick={() => void mutate("PATCH", { id: row.id, remote_request_settled: true })}
              >
                核对结果，不重复写入
              </Button>
            </div>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
