import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/v1/health — a rota é PÚBLICA e não pode publicar o endereço interno.
 *
 * O campo `target` (protocolo + host + porta) já era escondido de propósito: só
 * sai com `?verbose=1` mais o segredo interno, porque o endereço dos serviços
 * externos de uma instalação é superfície de ataque. O `error`, ao lado dele,
 * saía cru — e carrega o MESMO endereço quando o `.env` está numa das formas
 * erradas mais comuns do self-host.
 *
 * A condição de alcance existe porque, das três variáveis de endereço que a
 * rota consulta, só a do banco é validada como URL no import (`lib/env.ts`);
 * as integrações opcionais conferem a forma antes da operação. Um valor sem
 * esquema, ou com as aspas do `.env` sobrando, passa pelo Zod e explode no
 * `fetch` com o host dentro da mensagem:
 *
 *   "servico-interno.vps-do-cliente.com"
 *     -> "Failed to parse URL from servico-interno.vps-do-cliente.com"
 *
 * ESCOPO, dito em voz alta: isto vigia a SAÍDA da rota, não a validação do env.
 * Um endereço com esquema válido e host inalcançável devolve `"fetch failed"` e
 * guarda o host em `e.cause`, que a rota nunca devolveu — esse caso nunca vazou,
 * e este arquivo não o cobre porque não há o que cobrir.
 *
 * Um cuidado de forma: este arquivo exercita SÓ o caminho da fila, e não o do
 * outro serviço externo, porque nomeá-lo aqui reprovaria `lint:channels`
 * (doutrina restrição-de-canal, invariante 1 — gate obrigatório). A perda é
 * nenhuma: o vazamento é do `error` em `semAlvo()`, que é o mesmo código para os
 * três checks; um caminho basta para prová-lo, e a asserção é sobre o corpo
 * inteiro, não sobre um campo.
 *
 * Achado por contribuidor no PR #465.
 */

/**
 * Sem esquema de propósito: é esta forma que faz o `fetch` do Node embutir o
 * endereço na mensagem, e é a forma que um `.env` mal preenchido produz.
 */
const HOST_VAZADO = "servico-interno.vps-do-cliente.com";
const SEGREDO = "segredo-interno-de-teste-com-tamanho-suficiente";
const TOKEN_PRIVADO = "token-privado-do-provedor-fixture";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://projeto-do-cliente.supabase.co",
    SUPABASE_INTERNAL_URL: "http://supabase-api-gw.private:8000",
    SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
    UPSTASH_REDIS_REST_URL: "servico-interno.vps-do-cliente.com",
    UPSTASH_REDIS_REST_TOKEN: "token-de-teste",
    INTERNAL_CRON_SECRET: "segredo-interno-de-teste-com-tamanho-suficiente",
    INTERNAL_SECRET: "",
  },
}));

function pedido(query = "", headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://crm.exemplo.com.br/api/v1/health${query}`, { headers });
}

describe("GET /api/v1/health — o endereço interno não sai para quem não tem o segredo", () => {
  beforeEach(() => {
    vi.resetModules();
    // Nenhum host real é consultado, nem pelo probe independente de Supabase.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(`ENOTFOUND ${HOST_VAZADO} ${TOKEN_PRIVADO}`)),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("consulta Supabase pelo endereço interno sem publicá-lo na resposta", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const { GET } = await import("./route");
    const body = await (await GET(pedido())).json();
    expect(fetch).toHaveBeenCalledWith(
      "http://supabase-api-gw.private:8000/rest/v1/organizations?select=id&limit=1",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(body.data.checks.supabase.status).toBe("ok");
    expect(JSON.stringify(body)).not.toContain("supabase-api-gw.private");
  });

  it("não publica o host numa resposta anônima, nem pelo error", async () => {
    const { GET } = await import("./route");
    const corpo = JSON.stringify(await (await GET(pedido())).json());

    // A asserção é sobre o CORPO INTEIRO, não sobre um campo: se amanhã alguém
    // acrescentar outro lugar por onde o endereço saia, este caso reprova.
    expect(corpo).not.toContain(HOST_VAZADO);
    expect(corpo).not.toContain("Failed to parse URL");
  });

  it("mantém o diagnóstico útil — o motivo continua saindo", async () => {
    const { GET } = await import("./route");
    const { data } = await (await GET(pedido())).json();

    // Redigir não pode virar apagar: quem monitora de fora precisa seguir
    // distinguindo "não alcancei" de "fui barrado". Sem isto, a redação seria
    // uma regressão de observabilidade disfarçada de conserto.
    expect(data.checks.redis.reason).toBeTruthy();
    expect(data.checks.redis.status).toBe("down");
  });

  it("verbose mantém categorias e variáveis, sem ecoar valores ou erros externos", async () => {
    const { GET } = await import("./route");
    const req = pedido("?verbose=1", { authorization: `Bearer ${SEGREDO}` });
    const body = await (await GET(req)).json();
    const corpo = JSON.stringify(body);
    expect(body.data.checks.redis).toMatchObject({
      status: "down",
      reason: "configuracao_invalida",
      target: "(endereço inválido)",
    });
    expect(body.data.checks.redis.error).toContain("UPSTASH_REDIS_REST_URL");
    expect(body.data.checks.redis.error).toContain("UPSTASH_REDIS_REST_TOKEN");
    expect(body.data.checks.supabase).toMatchObject({
      error: "request_failed",
      reason: "endereco_nao_resolve",
    });
    expect(corpo).not.toContain(HOST_VAZADO);
    expect(corpo).not.toContain(TOKEN_PRIVADO);
    expect(corpo).not.toContain("ENOTFOUND");
  });
});
