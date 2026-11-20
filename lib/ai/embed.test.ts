/**
 * O que este teste protege, em duas frentes.
 *
 * **1. Sem gateway, o embedding não pode passar pelo gateway.**
 * O arquivo prometia esse caminho no cabeçalho desde que nasceu ("otherwise uses
 * the OpenAI provider directly") e não o tinha: passava a string
 * `openai/text-embedding-3-small` direto para `embed()`, e no AI SDK um id com
 * barra é resolvido pelo **gateway da Vercel mesmo sem chave** — entrando no
 * plano anônimo. O teto desse plano devolve `GatewayRateLimitError`, o `catch`
 * do `searchKnowledge` engole, e a busca na base volta vazia sem gravar nada.
 *
 * A asserção é sobre o TIPO do que chega em `embed({model})`: string significa
 * "deixa o gateway resolver"; objeto significa "provider explícito". É a única
 * diferença observável sem rede.
 *
 * **2. A chave vem da ORGANIZAÇÃO (0181).** Até aqui `embedText` lia só o
 * `process.env`, e o efeito era o pior possível para quem instala: cadastrar a
 * chave da OpenAI pela tela NÃO habilitava a base de conhecimento, enquanto duas
 * telas do produto prometiam que sim. Os casos abaixo cobrem os dois desfechos —
 * a chave da organização é usada, e a ausência dela vira erro TIPADO em vez de
 * uma falha genérica que a tela não sabe traduzir.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as EmbeddingKeyModule from "@/lib/ai/embeddings/chave";

const embedSpy = vi.fn();
vi.mock("ai", () => ({
  embed: (args: unknown) => embedSpy(args),
}));

let chaveMock: () => unknown;
vi.mock("@/lib/ai/embeddings/chave", async () => {
  const real =
    await vi.importActual<typeof EmbeddingKeyModule>("@/lib/ai/embeddings/chave");
  return {
    ...real,
    // Mockado porque a resposta REAL depende de banco e de `.env.local`, e este
    // arquivo mede qual OBJETO DE MODELO chega em `embed()`. Sem isto ele só
    // passaria em máquina com credencial — refém de algo que não usa.
    resolverChaveDeEmbedding: async () => chaveMock(),
  };
});

import { embedText as guardedEmbed, SemChaveDeEmbeddingError, type EmbedOptions } from "@/lib/ai/embed";
vi.mock("@/lib/ai/embeddings/operation-store",()=>({
  executeAuthorizedEmbedding:(_p:unknown,_i:unknown,_a:unknown,send:()=>Promise<unknown>)=>send(),
}));
// Supply a synthetic admission ONLY in this SDK wire-contract unit. The real
// ledger has separate PostgreSQL HTTP-receiver tests, including legacy denial.
const embedText=(text:string,opts:EmbedOptions)=>guardedEmbed(text,{...opts,access:{organizationId:opts.organizationId,kind:'query',sourceIds:['synthetic-source']}});
import { embeddingProfile } from "./embeddings/profile";

beforeEach(() => {
  embedSpy.mockReset();
  embedSpy.mockResolvedValue({
    // 1536 dimensões: `embedText` assere a dimensão a cada chamada, porque
    // divergir de modelo quebra o recall em SILÊNCIO.
    embedding: Array.from({ length: 1536 }, (_, i) => i / 1536),
    usage: { tokens: 7 },
  });
  chaveMock = () => ({
    apiKey: "sk-da-organizacao",
    baseUrl: null,
    viaGateway: false,
    origem: "credencial_da_organizacao",
    rotulo: "Chave principal",
    avisos: [],
  });
});

describe("embedText", () => {
  it("never uses a legacy key to bypass an absent operation authorization",async()=> {
    await expect(guardedEmbed('SVC-101',{organizationId:'org-1'})).rejects.toThrow('embedding_authorization_required');
    expect(embedSpy).not.toHaveBeenCalled();
  });
  it("cannot reuse a cached custom embedding credential in a different tenant", async () => {
    const profile = embeddingProfile({ provider: "siliconflow", base_url: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", dimensions: 1024, model_revision: "1", enabled: true });
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live_provider_forbidden"));
    try {
      await expect(embedText("SVC-101", { organizationId: "org-b", chave: {
        organizationId: "org-a", profile, apiKey: "synthetic-credential", baseUrl: profile.baseUrl,
        viaGateway: false, origem: "configuracao_embedding", rotulo: null, avisos: [],
      } })).rejects.toThrow("embedding_tenant_mismatch");
      expect(fetcher).not.toHaveBeenCalled(); expect(embedSpy).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });
  it("SEM gateway, usa o provider OpenAI explícito — nunca a string com barra", async () => {
    await embedText("oi", { organizationId: "org-1" });

    const arg = embedSpy.mock.calls[0]?.[0] as { model: unknown; headers?: unknown };
    // String aqui = o gateway resolve = plano anônimo = teto. É o defeito.
    expect(
      typeof arg.model,
      "modelo chegou como string: o gateway vai resolver e cair no plano anônimo",
    ).not.toBe("string");
    expect(arg.model).toBeTypeOf("object");
    // Sem gateway não há tenant para observar: headers não fazem sentido.
    expect(arg.headers).toBeUndefined();
  });

  it("COM gateway, mantém a string (é ele quem roteia) e anexa os headers do tenant", async () => {
    chaveMock = () => ({
      apiKey: null,
      baseUrl: null,
      viaGateway: true,
      origem: "gateway_da_instalacao",
      rotulo: null,
      avisos: [],
    });

    await embedText("oi", { organizationId: "org-1" });

    const arg = embedSpy.mock.calls[0]?.[0] as { model: unknown; headers?: Record<string, string> };
    expect(arg.model).toBe("openai/text-embedding-3-small");
    expect(arg.headers?.["X-AI-Gateway-Tenant-Id"]).toBe("org-1");
  });

  it("devolve a contagem de tokens que o SDK reporta", async () => {
    const r = await embedText("oi", { organizationId: "org-1" });
    expect(r.embedding).toHaveLength(1536);
    expect(r.promptTokens).toBe(7);
  });

  it("organização SEM chave nenhuma vira erro tipado, não uma falha genérica", async () => {
    chaveMock = () => null;

    await expect(embedText("oi", { organizationId: "org-1" })).rejects.toBeInstanceOf(
      SemChaveDeEmbeddingError,
    );
    // E não chega a chamar o SDK: falhar depois de gastar a chamada seria pior.
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("chave já resolvida NÃO é re-resolvida — indexar 200 trechos decifra a credencial uma vez", async () => {
    let resolucoes = 0;
    chaveMock = () => {
      resolucoes++;
      return {
        apiKey: "sk-x",
        baseUrl: null,
        viaGateway: false,
        origem: "credencial_da_organizacao",
        rotulo: "x",
        avisos: [],
      };
    };

    const chave = {
      apiKey: "sk-x",
      baseUrl: null,
      viaGateway: false,
      origem: "credencial_da_organizacao" as const,
      rotulo: "x",
      avisos: [],
    };
    await embedText("a", { organizationId: "org-1", chave });
    await embedText("b", { organizationId: "org-1", chave });

    expect(resolucoes, "a chave passada por parâmetro foi ignorada e re-resolvida").toBe(0);
    expect(embedSpy).toHaveBeenCalledTimes(2);
  });

  it("dimensão diferente do contrato é ERRO — recall quebrado em silêncio é pior", async () => {
    embedSpy.mockResolvedValue({ embedding: [0.1, 0.2], usage: { tokens: 1 } });

    await expect(embedText("oi", { organizationId: "org-1" })).rejects.toThrow(/1536/);
  });
});
