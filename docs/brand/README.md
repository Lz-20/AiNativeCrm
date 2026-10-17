# Pi Native CRM — marca

## Símbolo e logotipo

| Arquivo | O que é |
|---|---|
| `pi-native-crm-icon.svg` | Símbolo geométrico aberto com um módulo quadrado destacado. |
| `pi-native-crm-logo.svg` | Logotipo para fundo claro — Pi Native CRM em terracota e pedra quente. |
| `pi-native-crm-logo-dark.svg` | Logotipo para fundo escuro — Pi Native CRM em terracota clara e creme. |

O wordmark dos SVGs usa texto simples para facilitar a atualização da identidade.

**Estes SVGs são a fonte; o app NÃO os lê.** A geometria está copiada em
`lib/branding/desenho.ts` e é desenhada inline por `components/branding/MarcaDoProduto.tsx`
(barra lateral, fachada de entrada) e por `app/icon.tsx` (ícone da aba) — e só aparece
quando ninguém configurou marca própria (`marcaEhADoProduto`, em `lib/branding.ts`).
Um `.svg` em `public/` seria servido na instalação de todo revendedor, que é o vazamento
que `tests/unit/branding.test.ts` existe para impedir. Ao revisar a arte, atualize os
três arquivos aqui **e** o `desenho.ts`; `tests/unit/marca-do-produto.test.tsx` cobra
que as cores dos dois lados coincidam.

Os materiais de distribuição podem usar os arquivos diretamente, num `<picture>` que troca para a
versão escura conforme o tema do GitHub. A LP tem a própria cópia em
`components/Marca.tsx` e `app/icon.svg`.

Prova pela tela (2026-09-08, Supabase local fresco do `baseline.sql`, marca sem configurar):

| Imagem | O que mostra |
|---|---|
| `evidence/marca/crm-login-claro.png` | Fachada de entrada com o logotipo, tema claro |
| `evidence/marca/crm-login-escuro.png` | A mesma fachada no escuro: terracota clara e nome em creme |
| `evidence/marca/crm-sidebar-aberta.png` | Barra lateral aberta com o logotipo |
| `evidence/marca/crm-sidebar-aberta-escura.png` | Barra aberta no escuro |
| `evidence/marca/crm-sidebar-recolhida.png` | Barra recolhida (64px) só com o símbolo |
| `evidence/marca/crm-sidebar-recolhida-escura.png` | Barra recolhida no escuro |
| `evidence/marca/favicon-produto.png` | `/icon` gerado em runtime com o símbolo |
| `evidence/marca/crm-login-revendedor.png` | Controle negativo: com `platform_branding.app_name` gravado, a fachada fica sem o desenho |
| `evidence/marca/favicon-revendedor.png` | Controle negativo: o favicon volta à inicial sobre a cor de destaque |
| `evidence/marca/lp-cabecalho.png` | Cabeçalho da página pública com o logotipo |
| `evidence/marca/lp-rodape.png` | Rodapé da LP com o símbolo |

## Social preview (Open Graph)

`og-social-preview.png` — 1280×640, é a imagem que aparece quando um link do
repositório é compartilhado no X, LinkedIn, WhatsApp, Slack ou Discord.

**Como aplicar:** GitHub → Settings → General → *Social preview* → Upload.
Não existe endpoint público na API para isso; é upload pela interface.

**Como regerar** (depois de mudar posicionamento, chips ou paleta):

```bash
# edite docs/brand/og-card.html, depois:
node -e '
import("@playwright/test").then(async ({ chromium }) => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
  await p.goto("file://" + process.cwd() + "/docs/brand/og-card.html", { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: "docs/brand/og-social-preview.png" });
  await b.close();
});'
```

A fonte fica versionada de propósito: card cuja origem se perde vira arte que
ninguém consegue atualizar quando o posicionamento muda — e aí ou envelhece
mentindo, ou é refeito do zero com outra identidade.

## Regras da arte

- Paleta lida de `app/globals.css` (marfim `#fbf8f4`, terracota `#934531`, texto
  `#1c1814`). O card usa a identidade real do produto, não uma criada para ele.
- Tipografia: Atkinson Hyperlegible (títulos) + IBM Plex Mono (rótulos), as
  mesmas da aplicação.
- O painel direito é a doutrina do sistema vivo virando imagem: o rastro que uma
  demanda deixa ao atravessar o sistema, terminando no follow-up — o mecanismo
  anti-morte. É o argumento do produto mostrado, não adjetivado.
- Card de compartilhamento **sempre** carrega o logotipo Pi Native CRM inline no HTML. Sem ele,
  quem vê a imagem não sabe de quem ela é.
