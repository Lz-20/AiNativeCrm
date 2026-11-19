# Operações RAG controladas (0413)

## Contrato operacional

`EmbeddingOperationsPanel`, dentro de `/app/ai/knowledge/sources`, lê a projeção
segura de operações, provas e pedidos. O administrador usa a mesma rota autenticada
`/api/v1/ai/knowledge/embedding/operations` para preparar um manifesto **sem LLM**,
registrar sua revisão humana de preço e limite de entrada, autorizar ou revogar.
As duas permissões `ai_knowledge` e `ai_credentials` são necessárias para escrever.
Nenhum endpoint instala preços ou autorizações por padrão.

O preço é um **teto atestado por um humano**, não um valor inferido de um URL. O
revisor deve verificar a moeda, cobrança mínima/arredondamento e que o provedor
recusa entradas acima do teto de tokens informado. URL e hashes fixam a evidência;
não substituem a revisão. Sem prova confiável, não registre a revisão. Não usamos
caracteres/4 como garantia de tokens. Cada envio reserva o teto inteiro de tokens
e o preço máximo correspondente em microcentavos inteiros (1.000.000 = 1 centavo).

A migration adiciona três tabelas; não altera 0412, eventos, vetores antigos ou
aprovações do controlador root. `job_queue` tem outro ciclo de vida, por contato;
reutilizamos o pool, transações e locks PostgreSQL, não criamos outra fila geral.

## Identidade, retomada e admissão

Uma operação de índice liga organização + fonte + hash do documento extraído +
revisão dos objetos Storage/FAQ + manifesto ordenado + fingerprint + versão da
configuração. A unique persistente impede três eventos de criar três operações.
Um índice parcial mantém apenas uma operação running por fonte. Aquisição usa
advisory xact lock por fonte, row lock e lease de 180s com fencing crescente.

Cada pedido faz reserva transacional **commitada antes da rede**. Outra transação
revalida membro administrador, prova vigente, configuração/credencial ativa,
fonte/revisão, lease e fence; segura locks de configuração/fonte durante HTTP e
persistência. Desabilitar pode aguardar o pedido em voo, então impede o próximo.
Não há promessa de cancelar bytes já enviados ou de exactly-once no provedor.

Resposta confirmada fica no recibo privado junto de vetor, uso e trace seguro.
O mesmo modelo/conteúdo/fonte/tenant pode reutilizá-la. Reservas e resultados
unknown não são devolvidos ao saldo nem reenviados. Após crash entre reserva e
resposta, a operação bloqueia para conciliação humana. Após resposta persistida,
retoma da cópia sem nova chamada. Chunk write falhou? Para imediatamente; o
próximo executor pode reutilizar a resposta persistida, sem recalcular o vetor.

Só a transação final, com lease atual e todas as posições/hashes presentes,
marca ready, chama a RPC atômica de 0412 e completa a operação. A versão parcial
fica building e não é ativada; isto preserva progresso real. A chave não entra em
recibos, logs, JSON de UI ou prova de preço.

Consulta e validação passam pela mesma admissão, mas têm operações distintas.
Consulta liga também a versão ativa da fonte e a pergunta exata aprovada; não há
wildcard para perguntas geradas por Agent. Agent pode falhar fechado caso gere
outra pergunta: não aumentamos sua permissão ou orçamento automaticamente. Os
limites de DeepSeek continuam separados; esta mudança governa Embedding, não
promete controlar todas as chamadas do runtime de inferência.

## Eventos antigos e resultado incerto

Configuração desabilitada, credencial não validada, falta de aprovação, lease
ocupada e orçamento esgotado são `retry` de espera, com razão e próxima checagem;
`drainEventLog` mantém attempts e não marca consumed/done. Erros reais continuam
`error`. Não há migration que zere attempts ou ressuscite eventos mortos.

Para um evento já dead: preservar snapshot e erro; confirmar fonte/hash/profile,
verificar que nenhuma reserva ficou incerta, obter autorização e emitir **novo**
evento pelo endpoint normal por fonte, com correlação auditada ao antigo. O
evento antigo continua dead. Não reescrever o passado. Se houve pedido incerto,
primeiro conciliar trace/conta com humano; nenhuma ferramenta deste PR muda
unknown para sucesso ou autoriza repetição automática.

## Checklist do sistema vivo

1. Entradas: upload/reindex → event_log; administrador → prova/operação.
2. Saídas: admissão → HTTP controlado → versão/pgvector → ferramenta RAG.
3. Registro: audit de aprovação/revogação; pedidos duráveis com hash/uso/trace.
4. Tela: painel existente de conhecimento, subpainel de autorização/consumo.
5. Porta: navegação existente de conhecimento; nenhum novo destino isolado.
6. Anti-morte: espera com próximo horário; unknown exige humano, sem cobrança repetida.
7. Configuração: provas e autorizações na tela; ausência aparece como recusa.
8. Continuidade: humano aprova/revoga; worker devolve estado/erro/consumo para revisão.
9. Retorno: sucesso alimenta cache e dedupe; incerteza bloqueia novos envios.
10. Mapa: `acervo-de-conhecimento.architecture.json` inclui ledger e painel com arestas.

## Publicação

Não aplicar só a imagem: 0413 muda o Schema/Catalog e requer aprovação de expansão
independente. Não substituir o controlador VPS por arquivos antigos do Git.
Os hashes aprovados de 0412 ficam históricos. Uma nova transição precisa registrar
baseline antigo/novo, delta aprovado, backups/restauração e compatibilidade.
Rollback de imagem mantém tabelas/dados, **com Embedding desabilitado e sem pedidos
em voo**: a imagem antiga não entende a nova autorização e poderia gastar sem gate.
Não fazer down migration, remover cache ou limpar eventos para obter verde.
