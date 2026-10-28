---
impacto: nada_mudou
secao: corrigido
titulo: QA do agente distingue provider controlado e execução externa
---

A verificação de capacidades registra o modo confirmado pelo servidor, mantém
cada corrida separada e distingue propostas de escrita de operações executadas.
No CI usa Agent e canal sintéticos próprios, com provider compatível com o runtime
controlado e janela de teste explícita. Erros HTTP e respostas vazias reprovam a
jornada, sem alterar as permissões ou os guardrails do produto.
