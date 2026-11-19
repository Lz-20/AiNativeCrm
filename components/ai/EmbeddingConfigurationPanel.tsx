"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { EmbeddingConfigurationRow } from "@/lib/ai/embeddings/configuration";
import { EmbeddingOperationsPanel } from "./EmbeddingOperationsPanel";

const presets = {
  siliconflow: { base_url: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", dimensions: 1024 },
  bailian: { base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "text-embedding-v4", dimensions: 1536 },
  openai: { base_url: "https://api.openai.com/v1", model: "text-embedding-3-small", dimensions: 1536 },
};
type Provider = keyof typeof presets;
interface State {
  configuration: EmbeddingConfigurationRow | null;
  credential: { is_active: boolean; validated_at: string | null } | null;
}

export function EmbeddingConfigurationPanel({ canWrite, onConfigured, onRefresh }: {
  canWrite: boolean; onConfigured: (configured: boolean) => void; onRefresh: () => void;
}) {
  const query = useQuery({ queryKey: ["ai", "knowledge", "embedding"],
    queryFn: async () => (await apiClient.get<{ data: State }>("/api/v1/ai/knowledge/embedding")).data });
  useEffect(() => {
    if (query.data) onConfigured(query.data.configuration !== null);
  }, [query.data, onConfigured]);
  if (query.isPending) return <p role="status">正在读取Embedding配置…</p>;
  if (query.isError) return <p role="alert">无法读取Embedding配置，请确认数据库迁移和权限。</p>;
  return <EmbeddingConfigurationForm key={query.data.configuration?.version ?? "unconfigured"}
    state={query.data} canWrite={canWrite} onSaved={async () => { await query.refetch(); onRefresh(); }} />;
}

function EmbeddingConfigurationForm({ state, canWrite, onSaved }: {
  state: State; canWrite: boolean; onSaved: () => Promise<void>;
}) {
  const initial = state.configuration;
  const [provider, setProvider] = useState<Provider>((initial?.provider as Provider) ?? "siliconflow");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? presets.siliconflow.base_url);
  const [model, setModel] = useState(initial?.model ?? presets.siliconflow.model);
  const [dimensions, setDimensions] = useState(initial?.dimensions ?? 1024);
  const [revision, setRevision] = useState(initial?.model_revision ?? "1");
  const [credentialId, setCredentialId] = useState(initial?.credential_id ?? "");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [busy, setBusy] = useState(false);
  const [validationOperation,setValidationOperation]=useState('');
  const validationReady = initial && !initial.enabled && !apiKey &&
    provider === initial.provider && baseUrl === initial.base_url && model === initial.model &&
    dimensions === initial.dimensions && revision === initial.model_revision &&
    credentialId === (initial.credential_id ?? "") && enabled === initial.enabled;
  function choose(value: Provider) {
    setProvider(value); setBaseUrl(presets[value].base_url); setModel(presets[value].model);
    setDimensions(presets[value].dimensions); setCredentialId(""); setEnabled(false);
  }
  async function save() {
    setBusy(true);
    const secret = apiKey; setApiKey("");
    try {
      await apiClient.put("/api/v1/ai/knowledge/embedding", { provider, base_url: baseUrl, model, dimensions,
        model_revision: revision, enabled, credential_id: credentialId || null,
        expected_version: initial?.version ?? null, ...(secret ? { api_key: secret } : {}) });
      await onSaved();
    } catch (error) { showApiError(error); } finally { setBusy(false); }
  }
  async function validate() {
    setBusy(true);
    try {
      await apiClient.post("/api/v1/ai/knowledge/embedding/validate", { confirm_cost: true, operation_id: validationOperation }, { timeoutMs: 40000 });
      await onSaved();
    } catch (error) { showApiError(error); } finally { setBusy(false); }
  }
  return <details className="rounded-lg border p-4" data-testid="embedding-configuration">
    <summary>Embedding：{initial ? `${initial.provider} / ${initial.model} / ${initial.dimensions}` : "尚未单独配置"}</summary>
    <p className="my-2 text-sm">Embedding独立于Agent推理模型。保存不会调用供应商；验证和索引可能计费。修改模型后请显式重新索引材料。</p>
    <p role="status">{state.credential?.is_active && state.credential.validated_at ? "凭据已验证" : "凭据未验证"}；{initial?.enabled ? "已启用" : "未启用"}</p>
    {canWrite && <div className="grid gap-3">
      <Label htmlFor="embedding-provider">Provider</Label>
      <select id="embedding-provider" value={provider} onChange={(e) => choose(e.target.value as Provider)} disabled={busy}>
        <option value="siliconflow">SiliconFlow</option><option value="bailian">Alibaba Cloud Bailian</option><option value="openai">OpenAI</option>
      </select>
      <Label htmlFor="embedding-url">Base URL</Label><Input id="embedding-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      <Label htmlFor="embedding-model">Model</Label><Input id="embedding-model" value={model} onChange={(e) => setModel(e.target.value)} />
      <Label htmlFor="embedding-dimensions">Dimensions</Label>
      <select id="embedding-dimensions" value={dimensions} onChange={(e) => setDimensions(Number(e.target.value))}>
        <option value={1024}>1024</option>{provider !== "siliconflow" && <option value={1536}>1536</option>}
      </select>
      <Label htmlFor="embedding-revision">Model revision</Label><Input id="embedding-revision" value={revision} onChange={(e) => setRevision(e.target.value)} />
      <Label htmlFor="embedding-credential">现有Embedding凭据ID（可选）</Label><Input id="embedding-credential" value={credentialId} onChange={(e) => setCredentialId(e.target.value)} />
      <Label htmlFor="embedding-key">API Key（仅新建或更换时填写）</Label><Input id="embedding-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <label><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> 启用Embedding（等待中的索引任务可能开始计费）</label>
      <Button type="button" onClick={save} disabled={busy}>保存配置（不调用API）</Button>
      <Label htmlFor="embedding-validation-operation">接口验证操作授权UUID</Label><Input id="embedding-validation-operation" value={validationOperation} onChange={e=>setValidationOperation(e.target.value)} />
      <Button type="button" variant="outline" onClick={validate} disabled={busy || !validationReady || !validationOperation}>验证Embedding（调用供应商，可能计费）</Button>
      <p className="text-sm">新凭据保存后保持禁用。先验证，再启用；历史向量保留，只有模型指纹一致的已发布索引参与检索。</p>
    </div>}
    <EmbeddingOperationsPanel canWrite={canWrite} />
  </details>;
}
