---
impacto: capacidade_nova
secao: alterado
titulo: O CRM inicia sem integrações opcionais e informa o que falta configurar
---

Login e CRM podem iniciar antes da configuração de WhatsApp e Redis. A saúde
informa dependências ausentes, credenciais recusadas e respostas inválidas, e
o envio sem canal configurado retorna erro em vez de aparentar sucesso. IA e
e-mail continuam disponíveis conforme as credenciais configuradas.

A validação do catálogo de extensões também recusa arquivos vazios, inclusive
com jq 1.6. Instalações já configuradas preservam suas integrações.
