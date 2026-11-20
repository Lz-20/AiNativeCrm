---
impacto: exige_acao
secao: corrigido
titulo: Autorize o preparo e as consultas de conhecimento com limites de gasto
---
Embeddings exigem agora uma autorização explícita por organização, fonte, conteúdo,
modelo e versão da configuração. O administrador revisa a prova de preço e do teto
de tokens na própria área de conhecimento; sem prova válida, nenhuma chamada sai.
Eventos em espera não gastam tentativas. Trabalho duplicado reutiliza os trechos
confirmados e resultados incertos ficam bloqueados para revisão, sem nova cobrança
automática. Antes de atualizar, aprove e aplique separadamente a migration 0413;
não há aprovação, preço ou reprocessamento de eventos históricos instalado de fábrica.

## Requer atenção

Aprove a expansão Schema/Catalog 0413 antes da imagem, mantendo o controlador
root instalado e os hashes históricos. Revise preço, moeda e teto de tokens e
autorize cada fonte/conteúdo na área de conhecimento; chaves antigas sozinhas não
liberam novos gastos. Eventos mortos não são reabertos automaticamente.
