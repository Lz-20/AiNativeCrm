"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

/**
 * O papel que organiza o sistema, medido — as três medidas que a spec 16 §7
 * prometeu e que não existiam.
 *
 * `promessas.assumidas` e não "quitadas": o sistema não sabe se a promessa foi
 * CUMPRIDA (agendar um retorno não é cumprir). Publicar "quitadas" seria um
 * número que nenhuma linha apura.
 */
export interface MetricasDoOperador {
  dias: number;
  turnos: number;
  agiu: number;
  promessas: { declaradas: number; assumidas: number; semDono: number };
  quisAgirENaoPode: number;
}

export function useOperatorMetrics(habilitado: boolean) {
  return useQuery({
    queryKey: ["ai", "operator-metrics"] as const,
    queryFn: async () =>
      (await apiClient.get<{ data: MetricasDoOperador }>("/api/v1/ai/operator-metrics")).data,
    // Não busca quando o papel está desligado: a tela não faz pergunta cuja
    // resposta ela já sabe que é vazia.
    enabled: habilitado,
  });
}
