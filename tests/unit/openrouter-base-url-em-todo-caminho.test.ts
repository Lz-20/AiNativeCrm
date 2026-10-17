/**
 * `OPENROUTER_BASE_URL` vale em TODO caminho que fala com a OpenRouter — não só
 * no `resolveLanguageModel` (que `gateway-destino-por-caminho.test.ts` já cobre).
 *
 * O agente publicado (botão "Sugerir resposta", no app) e o turno do worker
 * montavam o cliente com o endereço fixo `openrouter.ai`. Quem apontava a
 * variável para um gateway compatível via os pontos do painel funcionarem e o
 * agente morrer com `401 Missing Authentication header`: a chave do gateway ia
 * para a OpenRouter.
 *
 * Técnica: `globalThis.fetch` interceptado, SDK real no caminho, nenhuma
 * chamada de rede sai. A asserção é o host de destino.
 */
import type { LanguageModel } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invokePiProvider } from "@/tests/agent-runtime/fixtures/pi-http";

const envMock: Record<string, string> = {};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));

const PROXY = "https://meu-proxy.example.com/v1";

let fetchOriginal: typeof globalThis.fetch;
let destinos: string[];

async function destinoDe(model: LanguageModel) {
  const { generateText } = await import("ai");
  try {
    await generateText({ model, prompt: "oi" });
  } catch {
    // O stub não imita o formato do provedor; o host já foi capturado.
  }
  return destinos;
}

async function destinoDePi(model: { provider: string; model: string; apiKey: string }) {
  await invokePiProvider(model);
  return destinos;
}

// A primeira importação do compositor de execução transforma um grafo grande
// (medido: 34s numa máquina com load 63). Paga-se aqui, com prazo próprio, para
// o primeiro caso não estourar os 15s do teste; o `resetModules` de cada caso
// reavalia os módulos, mas a transformação fica em cache.
beforeEach(() => {
  destinos = [];
  fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    destinos.push(new URL(url).host);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("OPENROUTER_BASE_URL em todo caminho", () => {
  it("agente publicado (app) vai ao gateway da variável", async () => {
    vi.stubEnv("OPENROUTER_BASE_URL", PROXY);
    vi.resetModules();
    expect(await destinoDePi({ provider: "openrouter", apiKey: "sk-x", model: "qwen3.8-flash" })).toEqual([
      "meu-proxy.example.com",
    ]);
  });

  it("turno do worker, sem base_url no painel, vai ao gateway da variável", async () => {
    vi.stubEnv("OPENROUTER_BASE_URL", PROXY);
    vi.resetModules();
    const { createDefaultRegistry } = await import("@/lib/agent-engine/edge/llm/providers");
    const model = createDefaultRegistry().openrouter!("sk-x", "qwen3.8-flash");
    expect(await destinoDe(model)).toEqual(["meu-proxy.example.com"]);
  });

  it("sem a variável, continua na OpenRouter", async () => {
    vi.stubEnv("OPENROUTER_BASE_URL", "");
    vi.resetModules();
    expect(await destinoDePi({ provider: "openrouter", apiKey: "sk-x", model: "qwen3.8-flash" })).toEqual([
      "openrouter.ai",
    ]);
  });
});
