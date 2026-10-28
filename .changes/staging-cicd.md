---
impacto: capacidade_nova
secao: adicionado
titulo: Publicação ARM64 de staging com verificação e retorno à versão anterior
---

O staging deste fork passa a ter um fluxo separado para verificar o código,
construir as três imagens ARM64 e atualizar somente app, worker e scheduler por
digests registrados. O ambiente protegido da VPS e os serviços existentes são
preservados. A entrada de deploy verifica backup restaurável, schema, saúde e
consultas de um usuário comum; falhas restauram as imagens anteriores sem
reverter o banco.

A ativação automática começa desligada e depende da aceitação real de uma
publicação manual e de um teste de falha com retorno. Mudanças de SQL ou schema
seguem para revisão humana. Esta é uma capacidade opcional de infraestrutura
do staging; o fluxo de publicação manual distribuído pelo projeto permanece.
