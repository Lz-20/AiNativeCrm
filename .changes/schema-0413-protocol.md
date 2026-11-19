---
impacto: exige_acao
secao: adicionado
titulo: Revise separadamente a expansão 0413 antes de atualizar a base de conhecimento
---
O controlador de Staging pode autenticar a cadeia fixa 0412 → 0413 sem substituir
os hashes históricos ou a política Realtime. Falhas ou COMMIT incerto mantêm a
publicação bloqueada; o registro de Schema não publica imagens nem ativa modelos.

## Requer atenção

A instalação independente dos arquivos revisados, o ensaio isolado da base atual,
a aprovação humana e o DDL exigem autorizações separadas. Nenhuma aprovação é
instalada de fábrica. Antes de voltar à aplicação ea26ee4, mantenha Embedding
desabilitado e comprove que não há pedidos em voo ou resultados incertos.
