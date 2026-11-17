# Catalog de Realtime: limite de aprovação

`catalog_policy.py` é uma biblioteca pura. Nenhuma requisição SSH cria política,
altera `approved_catalog_sha256`, executa DDL ou instala código privilegiado.
Sem `/etc/ainativecrm-staging-deploy/catalog-policy.json` o engine mantém a
comparação integral anterior, inclusive `database_catalog_drift`.

A política opcional exige instalação e revisão **separadas**. Ela fixa o digest
ARM64 do Realtime v2.143.3, o commit de origem revisado e a identidade original
do Catalog aprovado. `build_policy()` só trabalha com snapshots fornecidos:
confere o hash original e recusa qualquer diferença estática entre ele e o
snapshot atual. Não escreve arquivo nem torna a base atual aprovada.

## O que muda e o que não muda

- O backup continua comparando o Catalog **integral**, dados, Storage e reinício
  da cópia. Uma projeção estática igual nunca dispensa igualdade da restauração.
  A cópia lógica do PostgreSQL17 pode representar a flag `connoinherit` da PK
  como true após pg_restore. Apenas esse contexto de cópia aceita a representação,
  preservando definição e ligação ao pai; o source permanece exato. O engine
  recalcula provas sempre no contexto source, nunca aceita esse modo da cópia.
- Só relações `realtime.messages_YYYY_MM_DD` efetivamente ligadas por OID ao
  único pai `realtime.messages`, particionado por `inserted_at`, podem entrar
  na projeção. Cada faixa é exatamente um dia UTC, coerente com o nome.
- Owner/ACL/RLS, colunas/defaults, dois índices e seus pais, duas constraints,
  par composto/array e publication são comparados com o template revisado.
  Regras, triggers/policies extras, dependentes, extension membership, tabelas
  estrangeiras, subpartições e topologia desconhecida são recusados.
- A ausência de RLS nas folhas é o comportamento **observado e revisado** desta
  versão, com ausência de ACL de acesso direto para anon/authenticated/service_role.
  O pai mantém RLS. Ligar ou desligar flags, conceder acesso direto ou alterar
  uma política continua sendo drift, não uma normalização de permissões.
- Novas datas só entram na janela UTC ontem..hoje+3. Remoções só são aceitas
  após o prazo revisado de três dias, comparadas à última prova root verificada
  (ou ao conjunto inicial explicitamente revisado). A história integra cada
  evidência e nunca vem de um argumento da requisição SSH.
  Na primeira ativação, o conjunto inicial só é usado após autenticar o último
  atestado legado, sua origem, restauração completa e recibo do Catalog original
  desse backup. História ausente/corrompida ou troca de política falha fechada.
  O JSON da política recusa chaves duplicadas e números não finitos.
- Todo o resto permanece no hash estático: CRM, auth, storage, funções, roles,
  grants, RLS, pai Realtime, objetos não reconhecidos e o segundo banco.

O registro de origem significa "mecanismo upstream e imagem revisados". Não
afirma provar retrospectivamente qual processo emitiu cada DDL; estatísticas
SQL não substituem auditoria imutável. Origem desconhecida, imagem diferente
ou metadados insuficientes falham fechados.

## Instalação futura (não é uma operação desta mudança)

1. Fixar um novo Commit e obter revisão/CI dos módulos e testes. Manter a versão
   e os hashes antigos do engine, helper, estado, política, atestado e evidências.
2. Suspender novos disparos de release mediante autorização operacional, obter
   os locks de deploy e backup, exigir pending vazio. Não parar Supabase.
3. Conferir o snapshot original contra seu `evidence.json` e contra o hash ainda
   presente em `state.approved_catalog_sha256`. Obter topologia em transação
   somente leitura e revisar as diferenças e o contrato de imagem upstream.
4. Gerar um **arquivo novo** de política para revisão. Conferir a projeção
   estática do original e do atual, sem alterar o hash legado do estado.
5. Instalar o conjunto coerente de `engine.py`, `backup_verify.py` e
   `catalog_policy.py` por transporte e staging root autorizados, conferindo SHA256,
   root:root 0644 e pais não graváveis. Política root:root 0600 em pasta 0700.
   Nenhum `curl | sh`, módulo vindo do checkout candidato ou `secrets: inherit`.
6. Verificar primeiro sem política (modo legado), depois ativar a política sob
   lock, rodar identidade somente leitura, backup novo e restauração isolada.
   O engine recalcula a projeção a partir dos arquivos privados e seus hashes.
7. Se falhar, restaurar o conjunto de código/política anterior sob o mesmo lock;
   não mudar dados, não aprovar outro hash e não apagar evidência ou pending.

O upgrade é fora da publicação de imagens e requer autorização independente.
Não instalar este diretório diretamente com um job do PR. A falha fecha o gate
antes de imagens/pending/rollout; auditoria, três serviços fixos e rollback
continuam sob o engine existente.

## Testes

`python -m unittest discover -s tests/deployment -p 'test_*.py' -v` executa as
regressões puras e do gate root com arquivos sintéticos. O teste real explícito
`tests/deployment/catalog_isolated_test.py` usa somente imagem já em cache,
novo container com rede none, filesystem somente leitura, tmpfs, 1 CPU/1 GiB e
dados sintéticos. Não recebe DSN de produção nem container de origem. O teste
compara pg_dump/pg_restore, dados/Catalog e reinício da cópia; seu resultado é
separado dos testes unitários e não deve ser inferido de mocks.

O workflow PR-only `.github/workflows/catalog-policy-ci.yml` executa essa prova
em runner GitHub nativo ARM64, com PostgreSQL 17 fixado por digest e o head exato
do PR. Publica apenas evidência de testes sintéticos; não acessa a VPS nem publica
imagens. A CI preserva logs de falha e recibos SHA256 do código examinado.
