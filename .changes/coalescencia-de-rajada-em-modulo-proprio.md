---
impacto: nada_mudou
secao: alterado
titulo: A janela que junta as mensagens de uma rajada ganha módulo e teste próprios
---

Nada muda para quem opera: as mensagens seguidas de um mesmo contato continuam virando um turno só
do agente. O trecho que decide isso saiu de dentro do drain para um módulo com teste próprio, e o
teste prende o comportamento de hoje — inclusive a exclusão do job em espera que evita o cliente
ficar sem resposta quando a sessão antiga morre.
