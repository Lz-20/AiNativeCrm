import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OPCIONAIS = [
  "WAHA_API_BASE_URL",
  "WAHA_API_KEY",
  "WAHA_WEBHOOK_BASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "AI_GATEWAY_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "SMTP_HOST",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
] as const;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PHASE", "");
  for (const [nome, valor] of Object.entries({
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test_fixture",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test_fixture",
    SUPABASE_DB_URL: "postgresql://fixture:fixture@database.example.invalid/fixture",
    INTERNAL_SECRET: "internal-test-fixture",
    CPF_ENCRYPTION_KEY: "cpf-test-fixture",
    WAHA_BYO_ENCRYPTION_KEY: "byo-test-fixture",
    AI_CRED_AES_KEY: "encryption-test-fixture",
  }))
    vi.stubEnv(nome, valor);
  for (const nome of OPCIONAIS) vi.stubEnv(nome, undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected_network")));
});

afterEach(() => {
  vi.doUnmock("@/lib/instalacao/config");
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Web em produção antes de configurar integrações", () => {
  it.each([undefined, ""])(
    "carrega o ambiente com integrações %s, sem fabricar configuração",
    async (valor) => {
      for (const nome of OPCIONAIS) vi.stubEnv(nome, valor);
      const { env } = await import("@/lib/env");
      for (const nome of OPCIONAIS) expect(env[nome], nome).toBe("");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("mantém o bloqueio por falhas de login sem Redis, sem rede", async () => {
    const { contaBloqueadaPorFalhas, registrarFalhaDeLogin } =
      await import("@/lib/auth/rate-limit");
    const limites = { ip: 60, id: 5, windowSec: 300 };
    for (let i = 0; i < 5; i++) {
      expect(await contaBloqueadaPorFalhas("teste@example.invalid", limites)).toBe(false);
      await registrarFalhaDeLogin("teste@example.invalid", limites);
    }
    expect(await contaBloqueadaPorFalhas("teste@example.invalid", limites)).toBe(true);
    expect(await contaBloqueadaPorFalhas("outra@example.invalid", limites)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("carrega IA e e-mail sem credenciais e informa a operação indisponível", async () => {
    // A configuração persistida também está vazia; nenhuma leitura real do banco.
    vi.doMock("@/lib/instalacao/config", () => ({
      valorDaInstalacao: vi.fn().mockResolvedValue({ valor: null }),
    }));
    const ia = await import("@/lib/ai/gateway");
    const email = await import("@/lib/email/resend");
    expect(ia.isAiGatewayConfigured()).toBe(false);
    expect(ia.resolveLanguageModel("openai/gpt-fixture")).toBeNull();
    expect(await email.isEmailConfigured()).toBe(false);
    expect(
      await email.sendEmail({
        to: "destino@example.invalid",
        subject: "fixture",
        html: "<p>fixture</p>",
      }),
    ).toEqual({ ok: false, error: "not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "INTERNAL_SECRET"])(
    "a ausência de %s continua impedindo configuração insegura",
    async (nome) => {
      vi.stubEnv(nome, "");
      await expect(import("@/lib/env")).rejects.toThrow("Variáveis de ambiente inválidas");
    },
  );

  it.each([
    "sb_secret_privileged_fixture",
    `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.fixture`,
  ])("recusa credencial privilegiada no campo público sem imprimir seu valor", async (chave) => {
    // Isola a recusa da chave: nenhuma outra variável pode provocar este erro.
    for (const nome of [
      "WAHA_API_BASE_URL",
      "WAHA_API_KEY",
      "WAHA_WEBHOOK_BASE_URL",
      "UPSTASH_REDIS_REST_URL",
      "UPSTASH_REDIS_REST_TOKEN",
    ]) {
      vi.stubEnv(nome, "configured-fixture");
    }
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", chave);
    await expect(import("@/lib/env")).rejects.toThrow("Variáveis de ambiente inválidas");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(chave);
  });
});
