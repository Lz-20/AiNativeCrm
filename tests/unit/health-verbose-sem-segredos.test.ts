import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SEGREDO_INTERNO = "fixture-internal-secret";
const USUARIO = "fixture-private-user";
const SENHA = "fixture-private-password";
const TOKEN = "fixture-private-token";
const CAMINHO = "fixture-private-path";
const FRAGMENTO = "fixture-private-fragment";
const SEGREDOS = [USUARIO, SENHA, TOKEN, CAMINHO, FRAGMENTO, SEGREDO_INTERNO];

function urlComCredenciais(host: string) {
  return `https://${USUARIO}:${SENHA}@${host}:8443/${CAMINHO}?token=${TOKEN}#${FRAGMENTO}`;
}

const AMBIENTE = {
  NEXT_PUBLIC_SUPABASE_URL: urlComCredenciais("supabase.example.invalid"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: TOKEN,
  SUPABASE_SERVICE_ROLE_KEY: TOKEN,
  UPSTASH_REDIS_REST_URL: urlComCredenciais("redis.example.invalid"),
  UPSTASH_REDIS_REST_TOKEN: TOKEN,
  WAHA_API_BASE_URL: urlComCredenciais("messaging.example.invalid"),
  WAHA_API_KEY: TOKEN,
  INTERNAL_SECRET: SEGREDO_INTERNO,
  INTERNAL_CRON_SECRET: "",
};

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.doUnmock("@/lib/env");
  vi.unstubAllGlobals();
});

async function consultar(autenticado = true, overrides: Partial<typeof AMBIENTE> = {}) {
  vi.doMock("@/lib/env", () => ({ env: { ...AMBIENTE, ...overrides } }));
  const { GET } = await import("@/app/api/v1/health/route");
  return GET(
    new NextRequest("https://crm.example.invalid/api/v1/health?verbose=1", {
      headers: autenticado ? { Authorization: `Bearer ${SEGREDO_INTERNO}` } : {},
    }),
  );
}

function semSegredos(body: unknown) {
  const texto = JSON.stringify(body);
  for (const segredo of SEGREDOS) expect(texto).not.toContain(segredo);
}

describe("health verbose preserva diagnóstico sem expor credenciais", () => {
  it("URL Redis malformada identifica variáveis, nunca o valor copiado", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json([]));
    const response = await consultar(true, {
      UPSTASH_REDIS_REST_URL: `"${AMBIENTE.UPSTASH_REDIS_REST_URL}"`,
    });
    const { data } = await response.json();
    expect(response.status).toBe(503);
    expect(data.checks.redis.reason).toBe("configuracao_invalida");
    expect(data.checks.redis.error).toContain("UPSTASH_REDIS_REST_URL");
    expect(data.checks.redis.error).toContain("UPSTASH_REDIS_REST_TOKEN");
    semSegredos(data);
  });

  it.each([
    [
      new TypeError(`ENOTFOUND ${TOKEN} ${AMBIENTE.UPSTASH_REDIS_REST_URL}`),
      "endereco_nao_resolve",
    ],
    [`ECONNREFUSED ${TOKEN}`, "conexao_recusada"],
    [{ token: TOKEN, message: `unknown-provider-body-${SENHA}` }, "indeterminada"],
  ])("erro externo mantém só a classificação (%s)", async (falha, reason) => {
    vi.mocked(fetch).mockRejectedValue(falha);
    const response = await consultar();
    const { data } = await response.json();
    expect(response.status).toBe(503);
    for (const [servico, host] of Object.entries({
      supabase: "supabase.example.invalid",
      redis: "redis.example.invalid",
      waha: "messaging.example.invalid",
    })) {
      expect(data.checks[servico]).toMatchObject({
        status: "down",
        reason,
        target: `https://${host}:8443`,
      });
    }
    semSegredos(data);
  });

  it("HTTP recusa mantém o status numérico, sem carregar o corpo do provedor", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(TOKEN, { status: 403 }));
    const { data } = await (await consultar()).json();
    for (const check of Object.values(data.checks)) {
      expect(check).toMatchObject({
        status: "down",
        error: "http_403",
        reason: "credencial_recusada",
      });
    }
    semSegredos(data);
  });

  it("verbose sem secret continua escondendo todos os alvos", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(`ECONNREFUSED ${TOKEN}`));
    const { data } = await (await consultar(false)).json();
    for (const check of Object.values(data.checks)) expect(check).not.toHaveProperty("target");
    expect(JSON.stringify(data)).not.toContain("example.invalid");
    semSegredos(data);
  });
});
