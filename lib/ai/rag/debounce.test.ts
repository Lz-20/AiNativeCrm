import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { warn, set, del } = vi.hoisted(() => ({ warn: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn } }));
vi.mock("@upstash/redis", () => ({
  Redis: class {
    set = set;
    del = del;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.doUnmock("@/lib/env");
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("debounce sem prometer coordenação quando Redis falta", () => {
  it("deduplica localmente e avisa o limite entre processos", async () => {
    vi.doMock("@/lib/env", () => ({
      env: {
        UPSTASH_REDIS_REST_URL: "",
        UPSTASH_REDIS_REST_TOKEN: "",
      },
    }));
    const { acquireDebounce, releaseDebounce } = await import("./debounce");
    expect(await acquireDebounce("fixture", 30)).toBe(true);
    expect(await acquireDebounce("fixture", 30)).toBe(false);
    await releaseDebounce("fixture");
    expect(await acquireDebounce("fixture", 30)).toBe(true);
    expect(set).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("por processo"),
      expect.objectContaining({
        reason: "nao_configurado",
        acao: expect.stringContaining("UPSTASH_REDIS_REST_URL"),
      }),
    );
  });

  it("falha aberta registra causa e próximo passo sem ecoar erro do provedor", async () => {
    vi.doMock("@/lib/env", () => ({
      env: {
        UPSTASH_REDIS_REST_URL: "https://redis.example.invalid",
        UPSTASH_REDIS_REST_TOKEN: "fixture-token",
      },
    }));
    set.mockRejectedValue(new Error("ECONNREFUSED fixture-token corpo-do-provedor"));
    const { acquireDebounce } = await import("./debounce");
    expect(await acquireDebounce("fixture", 30)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("SEM debounce"),
      expect.objectContaining({
        reason: "conexao_recusada",
        acao: expect.stringContaining("/api/v1/health"),
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fixture-token");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("corpo-do-provedor");
  });
});
