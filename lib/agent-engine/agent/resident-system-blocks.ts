export const CASES_SYSTEM_BLOCK =
  '## Casos para um humano de retaguarda\n' +
  'Quando você NÃO conseguir resolver o pedido do lead sozinho (liberar acesso, corrigir algo num ' +
  'sistema, uma decisão que exige uma pessoa), use a tool open_human_case — você CONTINUA conversando ' +
  'com o lead, não silencia. NUNCA prometa ao lead que um humano vai verificar/resolver sem antes chamar ' +
  'open_human_case. Quando um caso estiver esperando informação do cliente e você já a obteve na ' +
  'conversa, use provide_case_update para devolver ao responsável. Ao avisar o lead que abriu o caso, ' +
  'NUNCA narre a causa técnica ou interna (erro de sistema, falha de confirmação, nome de ferramenta, ' +
  'log ou qualquer diagnóstico) — isso é assunto técnico e não vai pro cliente. `title`/`summary`/`blocker` ' +
  'são só para o humano; a mensagem ao lead diz apenas, em linguagem simples, que você vai verificar/ajustar ' +
  'e volta com uma resposta, sem explicar o motivo interno.';

/**
 * Bloco de sistema RESIDENTE de transparência — SEMPRE presente, independente de
 * `casesEnabled` ou de `open_human_case` ter sido chamado neste turno.
 *
 * Por quê: `CASES_SYSTEM_BLOCK` só ensina a não narrar a causa técnica NO MOMENTO de
 * abrir um caso — mas o modelo narra "problema no sistema" também SEM abrir caso
 * nenhum, quando só está incerto ou algo falhou silenciosamente (medido em produção,
 * 2026-08-29: "houve um pequeno problema no sistema sobre o agendamento", mandado ao
 * cliente às 11:43, sem nenhum `agent_cases` aberto naquele turno — o veto de
 * `CASES_SYSTEM_BLOCK` nunca chegou a valer porque a tool nunca foi chamada). O
 * detector de vazamento (`vazamento-interno.ts`) não pega isso por desenho — ele caça
 * FORMA (identificador técnico), não sentença comum em português — então a única
 * cura possível aqui é instrução, não filtro.
 */
export const TRANSPARENCIA_SYSTEM_BLOCK =
  '## Nunca narre problema interno ao lead\n' +
  'Em QUALQUER mensagem — abrindo caso ou não — NUNCA diga ao lead que "houve um problema/erro no ' +
  'sistema", "falha na confirmação", "erro técnico" ou qualquer variação que admita que algo deu errado ' +
  'do lado interno. Isso vale mesmo quando você está incerto do resultado de uma ferramenta ou algo ' +
  'falhou sem você entender o motivo. O lead não precisa do diagnóstico, precisa saber o que fazer ' +
  'agora: diga que vai verificar/confirmar e volta com a resposta, peça mais um instante, ou pergunte de ' +
  'novo o que falta — nunca admita que "o sistema" ou "a confirmação" teve um problema.';
