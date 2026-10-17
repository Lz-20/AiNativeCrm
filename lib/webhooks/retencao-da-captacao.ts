/**
 * A PODA DO HISTÓRICO DE LEADS CAPTADOS.
 *
 * ─── Por que ela é DIFERENTE da poda do arquivo forense ─────────────────────
 *
 * `webhook_events_log` é esvaziado em 7 dias e apagado em 90, porque lá o
 * corpo cru é 97% do peso e ninguém o lê depois de uma semana. Aqui é o
 * oposto: a linha É o produto — o dono do negócio abre a aba "Leads recebidos"
 * para responder "quem chegou, com que dados, de onde", e a resposta que
 * interessa costuma ser de meses atrás ("de qual campanha vieram os clientes
 * que fecharam?").
 *
 * Então NÃO existe o passo de "esvaziar mantendo a linha": ou o registro serve
 * inteiro, ou não serve. Um horizonte só, longo.
 *
 * ─── O tamanho, medido e não estimado no escuro ─────────────────────────────
 *
 * Uma linha por formulário preenchido. As colunas pesadas são `fields` e `utm`
 * (jsonb do formulário, cortado em 60 campos × 2.000 caracteres por
 * `limitarCampos`), mais `user_agent` (500). O caso realista fica em ~1 kB:
 *
 *   300 leads/dia × 365 dias × ~1 kB ≈ 110 MB/ano
 *
 * Não é o arquivo bruto (23 MB/DIA, medido), mas também não é nada num plano de
 * 500 MB — que é onde a maioria dos clones vive. Daí o default de 365 dias:
 * cobre o ano fiscal inteiro e ainda deixa o banco caber.
 *
 * ─── O piso, e por que ele NÃO é um mecanismo novo ──────────────────────────
 *
 * A política (padrão, piso, e a frase de aviso quando o número do operador não
 * vale como escrito) vem de `lib/retencao/politica.ts` — o mesmo módulo que a
 * poda da fila e o expurgo da auditoria usam. Um segundo mecanismo de piso aqui
 * seria duplicação sem fonte declarada, e as duas cópias divergiriam no
 * primeiro ajuste.
 *
 * O que este arquivo acrescenta é o LOG do aviso. `interpretarRetencao` devolve
 * a frase; jogá-la fora faria a poda elevar o número em SILÊNCIO, e o operador
 * que escreveu `LEAD_CAPTURE_RETENTION_DAYS=1` descobriria pela ausência de
 * efeito — falha fechada na ação e fechada também na informação, que é o pior
 * dos dois mundos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import {
  interpretarRetencao,
  RETENCAO_CAPTACAO_DIAS_PADRAO,
  RETENCAO_CAPTACAO_DIAS_PISO,
} from "@/lib/retencao/politica";

/** Lote por rodada. Mesmo tamanho da poda do arquivo, pelo mesmo motivo: nunca ser dono de uma trava longa. */
export const LOTE_PADRAO_DA_CAPTACAO = 500;

export interface ResultadoDaPodaDeCaptacao {
  apagadas: number;
  /** `true` quando o lote encheu — ainda há fila para a próxima rodada. */
  temMais: boolean;
  /** Os dias de fato aplicados, depois do piso. A tela/log mostra o que VALEU. */
  diasAplicados: number;
}

export async function podarHistoricoDeCaptacao(
  admin: SupabaseClient,
  opcoes: { diasBrutos: string | undefined; lote?: number },
): Promise<ResultadoDaPodaDeCaptacao> {
  const lote = opcoes.lote ?? LOTE_PADRAO_DA_CAPTACAO;
  const politica = interpretarRetencao(opcoes.diasBrutos, {
    chave: "LEAD_CAPTURE_RETENTION_DAYS",
    padrao: RETENCAO_CAPTACAO_DIAS_PADRAO,
    piso: RETENCAO_CAPTACAO_DIAS_PISO,
  });
  // O aviso é a metade que quase se perde: sem ele, quem escreveu um número que
  // não valeu descobre pela ausência de efeito, meses depois.
  if (politica.aviso !== null) {
    logger.warn("[retencao-captacao] o valor configurado não foi usado como escrito", {
      detail: politica.aviso,
    });
  }
  const dias = politica.dias;
  const limite = new Date(Date.now() - dias * 86_400_000).toISOString();

  // `received_at` é a coluna do índice `webhook_lead_captures_poda_idx`, criado
  // com este predicado em mente (migration 0174). Sem filtro de organização de
  // propósito: a poda varre pela ponta mais velha e não sabe escolher tenant —
  // é o que a torna incapaz de ser usada como apagador dirigido.
  const { data, error } = await admin
    .from("webhook_lead_captures")
    .delete()
    .lt("received_at", limite)
    .select("id")
    .limit(lote);

  if (error) {
    // Falha ABERTA na ação (o banco cresce um pouco mais) e ABERTA na
    // informação: uma poda que falha em silêncio vira "o disco encheu e
    // ninguém sabe por quê" seis meses depois.
    logger.warn("[retencao-captacao] não consegui apagar o lote", {
      detail: error.message.slice(0, 160),
      dias_aplicados: dias,
    });
    return { apagadas: 0, temMais: false, diasAplicados: dias };
  }

  const apagadas = (data ?? []).length;
  return { apagadas, temMais: apagadas >= lote, diasAplicados: dias };
}
