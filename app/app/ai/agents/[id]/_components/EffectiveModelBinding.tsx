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
  if (query.isPending) return <p role="status">{t("Carregando a configuração efetiva…")}</p>;
  if (query.isError || !query.data)
    return <p role="alert">{t("Não foi possível carregar a configuração efetiva. Confira o modelo da organização.")}</p>;
  const binding = query.data;
  const ready = binding.credentialStatus === "matched" || binding.credentialStatus === "platform";
  return (
    <section className="rounded-md border p-3 text-sm" data-testid="effective-model-binding">
      <p className="font-medium">
        {t("Modelo efetivo")}：{binding.provider} / {binding.model}
      </p>
      <p>
        {t("Modo de vínculo")}：{binding.bindingMode}
      </p>
      <p>
        {t("Origem da configuração")}：
        {binding.source === "organization_default" ? t("Configuração padrão da organização") : t("Configuração fixa da versão")}
      </p>
      <p role={ready ? "status" : "alert"}>
        {t("Estado da credencial")}：
        {ready
          ? binding.credentialStatus === "platform"
            ? t("Usando a credencial da instalação para o mesmo provedor")
            : t("Provedor da credencial corresponde")
          : binding.credentialStatus === "mismatch"
            ? t("Provedor da credencial não corresponde; execução bloqueada")
            : binding.credentialStatus === "ambiguous"
              ? t("Credencial padrão ambígua; execução bloqueada")
              : t("Nenhuma credencial disponível; execução bloqueada")}
      </p>
      {binding.source === "organization_default" && (
        <p className="text-xs text-muted-foreground">
          {t(
            "Este agente usa o modelo padrão da organização. O modelo e a credencial salvos na versão não são usados. Altere nas configurações de modelo da organização.",
          )}
        </p>
      )}
    </section>
  );
}
