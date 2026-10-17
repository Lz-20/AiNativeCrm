/**
 * Invariante de ALCANCE: o que a `OPENROUTER_API_KEY` roteia — e o que ela não
 * roteia.
 *
 * Por que este arquivo existe: o `.env.example` afirma ao self-hoster quais
 * caminhos passam a usar a OpenRouter quando ele preenche a chave. Afirmação em
 * comentário não se defende sozinha — a primeira pessoa que ligar o resolver a
 * um caminho novo não vai lembrar de reescrever o aviso, e o usuário decide a
 * configuração da instalação lendo justamente esse aviso.
 *
 * O alcance real hoje, medido: os workers de resposta e sentimento passam pelo
 * Model Gateway (`runModelCall`), que resolve binding, credencial, budget e
 * auditoria antes de entregar a execução ao runtime Pi. O resolvedor paralelo
 * que existia em `lib/ai/gateway-binding.ts` foi removido.
 *
 * A cobertura precisa acompanhar essa fronteira: `providers.ts` registra
 * `openrouter`, o adapter Pi entrega o binding ao turno com ferramentas, e
 * `tests/unit/provedores-x-registry.test.ts` casa a lista canônica com o
 * registry executável.
 * A chave também não chegava ao worker: `OPENROUTER_API_KEY` faltava no schema
 * de `lib/agent-engine/env.ts` e o Zod a removia no boot.
 *
 * Isso importa porque muda QUAL risco o usuário corre. Um modelo sem tool
 * calling sólido é catastrófico num turno com ferramentas (responde texto
 * plausível e nunca cria o lead nem move o card) e é inofensivo numa
 * classificação de sentimento. O aviso do `.env.example` agora explicita que
 * a chave pode alcançar o agente e que o painel recusa modelos sem tools.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validarBinding } from "@/lib/ai/pontos/validar-binding";

const RAIZ = resolve(__dirname, "../..");

/** Arquivos de produção que importam o resolver (exclui testes e o próprio módulo). */
function chamadoresDoResolver(): string[] {
  let saida = "";
  try {
    saida = execFileSync(
      "git",
      // `--color=never` não é decoração: `git grep` pode respeitar
      // `color.ui=always` no ~/.gitconfig mesmo sem TTY.
      ["grep", "--color=never", "-l", "resolverModeloDoPonto", "--", "lib", "workers", "app", "scripts"],
      { cwd: RAIZ, encoding: "utf8" },
    );
  } catch {
    // `git grep` sai com status 1 quando o resolvedor removido não existe mais.
    saida = "";
  }
  return saida
    .split("\n")
    .filter(Boolean)
    .filter(
      (f) =>
        !f.includes(".test.") &&
        f !== "lib/ai/gateway-binding.ts" &&
        f !== "lib/ai/gateway.ts" &&
        f !== "lib/env.ts",
    );
}

describe("alcance da OPENROUTER_API_KEY", () => {
  it("não há chamadores do resolvedor paralelo removido", () => {
    expect(chamadoresDoResolver()).toEqual([]);
  });

  it("o fallback de resposta usa o seam governado, não um resolvedor paralelo", () => {
    const fonte = readFileSync(resolve(RAIZ, "workers/ai-response-worker.ts"), "utf8");
    expect(fonte).toContain("runModelCall");
    expect(fonte).toContain('purpose: "bot_respond"');
    expect(fonte).not.toContain("resolverModeloDoPonto");
    expect(fonte).not.toContain("runPiAiSdkCall");
  });

  it("o agente com ferramentas AGORA está ao alcance da OpenRouter — e isso é deliberado", () => {
    // ─── A virada, e por que ela não afrouxa este arquivo ──────────────────
    //
    // Este teste dizia "continua fora do alcance" e o cabeçalho avisava: "no
    // dia em que alcançar, o aviso PRECISA assustar — e este teste é quem
    // obriga a decidir isso conscientemente". O dia chegou: a migration 0127
    // abriu `provider` como vocabulário aberto e `createDefaultRegistry`
    // registra `openrouter`, então uma chave da OpenRouter pode atender o ponto
    // que cria o lead.
    //
    // A guarda não foi removida — ela MUDOU DE ALVO. Antes protegia uma
    // ausência (o caminho não existe); agora protege a proteção (o caminho
    // existe e é vigiado). Apagar o teste teria devolvido verde e deixado o
    // risco solto, que é o pior desfecho possível para um invariante incômodo.
    expect(
      readFileSync(resolve(RAIZ, "lib/agent-engine/edge/llm/providers.ts"), "utf8").toLowerCase(),
    ).toContain("openrouter");
  });

  it("o risco novo tem catraca: modelo sem ferramentas é RECUSADO no ponto que cria o lead", () => {
    // É o desfecho que a abertura da OpenRouter torna possível e que ninguém
    // veria acontecer: o agente conversa bem, o cliente é atendido, e nada
    // chega ao funil — sem erro na tela.
    const semFerramentas = {
      model_id: "algum/modelo-sem-tools",
      supports_tools: false,
      supports_vision: false,
      conhecido: true,
    };
    for (const ponto of ["agent_turn", "operator_turn"]) {
      const r = validarBinding({ pontoId: ponto, modelo: semFerramentas });
      expect(r.ok, `${ponto} aceitou modelo sem ferramentas`).toBe(false);
      if (!r.ok) expect(r.codigo).toBe("modelo_sem_ferramentas");
    }
  });

  it("a catraca não é geral demais — classificador aceita modelo sem ferramentas", () => {
    // A recíproca. Recusar em todo ponto seria fechar o caso de uso mais
    // atraente da OpenRouter (modelo barato para classificar) e o teste acima
    // passaria igual.
    const r = validarBinding({
      pontoId: "stage_classifier",
      modelo: {
        model_id: "algum/modelo-barato",
        supports_tools: false,
        supports_vision: false,
        conhecido: true,
      },
    });
    expect(r.ok).toBe(true);
  });

  it("o aviso do .env.example acompanhou a virada", () => {
    // O cabeçalho deste arquivo existe por isto: o self-hoster decide a
    // configuração lendo o aviso, e um aviso escrito quando a OpenRouter não
    // alcançava o agente passou a mentir no instante em que ela alcançou.
    const aviso = readFileSync(resolve(RAIZ, ".env.example"), "utf8");
    const trecho = aviso.slice(aviso.toLowerCase().indexOf("openrouter"));
    expect(
      trecho.toLowerCase(),
      "o .env.example precisa avisar que a escolha do modelo agora afeta o agente com ferramentas",
    ).toMatch(/ferramenta|tool/);
  });
});
