"use client";

import { useEffect, useState } from "react";

type BindingStatus = {
  available: boolean;
  tenantBound: boolean;
  userBound: boolean;
  canClaimTenant: boolean;
};

async function loadStatus(): Promise<BindingStatus> {
  const response = await fetch("/api/v1/ai/internal-collaboration/feishu/binding",
    { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "无法读取绑定状态");
  return body.data as BindingStatus;
}

export function FeishuBinding() {
  const [status, setStatus] = useState<BindingStatus | null>(null);
  const [message, setMessage] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const current = await loadStatus();
      setStatus(current);
      if (current.userBound) { setMessage(""); setExpiresAt(""); }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取绑定状态");
    }
  }

  useEffect(() => {
    let active = true;
    void loadStatus().then((current) => {
      if (active) setStatus(current);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "无法读取绑定状态");
    });
    return () => { active = false; };
  }, []);

  async function begin(kind: "tenant_owner" | "member") {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/v1/ai/internal-collaboration/feishu/binding", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "无法创建绑定口令");
      setMessage(body.data.message as string);
      setExpiresAt(body.data.expiresAt as string);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法创建绑定口令");
    } finally { setBusy(false); }
  }

  if (status && !status.available) return null;
  return (
    <section className="rounded-lg border p-4" aria-label="飞书身份绑定">
      <h2 className="font-semibold">飞书内部协作身份</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        绑定后，同事才能作为商机任务的内部信息来源。飞书回复不会批准客户发送。
      </p>
      <p className="mt-3 text-sm" role="status">
        {status?.userBound ? "已绑定当前飞书账号" :
          status?.tenantBound ? "租户已连接，当前账号待绑定" :
            "租户尚未连接"}
      </p>
      {!status?.userBound && status?.canClaimTenant && (
        <button className="mt-3 rounded-md border px-3 py-2 text-sm" disabled={busy}
          onClick={() => void begin("tenant_owner")}>
          连接组织飞书租户
        </button>
      )}
      {!status?.userBound && status?.tenantBound && (
        <button className="mt-3 rounded-md border px-3 py-2 text-sm" disabled={busy}
          onClick={() => void begin("member")}>
          绑定我的飞书账号
        </button>
      )}
      {message && (
        <div className="mt-3 rounded-md bg-muted p-3 text-sm">
          <p>请私聊已安装的应用机器人，发送以下整行口令；仅显示本次，十分钟后失效：</p>
          <code className="mt-2 block break-all select-all">{message}</code>
          <p className="mt-2 text-xs text-muted-foreground">有效期至 {new Date(expiresAt).toLocaleString()}</p>
        </div>
      )}
      <button className="mt-3 block text-sm underline" disabled={busy}
        onClick={() => void refresh()}>刷新绑定状态</button>
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
    </section>
  );
}
