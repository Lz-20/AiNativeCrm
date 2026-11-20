# Proposta: reconciliação protegida de transações Staging

Status: SOMENTE DESENHO, sem implementação root instalável, sem autorização de
instalação ou execução. Base fixa: 01df0cff2b21f16a1143dc2dd83a44dbbef1f80f.
Depende de PR #16 → #13 → #11, ainda não integrados à main. Nunca substituir o
controlador instalado pelos arquivos antigos de main. Este PR não muda fonte,
Schema, permissões ou configuração do controlador.

## Problema e evidência

O Run 44655810765 foi cancelado depois que o servidor aceitou a entrega ac8de4b.
O SSH não devolveu deployment.json; a operação remota terminou. O operador
recuperou a coorte EA depois, porém previous ficou ac8de4b não aceito. O contrato
status de 01df publica current/pending, mas não recupera transaction/auditoria
perdidos. Current=EA não comprova a finalização dessa transação anterior.

O PR de cliente fix/ci-request-lifecycle-gates fecha a admissão nessa lacuna:
consulta CI independente da mesma SHA, nunca reenvia deploy nem escolhe previous
como rollback. Resultado ambíguo exige reconciliação protegida. A observação
separada usa SOMENTE status pela entrada SSH já existente.

## Contrato mínimo proposto para revisão futura

1. Operação de consulta fixa, limitada ao estado protegido e auditoria de entrega,
   pela MESMA forced-command. Sem shell, caminhos, URLs, SQL, container ou argumentos
   Docker arbitrários. Lista/capability versionada, dados sanitizados, limite de
   tamanho e leitura consistente do estado mesmo durante deployment.lock ocupado.
2. Identidade de requisição vinculada SHA, Schema e três OCI digests. Registro
   durável e fsync antes de aceitar side effects. Duplicata retorna estado/recibo,
   nunca repete DDL, backup ou troca de imagens. Request ID não é transaction ID.
3. A consulta precisa provar transaction REAL gerada pelo root, digest da
   requisição, fase, posse/estado do lock, source/prior/target, backup/restore,
   timestamps e resultado. Journal incompleto/COMMIT incerto permanece bloqueado.
4. Rollout concluído não equivale a coorte aceita: aceitação exige evidência
   vinculada de CI e verificação operacional. previous sozinho nunca autoriza
   rollback. Alvo fixo aceito + OCI + Schema + Embedding desabilitado + ausência
   de running/reserved/unknown são exigidos novamente no controlador.
5. Cancelamento cooperativo somente em pontos seguros, com confirmação root.
   Antes de side effects pode recusar; depois precisa concluir ou recuperar
   atomicamente pelo protocolo e gravar resultado. Desconectar SSH não cancela.
   Nunca matar o processo root nem limpar pending para liberar nova entrega.
6. Reconciliar a entrega ac8 precisa autenticar recibo/auditoria root existentes,
   rollback EA efetivamente executado e estado final. Não aceitar JSON arbitrário,
   ID GitHub como transaction, ignore-history ou novo approved hash para apagar
   incidente. Qualquer novo ato de reconciliação precisa autorização independente.

## Invariantes de compatibilidade e segurança

Preservar 0412 e 0413 approval/receipt/state, cadeia de Catálogo, política Realtime,
approved_schema_sha256, approved_catalog_sha256, bytes SQL e 17 arquivos de RAG.
Usar deployment.lock e backup.lock na ordem auditada, arquivos root owner/mode/
nlink e escrita atômica. Não ampliar sudoers, forced-command, SSH, Docker, portas,
DB roles ou RLS. Não instalar automaticamente o controlador por release de App.
Manter dados e vetores em rollback, sem down migration. API antiga continua
compatível até rollout independente do cliente capaz de autenticar capability.

## Critérios de aceitação para um futuro PR de implementação

| Cenário isolado | Resultado exigido |
|---|---|
| cancelamento antes de aceite | zero substituição, recusa autenticada |
| cancelamento após aceite / perda SSH | consulta recupera transaction real e fase |
| servidor ainda detém lock | busy distinto de ausência, sem kill/retry |
| processo cai entre fsync, troca e estado | reinício converge ou exige recuperação |
| sucesso remoto, CI falhou | incidente não aceito; nenhuma nova entrega |
| current EA, previous ac8 rejeitado | rollback implícito recusado |
| ID repetido / concorrência | no máximo uma transação de mutação |
| pedido/recibo adulterado / symlink/hardlink | recusa antes de efeito |
| alterações de Schema/Embedding/inflight | rollback recusado |
| cliente antigo e 0412/0413 | toda suíte anterior continua passando |

Executar testes de processos reais e transporte interrompido somente em ambiente
isolado, mais CI do candidato novo. Depois gerar lista exata de arquivos/hash,
backup/restauração do controlador, instalação separada e aprovação humana.
Este documento não alega nenhum desses testes root como executado.

## Limites desta proposta

Este PR apenas documenta o protocolo; não resolve a lacuna por instalar código.
Não está pronto para liberar uma nova entrega Staging automaticamente. A main
continua ac8, VPS EA, e o candidato root original continua 01df até autorização.
