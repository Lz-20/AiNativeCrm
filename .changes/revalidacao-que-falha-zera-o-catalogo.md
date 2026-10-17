---
impacto: nada_mudou
secao: corrigido
titulo: Credencial de IA que falha na revalidação deixa de exibir a lista de modelos antiga
---

Ao testar de novo uma credencial de IA, se o provedor recusasse a chave o sistema registrava o erro mas mantinha a lista de modelos da validação anterior. Na tela, a credencial aparecia com a mensagem de falha e, logo abaixo, a contagem de modelos de antes — parecendo pronta para uso quando já não era.

Agora a lista é zerada junto com o resultado da validação: quem olha vê o erro e nenhum modelo disponível, que é o estado real. Uma revalidação bem-sucedida continua gravando os modelos que o provedor devolveu.

Contribuição de contribuidor (#714).
