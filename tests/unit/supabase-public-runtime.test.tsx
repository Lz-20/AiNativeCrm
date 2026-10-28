import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeUrl = "https://runtime-project.invalid";
const publicKey = "sb_publishable_fixture_runtime_public_only";
const secretKey = "sb_secret_fixture_never_public";
const legacyKey = (role: string) =>
  `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role }))}.fixture-signature`;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://build-project.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "build-only-anon-fixture");
  vi.doMock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
  vi.doMock("@supabase/ssr", () => ({ createBrowserClient: vi.fn(() => ({})) }));
});

afterEach(() => {
  delete window.__PUBLIC_ENV__;
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/env");
  vi.doUnmock("next/headers");
  vi.doUnmock("@supabase/ssr");
});

async function publicScript(key = publicKey) {
  vi.doMock("@/lib/env", () => ({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: runtimeUrl,
      SUPABASE_INTERNAL_URL: "http://supabase-api-gw.private:8000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: key,
      SUPABASE_SERVICE_ROLE_KEY: secretKey,
      SUPABASE_DB_URL: "postgresql://fixture:private@db.invalid/database",
      INTERNAL_SECRET: "fixture-internal-secret",
      SENTRY_DSN: "off",
    },
  }));
  const { PublicEnvScript } = await import("@/app/public-env-script");
  return PublicEnvScript({
    marca: { name: "Marca </script><script>fixture</script>", logoUrl: null },
  });
}

describe("configuração pública da imagem genérica", () => {
  it("injeta valores de runtime, escapa HTML e entrega apenas a lista pública", async () => {
    const element = await publicScript();
    const script = element.props.dangerouslySetInnerHTML.__html as string;
    const payload = JSON.parse(script.slice("window.__PUBLIC_ENV__=".length, -1));
    expect(payload).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: runtimeUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey,
      SENTRY_DSN: "off",
      APP_NAME: "Marca </script><script>fixture</script>",
      APP_LOGO_URL: "",
    });
    expect(script).not.toContain("</script>");
    expect(script).not.toContain(secretKey);
    expect(script).not.toContain("postgresql:");
    expect(script).not.toContain("fixture-internal-secret");
    expect(script).not.toContain("supabase-api-gw.private");
    expect(script).not.toContain("SUPABASE_INTERNAL_URL");
    const { headers } = await import("next/headers");
    expect(headers).toHaveBeenCalledOnce();
  });

  it.each([secretKey, legacyKey("service_role")])(
    "recusa chave privilegiada antes de gerar HTML (%#)",
    async (key) => {
      await expect(publicScript(key)).rejects.toThrow(/chave pública/i);
    },
  );

  it.each([publicKey, legacyKey("anon")])(
    "o browser prefere o par completo de runtime (%#)",
    async (key) => {
      window.__PUBLIC_ENV__ = {
        NEXT_PUBLIC_SUPABASE_URL: runtimeUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: key,
      };
      const { createClient } = await import("@/lib/supabase/browser");
      createClient();
      const { createBrowserClient } = await import("@supabase/ssr");
      expect(createBrowserClient).toHaveBeenCalledWith(runtimeUrl, key, expect.any(Object));
    },
  );

  it("mantém o fallback de build quando não há injeção", async () => {
    const { createClient } = await import("@/lib/supabase/browser");
    createClient();
    const { createBrowserClient } = await import("@supabase/ssr");
    expect(createBrowserClient).toHaveBeenCalledWith(
      "https://build-project.invalid",
      "build-only-anon-fixture",
      expect.any(Object),
    );
  });

  it.each([{ NEXT_PUBLIC_SUPABASE_URL: runtimeUrl }, { NEXT_PUBLIC_SUPABASE_ANON_KEY: publicKey }])(
    "recusa injeção incompleta em vez de misturar dois projetos (%#)",
    async (runtime) => {
      window.__PUBLIC_ENV__ = runtime;
      const { createClient } = await import("@/lib/supabase/browser");
      expect(() => createClient()).toThrow(/ausentes|incompleta/i);
    },
  );

  it.each([secretKey, legacyKey("service_role")])(
    "o browser também recusa chave privilegiada (%#)",
    async (key) => {
      window.__PUBLIC_ENV__ = {
        NEXT_PUBLIC_SUPABASE_URL: runtimeUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: key,
      };
      const { createClient } = await import("@/lib/supabase/browser");
      expect(() => createClient()).toThrow(/chave pública/i);
      const { createBrowserClient } = await import("@supabase/ssr");
      expect(createBrowserClient).not.toHaveBeenCalled();
    },
  );
});
