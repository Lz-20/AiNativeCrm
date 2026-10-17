---
impacto: nada_mudou
secao: corrigido
titulo: O WAHA do ambiente de desenvolvimento para de responder 401
---

No `docker-compose.yml` — o do ambiente de desenvolvimento — a chave entregue ao
contêiner do WAHA ia sem o prefixo `sha512:`. O WAHA então comparava o
`X-Api-Key` recebido literalmente: o app manda o texto puro, o compose mandava o
hash, e toda chamada voltava 401 — inclusive a que cria a sessão e devolve o QR
Code para conectar um número.

Agora o compose de desenvolvimento usa a mesma forma do
`docker-compose.prod.yml`, onde o prefixo já estava. Quem já tinha o ambiente de
pé precisa recriar o contêiner do WAHA (`docker compose up -d --force-recreate waha`).
