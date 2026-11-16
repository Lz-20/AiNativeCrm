"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { AgentBindingSummary } from "@/lib/ai/agents/model-binding";
import { useT } from "@/hooks/i18n/useT";

export function EffectiveModelBinding({
  agentId,
  versionId,
}: {
  agentId: string;
  versionId: string;
}) {
  const t = useT();
  const query = useQuery({
    queryKey: ["ai", "agents", agentId, "effective-model", versionId],
    queryFn: async () =>
      (
        await apiClient.get<{ data: AgentBindingSummary }>(
          `/api/v1/ai/agents/${agentId}/versions/${versionId}/test`,
        )
      ).data,
    staleTime: 0,
  });
  if (query.isPending) return <p role="status">{t("正在读取实际运行配置…")}</p>;
  if (query.isError || !query.data)
    return <p role="alert">{t("无法读取实际运行配置，请检查组织模型设置。")}</p>;
  const binding = query.data;
  const ready = binding.credentialStatus === "matched" || binding.credentialStatus === "platform";
  return (
    <section className="rounded-md border p-3 text-sm" data-testid="effective-model-binding">
      <p className="font-medium">
        {t("实际运行模型")}：{binding.provider} / {binding.model}
      </p>
      <p>
        {t("绑定模式")}：{binding.bindingMode}
      </p>
      <p>
        {t("配置来源")}：
        {binding.source === "organization_default" ? t("组织默认配置") : t("固定版本配置")}
      </p>
      <p role={ready ? "status" : "alert"}>
        {t("凭据状态")}：
        {ready
          ? binding.credentialStatus === "platform"
            ? t("使用同 Provider 的安装凭据")
            : t("Provider 匹配")
          : binding.credentialStatus === "mismatch"
            ? t("Provider 不匹配，运行已阻止")
            : binding.credentialStatus === "ambiguous"
              ? t("无法确定默认凭据，运行已阻止")
              : t("没有可用凭据，运行已阻止")}
      </p>
      {binding.source === "organization_default" && (
        <p className="text-xs text-muted-foreground">
          {t(
            "此 Agent 跟随组织默认模型；版本中保存的模型和凭据不参与运行。请在组织模型设置中修改。",
          )}
        </p>
      )}
    </section>
  );
}
