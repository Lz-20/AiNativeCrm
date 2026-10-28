---
impacto: nada_mudou
secao: corrigido
titulo: Configuração pública do Supabase protege as chaves de backend
---

O navegador passa a receber a URL e a chave pública do mesmo ambiente de execução, sem misturar valores da imagem com uma configuração incompleta. O servidor e o navegador rejeitam chaves secret e service_role nos campos públicos antes de usá-las, e o instalador identifica a troca entre publishable e secret antes da consulta online. As chaves publishable/secret e anon/service_role continuam aceitas nos seus respectivos campos.
