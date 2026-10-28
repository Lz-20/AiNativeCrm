import { test, expect } from "@playwright/test";

test.describe("error pages", () => {
  // Anonymous /404 and /500 use the installation default; /503 uses that
  // default without a database lookup. r4 defaults to Simplified Chinese.
  // /403 intentionally uses the visitor's language (pt-BR in this suite).
  test("/404 renders the installation default and working navigation links", async ({ page }) => {
    const res = await page.goto("/404");
    // Next renders the not-found.tsx component; status may be 404 or 200 depending on routing.
    expect([200, 404]).toContain(res?.status() ?? 0);
    await expect(page.getByRole("heading", { name: "404 — 页面未找到", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "返回", exact: true })).toHaveAttribute("href", "/");
    await expect(page.getByRole("link", { name: "返回会话收件箱", exact: true })).toHaveAttribute("href", "/app/inbox");
  });

  test("/403 renders sem permissão", async ({ page }) => {
    await page.goto("/403");
    await expect(page.getByText(/sem permissão/i)).toBeVisible();
  });

  test("/500 renders the installation default and a return link", async ({ page }) => {
    await page.goto("/500");
    await expect(page.getByRole("heading", { name: "500 — 内部错误", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "返回", exact: true })).toHaveAttribute("href", "/");
  });

  test("/503 renders the installation default and a return link", async ({ page }) => {
    await page.goto("/503");
    await expect(page.getByRole("heading", { name: "503 — 维护中", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "返回", exact: true })).toHaveAttribute("href", "/");
  });
});

/**
 * Os documentos legais moram aqui, e não numa spec nova, por dois motivos: esta
 * já navega deslogada (que é a condição sob teste) e já está declarada no
 * workflow — spec nova sem entrada em `.github/workflows/e2e.yml` reprova
 * `tests/unit/e2e-cobertura-completa.test.ts` no check obrigatório.
 *
 * O que se prova: o checkbox de aceite da PRIMEIRA tela do produto linka estes
 * dois endereços, e eles respondiam 404. Um aceite obrigatório apontando para o
 * vazio é o pior defeito de confiança que uma instalação nova pode ter.
 */
test.describe("documentos legais", () => {
  test("/legal/terms abre SEM sessão — é o que o aceite do onboarding linka", async ({ page }) => {
    const res = await page.goto("/legal/terms");
    expect(res?.status()).toBe(200);
    // E não é o login disfarçado: o proxy manda anônimo para /login?next=...
    expect(new URL(page.url()).pathname).toBe("/legal/terms");
    await expect(page.getByRole("heading", { name: /termos de uso/i })).toBeVisible();
  });

  test("/legal/privacy abre SEM sessão e nomeia o responsável", async ({ page }) => {
    const res = await page.goto("/legal/privacy");
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe("/legal/privacy");
    await expect(page.getByRole("heading", { name: /política de privacidade/i })).toBeVisible();
    // Sem sessão não dá para saber a razão social, mas o documento não pode
    // fingir que quem responde pelos dados é o projeto de software.
    await expect(page.getByText(/operador desta instalação/i).first()).toBeVisible();
  });

  test("o vizinho de /legal continua fechado — a liberação é dos dois, não do prefixo", async ({
    page,
  }) => {
    await page.goto("/legal/qualquer-outra");
    await expect(page).toHaveURL(/\/login/);
  });
});
