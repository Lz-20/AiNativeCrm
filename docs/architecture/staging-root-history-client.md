# Cliente da inspeção root de histórico

Destino: infraestrutura. Esta implementação depende de PR17 exato 43e9eba e da
capacidade root independente PR19 baseada em 01df/PR18. Nenhum módulo root é
instalado ou trazido à árvore desta branch. Não fazer deploy até instalar/revisar
o root separadamente e obter nova autorização de negócio.

## Duas fontes que devem concordar

GitHub fornece identidade do Run, SHA, tentativa, DAG, artifacts e qualidade.
O forced-command root fornece terminais reais, Schema/OCI, estado atual e cadeia
de recuperação autenticada. Nenhuma fonte sozinha transforma um resultado
cancelled em sucesso nem transforma current EA em prova histórica.

`staging_history.fetch` aceita somente resposta SSH fresca e validada da operação
fixa inspect; não existe opção para arquivo de prova, JSON de env ou Artifact
root. O transporte original mantém chave de host e limite64KiB. O contrato do
cliente valida capability, campos exatos, locks, ambos IDs, digest do incidente,
root state/audit, cadeias0412/0413, OCI,14Healthy, Embedding desabilitado e zero
running/reserved/unknown. `review=required` permite mostrar prova, nunca liberar
histórico. Só `reviewed` vindo do root com hash vinculado habilita preparação.

## O incidente e os Runs anteriores

Para o Run44655810765 fixo, verificar o release.json ORIGINAL pelo digest do
Artifact e intervalo da tentativa; comparar SHA,Schema,três digests com o
terminal ac8 root. Exigir separadamente o terminal da recuperação EA e review
humano. Classificação: failed_release_recovered_not_ci_accepted. Não mudar a
conclusãoGitHub nem reconhecer ac8 como cohort aprovado de rollback.

Os Runs anteriores bem sucedidos não tinham journal PR17. Só aceitamos seu
deployment.json/status-after ORIGINAIS de tentativa final bem sucedida e um
terminal correspondente dentro do prefixo root fixado. Artifacts de tentativas
anteriores/incompletos não valem; dois resultados completos possíveis recusam.
Não há exceção para outro Run cancelado, receipt inexistente, arquivo expirado
ou cadeia root desconhecida. Futuro incidente precisa nova revisão, sem herdar
automaticamente o par ac8/EA. O prefixo antigo não é reescrito.

## Admissão e observação

`staging_delivery` verifica CI independente antes de sequer consultar root;
consulta histórico na concorrência única existente e repete CI após status,
antes do deploy único e depois dele. Mesmo histórico revisto não contorna
independent E2E vermelho/pending/ausente, main movida ou outraSHA. Não altera a
qualidade esperada no PR17. O root também exige main atual, não ancestral.

`staging_reconcile` passa a usar status e inspect, somente leitura. Se perdeu
transaction, `latest` retorna ID real do audit; só vinculá-lo se releaseSchema,
SHA e digests coincidirem. Perda SSH, lock ocupado, falha ou falta de review
mantêm unknown. Mesmo com histórico revisto o observer não emite deploy ou
rollback e conserva allow_new_deploy=false. A admissibilidade futura é refeita
por outro ato, após nova autorização. previous ac8 continua sem rollback cego.

Evidência sanitizada aparece em root-inspection.json e no Artifact result ou
reconciliation. Ela serve para auditoria humana; não pode ser reimportada como
fonte confiável. Não executar código de Artifact ou fork. Não expandir SSH,
sudoers,Docker,roles,RLS ou fornecedor.

## Living System Checklist

- Entrada concreta: API GitHub de qualidade/originalArtifact e fixed root inspect.
- Saída: delivery_history → bloqueio/preparação; observer → reconciliação humana.
- Registro/visibilidade: root-inspection.json, journal e ArtifactGitHub sanitizado.
- Porta: Jobs já existentes de quality/manifest/deploy e observercompleted.
- Próximo passo: erro e desconhecido bloqueiam, não repetem operação.
- Configuração: review root independente, nunca chave nova ou override no cliente.
- Continuidade: operador recebe doisIDs/hashes e decide; CI não assina por ele.
- Retorno: estado não reconciliado impede a próxima publicação por histórico.

Este PR não instala controller, não cria approval válido e não publica. O root
PR19 tem sua própria base não integrada; integrar somente por revisão explícita.
