---
impacto: exige_acao
secao: corrigido
titulo: Recuse entregas sem todos os checks e confirme o fim do acompanhamento
---
A saída do acompanhamento consome o recibo completo antes de navegar. A entrega
Staging exige os Jobs independentes da mesma versão e conserva resultados de SSH
desconhecidos para auditoria, sem repetir deploy ou voltar cegamente a previous.

## Requer atenção

Incidentes antigos sem recibo reconciliado bloqueiam publicação.
O operador deve revisar o protocolo root em separado; este código não instala
controlador, não limpa o incidente e não autoriza atualização da VPS.
