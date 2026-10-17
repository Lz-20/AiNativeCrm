"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { randomId } from "@/lib/random-id";

type Provider = {
  provider: string;
  configured: boolean;
  enabled: boolean;
  revision: number;
  destination?: string | null;
  available_knowledge_bases?: string[];
};
/** An existing navigation destination exposes readiness, pause and explicit activation. */
export function AgentIntegrationsPanel({
  canManageIntegrations,
  canReconcileCleanup,
}: {
  canManageIntegrations: boolean;
  canReconcileCleanup: boolean;
}) {
  const [items, setItems] = useState<Provider[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState("");
  const [wikiName, setWikiName] = useState("");
  const [wikiKb, setWikiKb] = useState("");
  const [wikiConfirmed, setWikiConfirmed] = useState(false);
  const [wikiNotice, setWikiNotice] = useState("");
  const wikiKey = useRef<string | null>(null);
  const [cleanup, setCleanup] = useState<Array<{ id: string; write_outcome: string }>>([]);
  const [cleanupSettled, setCleanupSettled] = useState<Record<string, boolean>>({});
  async function load(signal?: AbortSignal) {
    const response = await fetch("/api/v1/ai/integrations", { signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? "无法读取接入状态");
    if (signal?.aborted) return;
    setItems(body.data.providers);
    setCleanup(body.data.cleanup_receipts ?? []);
    setDelivery(
      body.data.trace_delivery
        .map((row: { status: string; count: string }) => `${row.status}: ${row.count}`)
        .join(" · "),
    );
  }
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => load(controller.signal))
      .catch((err) => {
        if (!controller.signal.aborted) setError(String(err.message));
      });
    return () => controller.abort();
  }, []);
  async function toggle(item: Provider) {
    if (!canManageIntegrations) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v1/ai/integrations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: item.provider,
          enabled: !item.enabled,
          revision: item.revision,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "无法保存");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法保存");
    } finally {
      setBusy(false);
    }
  }
  async function connectWiki() {
    if (!canManageIntegrations) return;
    setBusy(true);
    setError("");
    try {
      wikiKey.current ??= randomId();
      const response = await fetch("/api/v1/ai/integrations/wiki/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: wikiKey.current,
          name: wikiName,
          knowledge_base_id: wikiKb,
          whole_organization_visibility_confirmed: wikiConfirmed,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "无法绑定 Wiki");
      setWikiNotice("Wiki 已加入知识来源。请在 Agent 的知识范围中选择它，再发布版本。");
      setWikiName("");
      setWikiKb("");
      setWikiConfirmed(false);
      wikiKey.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法绑定 Wiki");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-2xl border bg-card p-5" aria-label="Agent 服务接入">
      <h2 className="font-semibold">Agent 服务接入</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Mem0 保存已确认客户记忆，WeKnora 读取公司产品 Wiki，Langfuse 接收脱敏 trace 与
        Eval。默认关闭；管理员启用前须确认服务权限与数据去向。
      </p>
      {!canManageIntegrations && (
        <p className="mt-2 text-sm text-muted-foreground">
          {canReconcileCleanup
            ? "服务启用/暂停、重试投递和 Wiki 来源登记仅限管理员；你仍可查看接入状态并核对客户记忆清理结果。"
            : "当前为只读访问，无法变更服务接入或核对清理结果。"}
        </p>
      )}
      <div className="mt-4 space-y-3">
        {items.map((item) => (
          <div key={item.provider} className="flex items-center justify-between gap-4">
            <div>
              <span className="font-medium">{item.provider}</span>
              <p className="text-sm text-muted-foreground">
                {item.enabled ? "已启用" : "未启用"} ·{" "}
                {item.configured
                  ? `服务端配置齐全，连通性未验证 · ${item.destination}`
                  : "等待服务端按组织配置"}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={!canManageIntegrations || busy || (!item.configured && !item.enabled)}
              onClick={() => void toggle(item)}
            >
              {item.enabled ? "暂停" : "启用"}
            </Button>
            {item.provider !== "weknora" && (
              <Button
                variant="outline"
                disabled={!canManageIntegrations || busy || !item.enabled}
                onClick={async () => {
                  if (!canManageIntegrations) return;
                  setBusy(true);
                  setError("");
                  try {
                    const response = await fetch("/api/v1/ai/integrations", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ provider: item.provider, action: "retry_delivery" }),
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error?.message ?? "无法重试投递");
                    await load();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "无法重试投递");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                重试失败投递
              </Button>
            )}
          </div>
        ))}
      </div>
      {(items.find((item) => item.provider === "weknora")?.available_knowledge_bases?.length ?? 0) >
        0 && (
        <form
          className="mt-4 space-y-2 border-t pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void connectWiki();
          }}
        >
          <label className="block text-sm">
            Wiki 来源名称
            <input
              disabled={!canManageIntegrations}
              className="ml-2 rounded-md border bg-background p-2"
              value={wikiName}
              maxLength={120}
              onChange={(event) => {
                setWikiName(event.target.value);
                wikiKey.current = null;
              }}
            />
          </label>
          <label className="block text-sm">
            公司产品知识库
            <select
              disabled={!canManageIntegrations}
              className="ml-2 rounded-md border bg-background p-2"
              value={wikiKb}
              onChange={(event) => {
                setWikiKb(event.target.value);
                wikiKey.current = null;
              }}
            >
              <option value="">选择已获授权的知识库</option>
              {items
                .find((item) => item.provider === "weknora")
                ?.available_knowledge_bases?.map((kb) => (
                  <option key={kb} value={kb}>
                    {kb}
                  </option>
                ))}
            </select>
          </label>
          <label className="flex gap-2 text-sm">
            <input
              disabled={!canManageIntegrations}
              type="checkbox"
              checked={wikiConfirmed}
              onChange={(event) => setWikiConfirmed(event.target.checked)}
            />
            确认整个知识库均可供本组织使用，不含不同权限的混合材料
          </label>
          <Button
            type="submit"
            disabled={
              !canManageIntegrations ||
              busy ||
              wikiName.trim().length < 2 ||
              !wikiKb ||
              !wikiConfirmed
            }
          >
            加入 Agent 知识来源
          </Button>
          {wikiNotice && <p className="text-sm text-muted-foreground">{wikiNotice}</p>}
        </form>
      )}
      {cleanup.length > 0 && (
        <div className="mt-4 space-y-2 border-t pt-4">
          <h3 className="font-medium">已删除客户的外部清理</h3>
          <p className="text-sm text-muted-foreground">
            以下记录只保留清理凭据，确认远端请求结束后才能完成核对。
          </p>
          {cleanup.map((receipt) => (
            <div key={receipt.id} className="space-y-2 rounded-md bg-muted p-3 text-sm">
              <p>
                清理记录 {receipt.id} · {receipt.write_outcome}
              </p>
              {["unknown", "in_flight"].includes(receipt.write_outcome) && (
                <>
                  <label>
                    <input
                      disabled={!canReconcileCleanup}
                      type="checkbox"
                      checked={cleanupSettled[receipt.id] ?? false}
                      onChange={(event) =>
                        setCleanupSettled({ ...cleanupSettled, [receipt.id]: event.target.checked })
                      }
                    />{" "}
                    已在 Mem0 确认原请求结束
                  </label>
                  <Button
                    variant="outline"
                    disabled={!canReconcileCleanup || busy || !cleanupSettled[receipt.id]}
                    onClick={async () => {
                      if (!canReconcileCleanup) return;
                      setBusy(true);
                      setError("");
                      try {
                        const response = await fetch("/api/v1/ai/customer-memory", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ id: receipt.id, remote_request_settled: true }),
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.error?.message ?? "无法核对");
                        await load();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "无法核对");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    核对清理结果
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {delivery && <p className="mt-3 text-sm text-muted-foreground">Trace 投递：{delivery}</p>}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
