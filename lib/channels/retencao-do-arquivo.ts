/**
 * A PODA DO ARQUIVO DE WEBHOOKS.
 *
 * ─── O defeito, medido numa instalação real ─────────────────────────────────
 *
 * `webhook_events_log` guarda o corpo cru de todo webhook que entra, e nunca
 * foi podado por ninguém. Em 20/08/2026, no banco do dono deste fork:
 *
 *   banco inteiro ............ 545 MB
 *   webhook_events_log ....... 468 MB   (86%)
 *   api_audit_log ............  27 MB
 *   event_log ................  20 MB
 *   messages .................  3,2 MB
 *
 * As 56.291 linhas eram TODAS dos últimos 20 dias — não havia nenhuma com mais
 * de 30. Ou seja: ~23 MB/dia, ~700 MB/mês, sem teto. O plano gratuito do
 * Supabase acaba em 500 MB, que é onde a maioria dos clones vive, e o dado de
 * negócio inteiro (mensagens, contatos, leads) não chegava a 10 MB.
 *
 * ─── Esvaziar, e não apagar ─────────────────────────────────────────────────
 *
 * Apagar a linha responderia ao espaço e mataria o instrumento. A pergunta que
 * este arquivo existe para responder é a de DEPOIS do incidente — "quantos
 * eventos de que tipo chegaram, quando, e a assinatura conferia?" — e foi ela
 * que decidiu o caso das identidades opacas (`@lid`), contando "76 de 76" no
 * banco.
 *
 * As três colunas pesadas são ~97% do peso; a linha sem elas custa ~200 B.
 * Esvaziando, o índice forense inteiro sobrevive por ~11 MB.
 *
 * ─── Por que em lotes, e por que dois passos ────────────────────────────────
 *
 * Um `update` sem teto sobre 31 mil linhas segura a tabela que TODO webhook
 * escreve — a poda derrubaria a entrada de mensagem, que é o oposto do que ela
 * existe para proteger. O lote pequeno, chamado de 5 em 5 minutos (o crontab
 * do serviço `scheduler`), chega ao
 * mesmo lugar sem nunca ser o dono de uma trava longa.
 *
 * São dois passos porque `supabase-js` não escreve `update ... where id in
 * (select ... limit n)`: primeiro escolhe os ids, depois esvazia por id. As
 * duas idas custam menos que a trava que a alternativa pediria.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** Quantas linhas cada rodada esvazia. Ver o cabeçalho: lote pequeno é o ponto. */
export const LOTE_PADRAO = 500;

export interface ResultadoDaPoda {
  /** Linhas que perderam o corpo nesta rodada. */
  esvaziadas: number;
  /** Linhas apagadas de vez (velhas demais até para o índice forense). */
  apagadas: number;
  /** `true` quando o lote encheu — ainda há trabalho para a próxima rodada. */
  temMais: boolean;
}

function limiteEm(dias: number): string {
  return new Date(Date.now() - dias * 86_400_000).toISOString();
}

/**
 * Esvazia o corpo das linhas velhas e apaga as velhas demais.
 *
 * Os dois horizontes são independentes de propósito: o primeiro protege o
 * ESPAÇO (o corpo é 97% do peso) e o segundo protege a TABELA de crescer em
 * número de linhas para sempre. Colapsá-los num só forçaria a escolha entre
 * perder o índice forense cedo ou carregar o corpo por meses.
 */
export async function podarArquivoDeWebhooks(
  admin: SupabaseClient,
  opcoes: { diasComCorpo: number; diasParaApagar: number; lote?: number },
): Promise<ResultadoDaPoda> {
  const lote = opcoes.lote ?? LOTE_PADRAO;

  // ── 1. Esvaziar o corpo ───────────────────────────────────────────────────
  //
  // `archived_at is null` é o que torna a rodada IDEMPOTENTE: linha já esvaziada
  // não volta a ser escolhida, então rodar duas vezes seguidas não custa nada e
  // não escreve nada. É também o predicado do índice parcial da 0163.
  const { data: alvos, error: erroBusca } = await admin
    .from("webhook_events_log")
    .select("id")
    .is("archived_at", null)
    .lt("received_at", limiteEm(opcoes.diasComCorpo))
    .order("received_at", { ascending: true })
    .limit(lote);

  if (erroBusca) {
    logger.warn("[retencao-webhook] não consegui escolher as linhas", {
      detail: erroBusca.message.slice(0, 160),
    });
    return { esvaziadas: 0, apagadas: 0, temMais: false };
  }

  const ids = (alvos ?? []).map((r) => (r as { id: string }).id);
  let esvaziadas = 0;

  if (ids.length > 0) {
    const { error: erroUpdate } = await admin
      .from("webhook_events_log")
      .update({
        raw_body: null,
        payload_parsed: null,
        headers: null,
        // O carimbo é o que diz "o corpo existiu e foi descartado" — sem ele,
        // NULL se confundiria com "nunca teve corpo", e a próxima pessoa a
        // investigar não saberia se o arquivo falhou ou se a poda passou.
        archived_at: new Date().toISOString(),
      })
      .in("id", ids);

    if (erroUpdate) {
      logger.warn("[retencao-webhook] não consegui esvaziar o lote", {
        detail: erroUpdate.message.slice(0, 160),
      });
    } else {
      esvaziadas = ids.length;
    }
  }

  // ── 2. Apagar as velhas demais ────────────────────────────────────────────
  //
  // Só depois do horizonte longo. Aqui a linha já não tem corpo há muito tempo,
  // então o que se perde é o registro de que um evento existiu — aceitável
  // passados meses, e é o único jeito de a tabela não crescer para sempre em
  // número de linhas.
  const { data: apagadasRows, error: erroDelete } = await admin
    .from("webhook_events_log")
    .delete()
    .lt("received_at", limiteEm(opcoes.diasParaApagar))
    .select("id")
    .limit(lote);

  if (erroDelete) {
    logger.warn("[retencao-webhook] não consegui apagar as velhas", {
      detail: erroDelete.message.slice(0, 160),
    });
  }

  return {
    esvaziadas,
    apagadas: (apagadasRows ?? []).length,
    // Lote cheio = ainda há fila. Quem chama pode usar isto para saber que a
    // poda ainda não alcançou o estado estável — útil no primeiro dia, quando
    // há 31 mil linhas atrasadas e a varredura leva várias rodadas.
    temMais: ids.length >= lote,
  };
}
