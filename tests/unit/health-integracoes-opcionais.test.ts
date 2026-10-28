import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUPABASE = "https://supabase.example.invalid";
const AMBIENTE = {
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test_fixture",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_readiness_fixture",
  UPSTASH_REDIS_REST_URL: "",
  UPSTASH_REDIS_REST_TOKEN: "",
  WAHA_API_BASE_URL: "",
  WAHA_API_KEY: "",
  INTERNAL_SECRET: "internal-fixture",
  INTERNAL_CRON_SECRET: "",
};

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith(SUPABASE)) return Response.json([]);
      throw new Error("unexpected_network");
    }),
  );
});

afterEach(() => {
  vi.doUnmock("@/lib/env");
  vi.unstubAllGlobals();
});

async function consultar(overrides: Partial<typeof AMBIENTE> = {}) {
  vi.doMock("@/lib/env", () => ({ env: { ...AMBIENTE, ...overrides } }));
  const { GET } = await import("@/app/api/v1/health/route");
  return GET(new NextRequest("https://crm.example.invalid/api/v1/health"));
}

describe("health sem inventar disponibilidade", () => {
  it("sem integrações, mede apenas Supabase e declara as ausências", async () => {
    const response = await consultar();
    const { data } = await response.json();
    expect(response.status).toBe(200);
    expect(data.status).toBe("degraded");
    for (const nome of ["redis", "waha"]) {
      expect(data.checks[nome]).toMatchObject({ status: "degraded", reason: "nao_configurado" });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("Supabase responde %s: recusa de acesso não é saudável", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status }));
    const response = await consultar();
    const { data } = await response.json();
    expect(response.status).toBe(503);
    expect(data.checks.supabase).toMatchObject({ status: "down", reason: "credencial_recusada" });
  });

  it.each([
    ["redis", { UPSTASH_REDIS_REST_URL: "http://redis.example.invalid" }],
    ["redis", { UPSTASH_REDIS_REST_TOKEN: "redis-fixture" }],
    ["waha", { WAHA_API_BASE_URL: "http://messaging.example.invalid" }],
    ["waha", { WAHA_API_KEY: "messaging-fixture" }],
  ])(
    "configuração parcial de %s é declarada inválida sem tentar rede",
    async (servico, partial) => {
      const response = await consultar(partial);
      const { data } = await response.json();
      expect(response.status).toBe(503);
      expect(data.checks[servico]).toMatchObject({
        status: "down",
        reason: "configuracao_invalida",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("integrações configuradas que respondem continuam saudáveis", async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).includes("redis.example.invalid")
        ? Response.json({ result: "PONG" })
        : Response.json([]),
    );
    const response = await consultar({
      UPSTASH_REDIS_REST_URL: "http://redis.example.invalid",
      UPSTASH_REDIS_REST_TOKEN: "redis-fixture",
      WAHA_API_BASE_URL: "http://messaging.example.invalid",
      WAHA_API_KEY: "messaging-fixture",
    });
    const { data } = await response.json();
    expect(response.status).toBe(200);
    expect(data.status).toBe("healthy");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([{ result: "QUEUED" }, { error: "ERR unknown command" }, {}])(
    "HTTP 200 sem PONG não confirma Redis disponível (%j)",
    async (body) => {
      vi.mocked(fetch).mockImplementation(async (input) =>
        String(input).includes("redis.example.invalid") ? Response.json(body) : Response.json([]),
      );
      const response = await consultar({
        UPSTASH_REDIS_REST_URL: "http://redis.example.invalid",
        UPSTASH_REDIS_REST_TOKEN: "redis-fixture",
      });
      const { data } = await response.json();
      expect(response.status).toBe(503);
      expect(data.checks.redis).toMatchObject({ status: "down", reason: "resposta_inesperada" });
    },
  );
});
