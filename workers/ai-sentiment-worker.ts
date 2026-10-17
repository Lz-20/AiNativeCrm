/**
 * ai-sentiment-worker — classifies the sentiment of inbound messages.
 *
 * Consumes `message.received` events (parallel to ai-response-worker).
 * Uses the configured provider through the Pi runtime and validates its JSON
 * response with a strict Zod schema so the result is always typed.
 *
 * Design principles (CLAUDE.md):
 * - Service-role admin client bypasses RLS → EVERY query filters `organization_id`
 *   programmatically from the trusted event_log row, never from user input.
 * - Any failure is swallowed (try/catch global) so the bot path in
 *   ai-response-worker keeps running unaffected.
 * - `console.log` is forbidden — only `console.warn`/`console.error` with prefix.
 */

import { z } from "zod";

import { resolverAgenteDaConversa } from "@/lib/ai/agents/agente-da-conversa";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { DEFAULT_CLASSIFIER_MODEL } from "@/lib/ai/gateway";
import { createAgentRuntime } from "@/lib/agent-runtime";
import {
  LlmNotConfiguredError,
  llmEdgeConfigFromEnv,
  runModelCall,
} from "@/lib/agent-engine/edge/llm/run-model-call";
import { createPool } from "@/lib/agent-engine/db/pool";
import { SENTIMENT_SYSTEM_PROMPT } from "@/lib/ai/prompts/sentiment";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";

const SENTIMENT_MODEL = DEFAULT_CLASSIFIER_MODEL; // "anthropic/claude-haiku-4-5"
const DEFAULT_SENTIMENT_THRESHOLD = 0.3;
const CLASSIFY_TIMEOUT_MS = 5_000;

let _llmPool: ReturnType<typeof createPool> | null = null;
function llmPool() {
  if (!_llmPool) _llmPool = createPool(process.env.SUPABASE_DB_URL ?? "");
  return _llmPool;
}

function llmConfig() {
  return llmEdgeConfigFromEnv({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    LLM_CACHE_TTL: process.env.LLM_CACHE_TTL,
    AI_BUDGET_ENFORCEMENT: process.env.AI_BUDGET_ENFORCEMENT,
    DEEPSEEK_THINKING: process.env.DEEPSEEK_THINKING,
    AGENT_RUNTIME: process.env.AGENT_RUNTIME,
  });
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  return JSON.parse(candidate);
}

// As descrições NÃO são decoração: viram o JSON Schema da ferramenta que o
// provider manda ao modelo. Sem elas o `.max(100)` existia só no validador — o
// modelo nunca ficava sabendo do limite e escrevia 223, 297, 340 caracteres
// (medido com mensagens reais desta instalação). Com a descrição, o mesmo
// conjunto caiu para 59–102.
//
// O teto do Zod é FOLGADO de propósito. Modelo não conta caractere: mesmo
// avisado, uma amostra bateu 102. Reprovar a classificação inteira por 2
// caracteres a mais seria péssimo negócio — ainda mais porque
// `reasoning_short` é DESCARTADO (só `sentiment_score` e a latência vão para
// messages.metadata). Ele existe para o modelo raciocinar antes de pontuar,
// não para ser guardado. A descrição segura a verbosidade (e o custo); o teto
// só impede resposta absurda.
const sentimentSchema = z.object({
  sentiment_score: z
    .number()
    .min(0)
    .max(1)
    .describe("0 = muito negativo, 0.5 = neutro, 1 = muito positivo"),
  reasoning_short: z
    .string()
    .max(280)
    .describe("Justificativa curta da nota, em NO MÁXIMO 100 caracteres"),
});

export interface SentimentResult {
  skipped: boolean;
  reason?: string;
  sentiment_score?: number;
}

export async function processSentiment(event: EventRow): Promise<SentimentResult> {
  try {
    const messageId =
      (event.payload?.["message_id"] as string | undefined) ?? event.entity_id ?? null;
    const conversationId = (event.payload?.["conversation_id"] as string | undefined) ?? null;
    if (!messageId) {
      return { skipped: true, reason: "missing_message_id" };
    }

    const admin = createAdminClient();

    // ── Load message (programmatic org filter) ────────────────────────────
    const { data: message, error: msgErr } = await admin
      .from("messages")
      .select("id, body, direction, conversation_id, organization_id, metadata")
      .eq("id", messageId)
      .eq("organization_id", event.organization_id)
      .maybeSingle();

    if (msgErr || !message) {
      return { skipped: true, reason: "message_not_found" };
    }

    // ── Guard: inbound only ───────────────────────────────────────────────
    if (message.direction !== "inbound") {
      return { skipped: true, reason: "not_inbound" };
    }

    // ── Guard: non-empty body ─────────────────────────────────────────────
    const body = (message.body ?? "").trim();
    if (!body) {
      return { skipped: true, reason: "empty_body" };
    }

    // ── Guard: elegibilidade da IA ────────────────────────────────────────
    // O único efeito deste worker é alimentar o handoff por sentimento
    // (`ai.sentiment_alert` → `triggerHandoff`). Numa conversa que o gate
    // `allowlist` barra, `triggerHandoff` já se recusa — então classificar aqui
    // seria só queimar um Haiku à toa. Pula cedo. `open` (o default) segue.
    // Fail-closed: erro de leitura → pula (sem custo, sem efeito).
    const convIdParaGate = conversationId ?? (message.conversation_id as string | null);
    if (convIdParaGate) {
      try {
        const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
          organizationId: event.organization_id,
          conversationId: convIdParaGate,
          agora: new Date(),
          ttlMs: ttlDaAutorizacaoMs(process.env),
        });
        if (elegib !== null && elegib.bloqueioPorAllowlist) {
          return { skipped: true, reason: "nao_elegivel_para_ia" };
        }
      } catch {
        return { skipped: true, reason: "elegibilidade_indeterminada" };
      }
    }

    // ── Qual agente atende ESTA conversa? ─────────────────────────────────
    //
    // Antes, a resposta era "o primeiro da organização que atende", ordenado por
    // `is_default` e depois `created_at` — e a conversa que disparou o evento não
    // entrava na consulta em lugar nenhum. Com um agente só, certo por acidente.
    // Com dois, o limiar em vigor passava a depender da ORDEM DE CRIAÇÃO: numa
    // clínica, cliente triste é sinal de problema; numa assistência técnica, é o
    // cliente normal. O mesmo limiar erra nos dois sentidos, e quem configurou o
    // campo do agente B ficava vendo o comportamento do agente A sem pista
    // nenhuma na tela — os dois campos existem, os dois aceitam valor, e um
    // deles não fazia nada. (issue #486)
    const { data: conversa } = await admin
      .from("conversations")
      .select("id, channel_session_id, active_ai_agent_id")
      .eq("id", message.conversation_id)
      .eq("organization_id", event.organization_id)
      .maybeSingle();

    // As versões PUBLICADAS ligadas ao número em que a conversa acontece — é
    // quem de fato responde ao cliente por aquela sessão. `null` (não consegui
    // consultar) e `[]` (consultei, não há) levam ao mesmo desfecho na régua,
    // mas quem lê o log precisa distinguir os dois.
    let versoesPublicadasNaSessao: string[] | null = null;
    if (conversa?.channel_session_id) {
      const { data: versoes } = await admin
        .from("ai_agent_versions")
        .select("id, channel_session_id, status")
        .eq("organization_id", event.organization_id)
        .eq("channel_session_id", conversa.channel_session_id)
        .eq("status", "published");
      versoesPublicadasNaSessao = (versoes ?? []).map((v) => v.id as string);
    }

    const { data: candidatos } = await admin
      .from("ai_agents")
      .select(
        "id, config, kind, is_active, paused_at, published_version_id, archived_at, priority, created_at",
      )
      .eq("organization_id", event.organization_id)
      .is("archived_at", null);

    const { agente: agent, motivo: motivoDoAgente } = resolverAgenteDaConversa(
      candidatos ?? [],
      conversa
        ? {
            active_ai_agent_id: conversa.active_ai_agent_id as string | null,
            versoesPublicadasNaSessao,
          }
        : null,
    );

    // Sem agente resolvido, o padrão do PRODUTO — nunca o limiar do vizinho.
    // Chutar a configuração de outro agente é o defeito de novo, agora com cara
    // de configuração deliberada.
    const agentConfig = (agent?.config as Record<string, unknown> | null) ?? {};
    const threshold =
      typeof agentConfig["sentiment_threshold"] === "number"
        ? agentConfig["sentiment_threshold"]
        : DEFAULT_SENTIMENT_THRESHOLD;

    // ── Call LLM ──────────────────────────────────────────────────────────
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), CLASSIFY_TIMEOUT_MS);

    const start = Date.now();
    let result: z.infer<typeof sentimentSchema>;
    try {
      const generated = await runModelCall(
        llmPool(),
        llmConfig(),
        {
          tenantId: event.organization_id,
          agentId: agent?.id ?? null,
          purpose: "sentiment_classify",
          model: SENTIMENT_MODEL,
          system: `${SENTIMENT_SYSTEM_PROMPT}\nResponda SOMENTE com JSON válido neste formato: {"sentiment_score": number entre 0 e 1, "reasoning_short": string com no máximo 280 caracteres}.`,
          messages: [{ role: "user", content: body }],
          maxSteps: 1,
          maxOutputTokens: 256,
          abortSignal: abortController.signal,
        },
        { runtime: createAgentRuntime() },
      );

      result = sentimentSchema.parse(parseJsonObject(generated.result.text));
    } catch (err) {
      // O seam já grava sucesso/falha em `llm_calls`; este worker só converte
      // ausência de credencial em skip, preservando a semântica do handler.
      if (err instanceof LlmNotConfiguredError) {
        return { skipped: true, reason: "ai_gateway_key_missing" };
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const latencyMs = Date.now() - start;

    // ── Merge sentiment into messages.metadata ────────────────────────────
    const existingMetadata = (message.metadata as Record<string, unknown> | null) ?? {};
    const updatedMetadata = {
      ...existingMetadata,
      sentiment_score: result.sentiment_score,
      sentiment_latency_ms: latencyMs,
    };

    const { error: updateErr } = await admin
      .from("messages")
      .update({ metadata: updatedMetadata })
      .eq("id", messageId)
      .eq("organization_id", event.organization_id);

    if (updateErr) {
      console.warn("[ai-sentiment-worker] metadata update failed", {
        message_id: messageId,
        error: updateErr.message,
      });
    }

    // ── Emit alert if below threshold ────────────────────────────────────
    if (result.sentiment_score < threshold) {
      const { error: emitErr } = await admin.rpc(
        "emit_event" as never,
        {
          p_event_type: "ai.sentiment_alert",
          p_entity_kind: "message",
          p_entity_id: messageId,
          p_payload: {
            message_id: messageId,
            conversation_id: conversationId ?? message.conversation_id ?? null,
            sentiment_score: result.sentiment_score,
          },
          // `agent_id` e `motivo` viajam com o alerta porque o limiar é o número
          // que decidiu emiti-lo: sem eles, "por que este alerta saiu?" recomeça
          // do zero, e foi essa ausência que deixou o defeito da #486 invisível
          // pela tela — os dois campos existiam e um não fazia nada.
          p_metadata: {
            source: "ai-sentiment-worker",
            threshold,
            agent_id: agent?.id ?? null,
            agente_resolvido_por: motivoDoAgente,
          },
          p_organization_id: event.organization_id,
        } as never,
      );

      if (emitErr) {
        console.warn("[ai-sentiment-worker] ai.sentiment_alert emit failed", {
          message_id: messageId,
          error: emitErr.message,
        });
      }
    }

    return { skipped: false, sentiment_score: result.sentiment_score };
  } catch (err) {
    // Global catch: NEVER throw — must not break the bot path.
    console.warn("[ai-sentiment-worker] sentiment_classify_failed", {
      event_id: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { skipped: true, reason: "classify_failed" };
  }
}
