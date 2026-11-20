# Admissão e reconciliação da entrega Staging

Destino: infraestrutura. Entrada: push de main aprovado. Saída: recibo de
qualidade → manifest → entrada SSH fixa → transaction → status verificado ou
incidente visível no artifact `staging-reconciliation-*`. Nenhuma ação de modelo.

## Qualidade independente antes de qualquer entrega

`scripts/staging_release_guard.py` consulta os workflows independentes `ci.yml`,
`e2e.yml`, `perf.yml`, `rag-operations-isolated.yml` e `release-safety-ci.yml` da mesma main SHA, repositório, evento push e tentativa.
Inspeciona cada Job/matrix leg, inclusive ANTES da conclusão do agregador.
O workflow_call verde não substitui um irmão independente vermelho. Falha,
cancelamento, timeout, pulo de Job não aprovado, main movida ou inventário
incompleto recusam autorização. Check ausente/em andamento espera somente no
gate limitado; fora dele, recusa. Não há workflow_run de publicação nem ciclo:
os workflows de qualidade não esperam Staging.

Os skips de TESTES externos já condicionais permanecem dentro de Jobs bem
sucedidos; não autorizam pular uma perna inteira na main. Imagens podem ser
construídas em paralelo, mas `release.json` só nasce depois do gate independente.
O gate é reconsultado imediatamente antes e depois da entrega.

## Uma tentativa não é uma conexão

`staging_delivery.py` reclama o journal antes do envio e chama o comando SSH
original exatamente uma vez. Não modifica SQL, imagem, chave ou operação no
servidor. A identidade de host continua estrita. Sinal/cancelamento/grupo de
processos só pode interromper o cliente SSH, não prova que o servidor parou.
Depois do envio, falta de resposta é `operator_reconciliation_required`.

GitHub registra duravelmente o início do Job deploy mesmo se o Runner morrer
antes do upload: dentro do mesmo grupo de concorrência, uma segunda tentativa
da mesma SHA ou qualquer entrega anterior sem recibo original bem sucedido é
recusada ANTES de SSH. O journal local não é apresentado como armazenamento
durável após SIGKILL. A evidência no serviço GitHub é conservadora: pode exigir
auditoria mesmo se o Job morreu antes do envio, nunca presume envio inexistente.

`staging-reconcile.yml` observa a conclusão do workflow original independentemente
do seu Runner. Executa somente código de main confiável e lê artifacts JSON
limitados por nome/tamanho/hash; nunca executa código de artifact, checkout de
fork ou comando recebido do usuário. A única operação remota é `status`.
Falha de consulta/lock ocupado é desconhecido; sucesso no alvo sem transaction
recebida é aplicado, mas sem reconciliação comprovada. CI falho e aplicação já
concluída vira incidente, não rollback cego para previous. Artifacts e summary
preservam SHA, Run ID, transaction REAL quando disponível e estado observado.

## Limitação explícita do controlador instalado

O controlador root independente 01df0cff inclui a cadeia 0412/0413 que main ainda
não contém. **Não instalar os arquivos de deploy/staging desta branch.** Ele já
usa deployment.lock também para status, portanto uma consulta bem sucedida é
serializada com a entrega. Porém seu status não publica previous, transação
ativa/última, journal nem auditoria de aceitação. Em caso de resposta perdida,
não existe prova automática do transaction ID por esse contrato. Não fabricar
um ID a partir de GITHUB_RUN_ID, nem inferir rollback a partir de current.

O cliente corrigido mantém essa lacuna FECHADA: entregas anteriores ambíguas
(incluindo 44655810765) bloqueiam novas entregas. Uma leitura atual de EA não
apaga o incidente; não há `--ignore`, aprovação JSON arbitrária ou escape no
workflow para limpá-lo. A operação rollback do workflow legado recusa execução
porque previous pode ser ac8de4b não aceito. Recuperação real continua uma
aprovação independente pelo operador, com alvo fixo, Schema e orçamento conferidos.

Isso significa que **este PR não basta para autorizar automaticamente uma nova
publicação da VPS atual**. É necessário protocolo root adicional ou outra
reconciliação protegida, separadamente implementada, testada e aprovada. Proposta
root em PR separado, baseada em 01df, deverá preservar TODOS os bytes/semântica
0412/0413 e a política dinâmica, sem alterar hashes ou privilégios.

## Plano root separado (não implementado/instalado aqui)

1. Expor leitura fixa e limitada de recibo/estado da entrega pela mesma entrada
   forced-command, sem shell/SQL/path/URL/container argumentos. Campos: capability
   version, transaction real, request digest, source/schema/digests, fase,
   current/prior/target, resultado, restauração e auditoria protegida.
2. Estado de operação aceito deve ser durável ANTES de trabalho caro/side effect;
   um request ID estritamente validado não pode executar novamente a mesma SHA.
   Consultas devem distinguir lock ativo de ausência de transação, sem forçar kill.
3. Aceitação de negócio/CI deve ser distinta de mero sucesso de rollout. Preservar
   histórico de coortes aceitas; previous não concede aceitação. Recuperação só
   para grupo aceito fixo e contrato Schema/Embedding/inflight autenticados.
4. Cancelamento cooperativo só em pontos revisados; antes de rollout pode parar,
   durante side effects precisa concluir/recuperar pelo protocolo e publicar
   resultado. Perda de ACK nunca autoriza repetição ou limpeza de pending.
5. Vincular recibo novo ao antigo e a seus backups; não tocar approved_schema,
   approved_catalog, 0412/0413 approval/receipt/policy. Arquivos root, nlink,
   permissões, hashes e inodes/ordem dos locks continuam restritos.
6. Novo candidato fixo, testes de processo/transportes interrompidos em ambiente
   privado e CI. Instalação e reenquadramento do incidente ac8 exigem autorização
   independente; não instalar/ativar isso pela publicação de negócio.

## Living System Checklist

- Entrada: main SHA + Jobs reais pela API GitHub.
- Consumidor: manifest e entrega limitada, sem novo privilégio root/Docker.
- Visibilidade: quality.json, delivery-journal.json, reconciliation.json e artifacts.
- Próximo passo: recusa explícita ou auditoria protegida com transaction, nunca retry.
- Laço de erro: falha/ambiguidade bloqueia admissões seguintes pelo histórico,
  incidente sobrevive ao Runner via observer separado e evidencia a lacuna root.
- Compatibilidade: nenhum Schema/17 arquivos de orçamento ou dado de CRM alterado;
  cancelamento do cliente não é apresentado como revogação remota.
