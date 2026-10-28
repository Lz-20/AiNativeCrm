/**
 * GET /api/v1/health — Supabase, Redis e WAHA respondem?
 *
 * ─── Por que cada check diz a CAUSA, e não só "down" ─────────────────────────
 * A versão anterior devolvia `error: "fetch failed"` — a mensagem que o `fetch`
 * dá para causas opostas. Com ela, produção passou semanas indistinguível entre
 * "o endereço configurado não existe" e "o serviço caiu", e a leitura que
 * prevaleceu foi a segunda: o dono reiniciava, toda vez, um container que nunca
 * havia caído (medido: `restarts=0`). Um diagnóstico que não separa configuração
 * de disponibilidade manda metade das pessoas para o lugar errado — e sempre a
 * mesma metade, porque "o serviço caiu" é a hipótese que não acusa quem
 * configurou.
 *
 * `reason` é a classificação (ver `lib/net/alcance`), e é o que basta para saber
 * ONDE mexer.
 *
 * ─── Por que o ENDEREÇO só sai autenticado ───────────────────────────────────
 * Esta rota é pública — é o que permite um monitor externo bater nela. O endereço
 * do Redis e do WAHA é superfície de ataque: publicá-lo entrega a quem varre a
 * internet o alvo exato de dois serviços que falam com o WhatsApp do cliente.
 * Então `target` só sai com `?verbose=1` mais o mesmo segredo interno dos crons:
 * quem opera o sistema vê para onde ele tentou ir; quem só passa na frente, não.
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";
import { supabaseServerUrl } from "@/lib/supabase/urls";
import { alvoDe, classificarFalhaDeAlcance, type FalhaDeAlcance } from "@/lib/net/alcance";
import { validarConfigRedisRest } from "@/lib/redis-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CheckStatus = "ok" | "degraded" | "down";

/** Por que o check não passou. `credencial_recusada` é o 401/403 — chegamos lá, e fomos barrados. */
type MotivoDeFalha =
  | FalhaDeAlcance
  | "credencial_recusada"
  | "resposta_inesperada"
  | "nao_configurado"
  | "configuracao_invalida";

type Check = {
  status: CheckStatus;
  latency_ms: number;
  /** Diagnóstico estável; nunca valor de configuração, corpo externo ou erro cru. */
  error?: string;
  reason?: MotivoDeFalha;
  /** Protocolo + host + porta que tentamos. Só com `?verbose=1` autenticado. */
  target?: string;
};

const TIMEOUT_MS = 3_000;

async function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

/** Chegamos ao serviço, ele respondeu, e a resposta não serve. */
function motivoDoStatusHttp(status: number): MotivoDeFalha {
  return status === 401 || status === 403 ? "credencial_recusada" : "resposta_inesperada";
}

async function checkSupabase(): Promise<Check> {
  const t0 = Date.now();
  const url = supabaseServerUrl(env);
  try {
    // As policies de organizations chamam helpers sem EXECUTE para anon (0108).
    // Readiness verifica o acesso backend ao schema, não a autorização de tenant.
    // HEAD limitado não traz linhas; a key só sai para o endereço configurado.
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await withTimeout(
      fetch(`${url}/rest/v1/organizations?select=id&limit=1`, {
        method: "HEAD",
        headers: {
          apikey: key,
          // A secret key nova não é JWT. Só o service_role legado usa Bearer.
          ...(key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` }),
          // O SCHEMA VAI EXPLÍCITO, como o resto do app faz.
          //
          // Este `fetch` é cru, então ele cai no schema DEFAULT do PostgREST —
          // o primeiro da lista "Exposed schemas" do projeto. Que esse default
          // seja `public` é costume de projeto novo, não garantia do Supabase:
          // num projeto que já servia outra aplicação (schema próprio primeiro
          // na lista), o ping procurava `<outro>.organizations`, levava
          // `404 PGRST205` e o check declarava o banco `down` — com o CRM
          // atendendo normalmente ao lado.
          //
          // Não é falso alarme de menos importância: `update.sh` termina em
          // `wait_app_healthy`, e sair diferente de zero é o sinal que o
          // `agent.sh` usa para REVERTER a imagem. Uma atualização boa era
          // desfeita por uma configuração de painel que o CRM não controla.
          //
          // Nenhum client do CRM declara `db.schema` (`lib/supabase/*.ts`), e o
          // default do supabase-js é `public` — então é `public` que o app
          // usa de verdade, e é o que esta sonda tem de perguntar para estar
          // medindo o mesmo banco que o app enxerga.
          "Accept-Profile": "public",
        },
        cache: "no-store",
        // Nenhum redirecionamento recebe a credencial privilegiada.
        redirect: "error",
      }),
    );
    // 401/403 continua down: usar credencial backend não transforma recusa em sucesso.
    if (res.status === 200) {
      return { status: "ok", latency_ms: Date.now() - t0, target: alvoDe(url) };
    }
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: `http_${res.status}`,
      reason: motivoDoStatusHttp(res.status),
      target: alvoDe(url),
    };
  } catch (e) {
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: "request_failed",
      reason: classificarFalhaDeAlcance(e),
      target: alvoDe(url),
    };
  }
}

async function checkRedis(): Promise<Check> {
  const t0 = Date.now();
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;

  /**
   * A FORMA do valor vem antes da ida à rede, e o motivo é o que quem opera faz
   * a seguir.
   *
   * Um `.env` com as aspas sobrando (`URL="https://srh:80"`) hoje chega até o
   * `fetch`, falha, e o `reason` que sai é o de alcance — indistinguível do
   * contêiner do Redis realmente parado. As duas leituras mandam o operador
   * para lugares opostos: uma para reiniciar um serviço que está de pé, a outra
   * para o editor. `configuracao_invalida` separa as duas SEM ida à rede.
   *
   * Só "não configurado" segue `degraded`: é integração que ninguém contratou.
   * Configurado errado é `down` — o produto conta com o Redis e não o tem.
   *
   * Mesmo no modo verboso, só nomes de variáveis entram no erro. O valor pode
   * conter credenciais coladas por engano; `alvoDe` limita o alvo a host/porta.
   */
  const config = validarConfigRedisRest(url, token);
  if (!config.ok) {
    if (config.reason === "nao_configurado") {
      return { status: "degraded", latency_ms: 0, error: "not_configured", reason: "nao_configurado" };
    }
    return {
      status: "down",
      latency_ms: 0,
      error: "configuracao_invalida: confira UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN",
      reason: "configuracao_invalida",
      target: alvoDe(url),
    };
  }
  try {
    // Protocolo REST do Upstash (compatível com serverless-redis-http): comando no
    // corpo via POST na raiz. NÃO existe GET /ping — daria 404 no SRH self-host.
    const res = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["PING"]),
        cache: "no-store",
      }),
    );
    if (!res.ok) {
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: `http_${res.status}`,
        reason: motivoDoStatusHttp(res.status),
        target: alvoDe(url),
      };
    }
    const pong: unknown = await withTimeout(res.json().catch(() => null));
    if (typeof pong !== "object" || pong === null || !("result" in pong) || pong.result !== "PONG") {
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: "invalid_ping_response",
        reason: "resposta_inesperada",
        target: alvoDe(url),
      };
    }
    return { status: "ok", latency_ms: Date.now() - t0, target: alvoDe(url) };
  } catch (e) {
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: "request_failed",
      reason: classificarFalhaDeAlcance(e),
      target: alvoDe(url),
    };
  }
}

async function checkWaha(): Promise<Check> {
  const t0 = Date.now();
  const base = env.WAHA_API_BASE_URL;
  const key = env.WAHA_API_KEY;
  if (!base && !key) {
    return { status: "degraded", latency_ms: 0, error: "not_configured", reason: "nao_configurado" };
  }
  if (!base?.trim() || !key?.trim() || key.trim() === "dev_plaintext_change_me") {
    return { status: "down", latency_ms: 0, error: "invalid_config", reason: "configuracao_invalida" };
  }
  try {
    // /api/sessions valida conectividade E autenticação num tiro só. O WAHA Core não
    // expõe /api/health (daria 404 mesmo autenticado).
    const res = await withTimeout(
      fetch(`${base.replace(/\/$/, "")}/api/sessions`, {
        headers: { "X-Api-Key": key },
        cache: "no-store",
      }),
    );
    if (!res.ok) {
      return {
        status: "down",
        latency_ms: Date.now() - t0,
        error: `http_${res.status}`,
        reason: motivoDoStatusHttp(res.status),
        target: alvoDe(base),
      };
    }
    return { status: "ok", latency_ms: Date.now() - t0, target: alvoDe(base) };
  } catch (e) {
    return {
      status: "down",
      latency_ms: Date.now() - t0,
      error: "request_failed",
      reason: classificarFalhaDeAlcance(e),
      target: alvoDe(base),
    };
  }
}

/**
 * O segredo interno dos crons também abre o modo verboso. Mesmo contrato de
 * `/api/v1/system/agent`: Bearer, comparação em tempo constante, e segredo vazio
 * nunca vira credencial válida.
 */
function segredoInternoConfere(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const fornecido = bearer || (req.headers.get("x-cron-secret")?.trim() ?? "");
  if (!fornecido) return false;
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  return aceitos.some((esperado) => {
    const a = Buffer.from(fornecido);
    const b = Buffer.from(esperado);
    // timingSafeEqual LANÇA se os tamanhos diferirem.
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

/**
 * Sem o segredo, o endereço não sai — nem pelo `target`, nem pelo `error`.
 *
 * O `target` sempre foi escondido de propósito: esta rota é PÚBLICA (o `GET` não
 * exige nada; o segredo interno só destrava o `?verbose=1`), e o cabeçalho deste
 * arquivo chama o endereço de WAHA e Redis do cliente de superfície de ataque.
 * O `error` também já expôs esse endereço ao devolver mensagens cruas do fetch.
 *
 * Medido, com valores que passam pelo Zod de `lib/env.ts` — porque só
 * `NEXT_PUBLIC_SUPABASE_URL` é `.url()`; os endereços opcionais WAHA/Redis
 * ficam para os checks de cada integração, sem derrubar o Web no import:
 *
 *   "redis-interno.hostgator-vps.com"
 *     -> e.message = "Failed to parse URL from redis-interno.hostgator-vps.com"
 *   `"https://redis-interno.hostgator-vps.com"`  (aspas sobrando no .env)
 *     -> e.message = "Failed to parse URL from \"https://redis-interno...\""
 *
 * Ou seja: exatamente os dois serviços cujo endereço a rota esconde por decisão
 * escrita, e exatamente a instalação self-host que erra o `.env` — o caso já
 * catalogado nesta casa como ".env sem aspas". O `error` publicava pela porta
 * que a redação do `target` fechou.
 *
 * Hoje até o modo verboso recebe somente códigos estáveis, nomes de variáveis
 * e `alvoDe(url)` sem userinfo/caminho/query/fragmento. Ter o segredo interno
 * não autoriza expor outra credencial que apareceu numa URL ou erro externo.
 * `reason` continua distinguindo DNS, recusa, timeout e credencial recusada;
 * este filtro público remove também o alvo e os detalhes de configuração.
 */
function semAlvo(check: Check): Check {
  const { target: _oculto, error, ...resto } = check;
  return error === undefined ? resto : { ...resto, error: "erro_ao_consultar" };
}

export async function GET(req: NextRequest) {
  const [supabase, redis, waha] = await Promise.all([
    checkSupabase(),
    checkRedis(),
    checkWaha(),
  ]);

  const verboso = req.nextUrl.searchParams.get("verbose") === "1" && segredoInternoConfere(req);
  const filtrar = verboso ? (c: Check) => c : semAlvo;
  const checks = { supabase: filtrar(supabase), redis: filtrar(redis), waha: filtrar(waha) };

  const anyDown = Object.values(checks).some((c) => c.status === "down");
  const anyDegraded = Object.values(checks).some((c) => c.status === "degraded");
  const status: "healthy" | "degraded" | "unhealthy" = anyDown
    ? "unhealthy"
    : anyDegraded
      ? "degraded"
      : "healthy";

  const httpStatus = status === "unhealthy" ? 503 : 200;

  return NextResponse.json(
    {
      data: {
        status,
        // APP_VERSION é injetada no build da imagem (ARG no Dockerfile) e vale
        // "1.2.3" numa release, ou o SHA curto fora de tag.
        //
        // Antes isto era `process.env.npm_package_version ?? "0.1.0"`, e a
        // variável só existe quando o processo nasce de um `npm`/`pnpm run`. O
        // CMD da imagem é `node server.js`: TODA instalação do mundo reportava
        // "0.1.0". Um campo que responde o valor errado com confiança é pior que
        // um campo ausente — ele desliga a pergunta em vez de deixá-la aberta.
        // Por isso o fallback agora é "desconhecido", e não um número plausível.
        version: process.env.APP_VERSION || "desconhecido",
        timestamp: new Date().toISOString(),
        checks,
      },
    },
    { status: httpStatus },
  );
}
