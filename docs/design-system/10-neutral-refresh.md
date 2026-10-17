# Neutral CRM visual refresh · 2026-10-02

CONFIRMADO no código desta branch: a solicitação de uma interface clara, moderna,
sem serifa e arredondada substitui as escolhas antigas de cor/tipo/raio dos
capítulos 00–03 e 09 para o produto. `app/globals.css` é a fonte dos tokens em
produção. `/design` preserva as comparações históricas e não é a fonte do tema
atual; as famílias nomeadas ali usam apenas fontes instaladas, com fallback local.

## Contrato visual

- Página `#f7f8fa`, cartão `#ffffff`, navegação `#f9fafb`, apoio `#f1f2f4`
- Texto `#1d1d1f`; texto secundário e legendas `#6e6e73`; bordas `#e5e7eb`
- Ações principais em carvão; estado ativo do menu em cinza suave, sem barra
  lateral permanentemente escura
- Raio: 8px para itens menores, 12px para controles, 16px para cartões e 20px
  para o compositor e diálogos
- Pilha sans local: sistema Apple/Segoe UI, Noto Sans SC, PingFang SC e Microsoft
  YaHei. Dados longos continuam monoespaçados; não há download de fonte no build
- Sombras leves; overlays usam o token do tema, sem escurecer 80% da tela
- Cores semânticas de sucesso, erro e atenção mantidas; cor nunca substitui texto

As cores de marca próprias continuam derivadas pelo pipeline de contraste.
`lib/branding/regua-do-produto.ts` é gerado da folha CSS. O anel de foco usa o
papel contrastado do tema, inclusive no escuro. Os testes medem texto pequeno
com piso de 4,5:1 e os pares de ação/foco com os pisos existentes de WCAG.

## Continuidade e limites

Destino: núcleo. A operação comum não depende de extensão. Login, navegação,
inbox, kanban, configurações e o workbench consomem as mesmas primitivas.
Não há nova tela, tabela, API, efeito de negócio ou permissão. O registro e o
caminho de entrada/saída continuam os dos consumidores existentes; por isso não
há novo nó de arquitetura, evento de auditoria ou mecanismo anti-morte.

A escolha salva de tema (`light`, `dark` ou `system`) continua intacta; o sistema
não regrava preferências. O compositor continua ancorado, com rolagem interna;
configurações e detalhes mantêm Radix Sheet, foco, Escape e histórico de navegação.
Os testes existentes de workbench e tema exercitam esses contratos.

A demonstração em `examples/chat-first-demo` serve para inspeção visual com
amostras. Não é prova de login, banco, envio, runtime de agentes ou integração de
produção. A QA autenticada com banco fresco e screenshots do produto continua
necessária antes de tratar a mudança como pronta para produção.

## Verificação desta alteração

- Typecheck completo (`tsc --noEmit -p tsconfig.typecheck.json`, heap de 4 GB): passou
- 15 suítes focadas, 160 testes: passaram. Cobrem tokens, contraste de marca,
  escopos claro/escuro, hidratação e preferência de tema, navegação, fachada,
  workbench chat-first, proposta estruturada e mensagens
- Compilação Tailwind/PostCSS: passou; utilitários de sidebar, overlay, raio,
  fonte e foco presentes no CSS final
- Lint dos arquivos TypeScript alterados: zero erros; permanece o aviso
  preexistente de `setState` no efeito de grupos de `Sidebar.tsx`
- As sete suítes do exemplo portátil passaram; manifesto verificado para 22
  arquivos, inclusive os cenários DOM de 320/390/768/1440px
- A varredura adicional `branding.test.ts` passou 38 casos e apontou dois
  problemas em arquivos não alterados: identificador técnico em
  `lib/ai/internal-collaboration/inbox-crypto.ts` e host `open.feishu.cn` em
  `lib/ai/internal-collaboration/feishu-send.ts`
- O fragmento novo de release passou no parser. A verificação agregada de
  release continua bloqueada por dois fragmentos anteriores sem frontmatter:
  `mission-explicit-offer-review.md` e `mission-signed-channel-evidence-review.md`

Não medido: build completo Next, suíte completa, E2E autenticado com banco fresco,
pixels em browser, teclado real de celular, nem integrações externas. Teste DOM
não comprova layout renderizado. Nenhum runtime de produção foi iniciado por
esta alteração e nenhuma configuração de segurança/rede foi modificada.
