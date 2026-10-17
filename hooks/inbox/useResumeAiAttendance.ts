"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

interface ResumeArgs {
  conversation_id: string;
}

/** O que a pessoa fez, devolvido junto com o controle — nunca só o controle. */
export interface ContinuidadeDaRetomada {
  houve_atendimento_humano: boolean;
  resumo: string;
  decisoes: number;
  notas: number;
}

interface ResumeResponse {
  data: { reactivated: boolean; continuidade: ContinuidadeDaRetomada };
}

/**
 * Devolve a conversa ao atendimento automático.
 *
 * A rota existia desde a IA-06 e NENHUMA tela a chamava — passagem para humano
 * sem caminho de volta na interface. Enquanto isso, ela também não devolvia de
 * verdade (ver `lib/escalacao/retomada.ts`). O botão e o conserto andam juntos
 * de propósito: um botão sobre a rota antiga seria uma porta para uma sala vazia.
 */
export function useResumeAiAttendance() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: ResumeArgs) =>
      apiClient.post<ResumeResponse>(
        `/api/v1/conversations/${args.conversation_id}/reactivate-bot`,
        {},
      ),
    onError: (err) => showApiError(err),
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}
