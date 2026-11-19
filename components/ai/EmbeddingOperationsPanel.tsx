"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showApiError } from "@/components/feedback/ApiErrorToast";

/** Advanced safety review, inside the existing knowledge configuration entry.
 * No button in this panel sends a model request or starts an index operation.
 */
export function EmbeddingOperationsPanel({ canWrite }: { canWrite: boolean }) {
  const query = useQuery({
    queryKey: ["ai", "knowledge", "embedding", "operations"],
    queryFn: async () =>
      (
        await apiClient.get<{ data: Record<string, unknown> }>(
          "/api/v1/ai/knowledge/embedding/operations",
        )
      ).data,
  });
  const [source, setSource] = useState(""),
    [kind, setKind] = useState("index"),
    [question, setQuestion] = useState("");
  const [proposal, setProposal] = useState(""),
    [review, setReview] = useState(""),
    [receipt, setReceipt] = useState(""),
    [busy, setBusy] = useState(false);
  async function act(action: "prepare" | "review_price" | "authorize") {
    setBusy(true);
    try {
      const body =
        action === "prepare"
          ? {
              action,
              knowledge_source_id: source,
              kind,
              ...(kind === "query" ? { inputs: [question] } : {}),
            }
          : action === "review_price"
            ? { action, review: JSON.parse(review) }
            : { action, operation: JSON.parse(proposal) };
      const result = await apiClient.post<{ data: Record<string, unknown> }>(
        "/api/v1/ai/knowledge/embedding/operations",
        body,
      );
      setReceipt(JSON.stringify(result.data, null, 2));
      await query.refetch();
    } catch (error) {
      showApiError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="my-3 rounded border p-3" data-testid="embedding-operations">
      <summary>Embedding操作授权与额度</summary>
      <p>
        默认拒绝外联。每项操作绑定组织、来源、内容、模型和配置版本；额度包括结果未知的请求，不自动退款或重试。
      </p>
      <p>
        价格与Token上界需要管理员独立审核供应商证明；无法验证时不要批准。金额单位为微分：1000000微分等于1分，币种单独登记。DeepSeek预算独立。
      </p>
      {query.isError ? (
        <p role="alert">无法读取操作账本；请检查迁移及权限，外联保持拒绝。</p>
      ) : (
        <pre className="max-h-64 overflow-auto text-xs" data-testid="embedding-operation-status">
          {JSON.stringify(query.data ?? {}, null, 2)}
        </pre>
      )}
      {canWrite && (
        <div className="grid gap-2">
          <Label htmlFor="embedding-operation-source">知识来源UUID</Label>
          <Input
            id="embedding-operation-source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <Label htmlFor="embedding-operation-kind">操作类型</Label>
          <select
            id="embedding-operation-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="index">单来源索引</option>
            <option value="validation">禁用状态接口验证</option>
            <option value="query">固定问题检索</option>
          </select>
          {kind === "query" && (
            <>
              <Label htmlFor="embedding-operation-question">批准的检索问题</Label>
              <Input
                id="embedding-operation-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </>
          )}
          <Button type="button" variant="outline" disabled={busy} onClick={() => act("prepare")}>
            计算授权清单（不调用模型）
          </Button>
          <Label htmlFor="embedding-price-review">人工价格与Token上界证明JSON</Label>
          <textarea
            id="embedding-price-review"
            value={review}
            onChange={(e) => setReview(e.target.value)}
            rows={4}
            className="border p-2"
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || !review}
            onClick={() => act("review_price")}
          >
            登记价格证明（不调用模型）
          </Button>
          <Label htmlFor="embedding-operation-approval">核对后的操作授权JSON</Label>
          <textarea
            id="embedding-operation-approval"
            value={proposal}
            onChange={(e) => setProposal(e.target.value)}
            rows={4}
            className="border p-2"
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy || !proposal}
            onClick={() => act("authorize")}
          >
            批准操作额度（不调用模型）
          </Button>
          <p>
            索引必须在启用后按最终配置版本批准。启用本身不授予额度；变更配置版本使旧授权失效。不要重复点击重新准备。
          </p>
          <pre className="max-h-64 overflow-auto text-xs" data-testid="embedding-operation-receipt">
            {receipt}
          </pre>
          <p>撤销已有授权</p>
          <RevokeOperation onRevoked={() => query.refetch()} />
        </div>
      )}
    </details>
  );
}
function RevokeOperation({ onRevoked }: { onRevoked: () => Promise<unknown> }) {
  const [id, setId] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div>
      <Label htmlFor="embedding-operation-revoke">操作授权UUID</Label>
      <Input id="embedding-operation-revoke" value={id} onChange={(e) => setId(e.target.value)} />
      <Button
        type="button"
        disabled={!id || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await apiClient.post("/api/v1/ai/knowledge/embedding/operations", {
              action: "revoke",
              operation_id: id,
            });
            await onRevoked();
          } catch (error) {
            showApiError(error);
          } finally {
            setBusy(false);
          }
        }}
      >
        撤销后续请求授权
      </Button>
    </div>
  );
}
