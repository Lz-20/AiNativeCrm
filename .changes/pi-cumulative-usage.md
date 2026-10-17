---
impacto: nada_mudou
secao: corrigido
titulo: Agentes de várias etapas usam o orçamento real sem cobrar turnos anteriores duas vezes
---
O limite de tokens e o registro de uso passam a consumir o acumulado informado pelo Pi uma única vez. A execução deixa de parar antecipadamente por contagem duplicada, sem retirar a parada quando o orçamento real se esgota.
