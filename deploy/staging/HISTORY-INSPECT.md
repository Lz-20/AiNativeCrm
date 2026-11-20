# Inspeção root de histórico Staging

Destino: infraestrutura. Implementação separada do desenho PR18, baseada nos
bytes instalados 01df (PR16 → PR13 → PR11). Não instalar controlador antigo de
main. A entrega desta branch é código/CI, sem instalação ou aprovação válida.

## Interface e limites

Pela mesma forced-command `ainativecrm-deploy`, stdin JSON ≤4096 bytes:

```json
{"operation":"inspect","transaction":"20261120T020945Z-9f57202fb372"}
```

Também aceita o ID fixo de recuperação EA, um ID root no formato
`YYYYMMDDTHHMMSSZ-12hex`, ou o seletor literal `latest`. Não aceita SHA parcial,
path, SQL, shell, URL, opções Docker, chave extra ou JSON com chave duplicada.
`latest` devolve ID REAL do audit, nunca um ID calculado a partir do Run GitHub.

Resposta JSON v1, ≤60000 bytes; o cliente tem de verificar todo o contrato:

| Campo | Contrato |
|---|---|
| format / capability | 1 / staging-history-inspect-v1 |
| ok / status | boolean; authenticated, busy ou unknown |
| read_only / deployment_authorized | sempre true / false |
| transaction | ID root validado; null se ainda desconhecido |
| deployment_lock / backup_lock | available, held, unknown |
| state | current/previous (SHA, Schema, três OCI digests), pending sanitizado |
| record | operação, started/succeeded, identidade e evidências da transação pedida |
| incident | cadeia separada ac8 → recuperação EA e dois backups autenticados |
| evidence_sha256 | hash canônico da base histórica fixa, sem health/timestamp voláteis |
| root_state_sha256 / audit_sha256 | digests dos arquivos root atuais lidos sob lock |
| database | identidade fixa, 0412/0413, Catálogo/policy, três imagens reais/saúde e contagens de admissão |
| review | required/reviewed e digest do registro humano root, sem autorização de deploy |
| release_preparation_allowed | só true com prova completa e revisão humana vinculada |

Falha de path, UID/GID, mode, nlink, digest, identidade, estágio, lock, restore,
Catálogo, RLS, imagem, configuração ou pedido em voo retorna unknown/busy. Não
mostra exceções, argv, audit completo, credenciais, JWT, documento ou linha CRM.
Status ocupado é uma observação: lock pode estar ocupado antes de pending ser
gravado. Não significa que um deploy foi cancelado ou que não houve aceite.

## Fontes e confiança do incidente legado

`history_inspect.py` fixa o prefixo ORIGINAL de deployments.jsonl observado em
leitura autenticada: 14254 bytes, SHA256 cc1622a70fdf88413de4611e5ea2b71de656836669c51e20c072459e07d3ccf8.
Apêndices são permitidos, reescrita/truncamento ou terminais conflitantes não.
Fixa separadamente dois IDs, dois SHA/cohorts e os dois evidence.json originais
de backup. Cada membro do inventário é re-hasheado; source/restore/restart,
sequências e política Realtime são novamente comparados no tempo original.

O controlador 01df não guardou journal nativo por transação nem raw SSH request
para esse incidente. Não os fabricamos. `legacy_native_journal_present=false` e
`request_evidence_kind` declaram a reconstrução a partir da identidade do audit
original. O terminal succeeded do código 01df só ocorre após as três trocas,
health, core probe, boundary e save_state. A recuperação EA é outra transação,
com backup e terminal próprios. Um estado EA saudável sozinho não é prova.

Isto NÃO é assinatura retroativa nem prova contra um root comprometido antes
da observação. A fronteira de confiança é o root e seus bytes aprovados, como
nos protocolos 0412/0413. Prefixo e archives originais são preservados. O módulo
novo tem SHA256 fixado no engine; instalação posterior verifica ambos os arquivos.

## Revisão humana e qualificação posterior

Não há liberação por JSON da aplicação/Artifact. A única revisão reconhecida é
`/etc/ainativecrm-staging-deploy/history-review.json`, root:root 0600, nlink1,
diretório protegido, instalada SOMENTE sob autorização humana independente.
Campos exatos: format=1, scope=capability, approval_id UUID, approved_at UTC,
approved_by, authorization_source, evidence_sha256, deploy_transaction e
recovery_transaction. O digest precisa ligar a cadeia fixa de provas raiz.
Sem registro, draft NOT-APPROVED, futuro timestamp ou dado adulterado bloqueia.
Não gerar ou instalar registro válido nesta fase.

A revisão autentica resolução histórica, não autoriza release, modelo ou DDL.
Depois dela o PR17 adaptado ainda precisa qualidade independente da MESMA main
SHA e nova autorização de negócio. cancelled nunca equivale a cancelamento root.
O antigo previous ac8 é recusado; rollback exige o cohort EA explicitamente
revisado e as verificações originais de Schema/Embedding/inflight/cache/backup.
Não adiciona um cadastro arbitrário de cohorts aceitos.

## Transações posteriores e cancelamento

Antes de pending e de qualquer troca, o engine grava request.json imutável e
journal em diretório root 0700 de transactions/<ID>, com target/prior, pedido e
backup. Marca início/saúde de cada serviço e core; receipt imutável vincula
request, journal e state final. Arquivo 0600, O_NOFOLLOW/O_EXCL, fsync e rename
atômico. Fonte já tentada não repete automaticamente. Fonte deve ser a main
atual; um ancestral não basta. Nenhum SQL/backup de DB é executado pelo inspect.

Perda SSH ou Runner não apaga a transação. Consultar latest/ID é leitura; se
disco/receipt/audit/estado não fecham, manter unknown e bloquear novo deploy.
Prepared órfão também bloqueia. Não matar processo, limpar pending, reexecutar,
apagar Schema nem escolher previous automaticamente. Restauração root bem
sucedida pode ser consultada independentemente de Actions. Incidente futuro
diferente do par fixo requer nova análise/revisão, não herda exceção ac8.

O bloqueio de novo deploy não impede uma recuperação EA INDEPENDENTEMENTE
autorizada quando há manifest/journal root autêntico do deploy pendente ou já
aplicado sem receipt. Target/prior, audit e estado devem coincidir exatamente;
backup original e novo backup da recuperação continuam obrigatórios. Recuperar
imagens não completa o receipt ausente: recovery_of conserva o predecessor e a
qualificação global permanece unknown até outra revisão. Sem registro nativo,
com dados conflitantes ou alvo fora do EA fixo, a recuperação é recusada.

## Instalação futura separada

Somente engine.py e history_inspect.py são novos arquivos executáveis desta
adaptação; engine mantém mode0644, módulo0644, root:root, nlink1. Não alterar
ssh-entry.sh, wrapper sudo, sudoers, Docker, Compose, policy, SQL ou módulos
0412/0413. Não instalar a árvore inteira desta branch. Fazer antes backup fresco
e restore isolado, backup completo de root/config/state/metadados e verificar os
Hash do candidato/CI exato. Usar as mesmas deployment.lock/backup.lock sem
substituir inodes. Instalar módulo antes do engine, falha restaura os bytes
originais preservando evidência. Consultar ambos os IDs, comparar OCI e ambiente,
guardar prova não aprovada, pedir revisão humana. Nenhum deploy faz instalação.

## Living System Checklist

- Entrada concreta: deployments.jsonl, archives root e state/0412/0413 existentes.
- Saída concreta: inspect JSON → coordenador PR17 → recusa ou preparação para revisão.
- Registro/visibilidade: journal/receipt root, JSON sanitizado e Artifact de reconciliação GitHub.
- Porta: a forced-command existente, operação inspect fixa; nenhuma tela CRM nova.
- Próximo passo: unknown/busy/review required bloqueia entrega e exige operador.
- Configuração: arquivo root de revisão independente, ausente por padrão.
- Retorno: prova inconsistente impede a PR17 de repetir entrega; nenhuma tentativa muda prova antiga.
- Continuidade: humano recebe IDs e hashes completos; a decisão humana não é confundida com CI ou deploy.
- Mapa: este contrato liga root ledger/backup → cliente/observer, preservando o desenho histórico PR18.
