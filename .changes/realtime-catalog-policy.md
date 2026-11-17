---
impacto: capacidade_nova
secao: corrigido
titulo: Validar partições de data do Realtime sem ignorar a estrutura do banco
---

O controlador opcional de staging passa a aceitar uma política root revisada
para separar as partições diárias conhecidas do Realtime da estrutura estática
protegida. Permissões, RLS, relações e dependências das partições são verificadas
antes da comparação; restauração de dados e Catalog continua integral. A política
exige atualização operacional autorizada separadamente e não é instalada pelo
PR ou por uma publicação de imagem. Sem ela, a proteção anterior permanece ativa.
