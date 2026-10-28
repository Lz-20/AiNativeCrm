// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INTERNAL_URL = "http://supabase-api-gw.fixture:8000";
const PUBLIC_KEY = "sb_publishable_readiness_fixture";
const SECRET_KEY = "sb_secret_readiness_private_fixture";
const JWT_KEY = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(
  '{"role":"service_role"}',
).toString("base64url")}.synthetic-signature`;
const USER_TOKEN = "synthetic-user-session";
const INTERNAL_SECRET = "synthetic-internal-secret";

function mockEnv(key = SECRET_KEY) {
  vi.doUnmock("@/lib/env");
  vi.doMock("@/lib/env", () => ({
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:8000",
      SUPABASE_INTERNAL_URL: INTERNAL_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: PUBLIC_KEY,
      SUPABASE_SERVICE_ROLE_KEY: key,
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      INTERNAL_SECRET,
      INTERNAL_CRON_SECRET: "",
    },
  }));
}

async function request(verbose = false) {
  const { GET } = await import("./route");
  return GET(
    new NextRequest(
      `http://localhost:3100/api/v1/health?table=auth.users&select=*&verbose=${verbose ? 1 : 0}`,
      { headers: { Authorization: `Bearer ${verbose ? INTERNAL_SECRET : USER_TOKEN}` } },
    ),
  );
}

beforeEach(() => {
  vi.resetModules();
  mockEnv();
});

afterEach(() => {
  vi.doUnmock("@/lib/env");
  vi.unstubAllGlobals();
});

describe("readiness lê o schema pelo backend sem prometer autorização de usuário", () => {
  it("anon negado pelos helpers de RLS não substitui o probe backend permitido", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const backend = headers.get("apikey") === SECRET_KEY && !headers.has("authorization");
        return backend
          ? new Response(null, { status: 200 })
          : Response.json(
              { code: "42501", message: "permission denied for function fn_user_org_ids" },
              { status: 403 },
            );
      }),
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).data.checks.supabase.status).toBe("ok");
  });

  it.each([
    ["secret", SECRET_KEY, null],
    ["service_role JWT", JWT_KEY, `Bearer ${JWT_KEY}`],
  ])(
    "%s: HEAD fixo, limitado, sem corpo ou credencial do visitante",
    async (_name, key, bearer) => {
      mockEnv(key as string);
      const backendResponse = new Response(null, { status: 200 });
      const json = vi.spyOn(backendResponse, "json");
      const text = vi.spyOn(backendResponse, "text");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(backendResponse));

      const response = await request();
      const body = await response.json();
      expect(body.data.checks.supabase.status).toBe("ok");
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toBe(`${INTERNAL_URL}/rest/v1/organizations?select=id&limit=1`);
      expect(init).toMatchObject({ method: "HEAD", cache: "no-store", redirect: "error" });
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey")).toBe(key);
      expect(headers.get("authorization")).toBe(bearer);
      expect(headers.get("Accept-Profile")).toBe("public");
      expect([...headers.values()].join(" ")).not.toContain(USER_TOKEN);
      expect([...headers.values()].join(" ")).not.toContain(PUBLIC_KEY);
      expect(json).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain(key);
      expect(JSON.stringify(body)).not.toContain(INTERNAL_URL);
    },
  );

  it.each([401, 403, 404, 500, 307])(
    "HTTP %i continua down/503 sem expor corpo ou key",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(`upstream-private-body ${SECRET_KEY}`, { status })),
      );
      const response = await request(true);
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(body.data.checks.supabase).toMatchObject({
        status: "down",
        reason: status === 401 || status === 403 ? "credencial_recusada" : "resposta_inesperada",
        error: `http_${status}`,
      });
      expect(JSON.stringify(body)).not.toContain(SECRET_KEY);
      expect(JSON.stringify(body)).not.toContain("upstream-private-body");
    },
  );

  it("erro do transporte permanece down e não retorna a credencial", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError(`ECONNREFUSED ${SECRET_KEY}`)));
    const response = await request(true);
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.data.checks.supabase).toMatchObject({ status: "down", reason: "conexao_recusada" });
    expect(JSON.stringify(body)).not.toContain(SECRET_KEY);
  });
});
