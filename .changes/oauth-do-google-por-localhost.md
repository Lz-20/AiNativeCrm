---
impacto: nada_mudou
secao: corrigido
titulo: Conectar o Google funciona quando você abre a instalação por localhost
---

Quem instala o pi-native-crm no próprio computador e abre o sistema por `http://localhost:3000` não conseguia terminar a conexão com o Google Agenda: o endereço de retorno oferecido era sempre o que ficou gravado na instalação (o IP da máquina na rede, por exemplo), e o Google compara esse endereço letra por letra. A conexão voltava para outro endereço e nunca se completava.

Agora, **quando e só quando** o navegador abre o sistema por `localhost` (ou `127.0.0.1`), o endereço de retorno acompanha — e é o mesmo que a tela mostra para você colar no painel do Google. Qualquer outro endereço continua perdendo para o endereço oficial da instalação, então nada muda para quem roda em servidor com domínio próprio.

Contribuição de contribuidor (#714).
