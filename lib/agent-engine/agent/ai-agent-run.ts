/**
 * CRM composition for persisted `ai_agent_runs` and the agent test endpoint.
 *
 * This module owns run persistence, channel resolution, MCP tool assembly, and
 * finalization. Provider/model/credential/budget/pricing governance belongs to
 * the Model Gateway; the Agent Loop itself is delegated to AgentRuntime.
 *
 * Sequence (Spec 10 §6):
 *   1. Load run + version
 *   2. Sentinel keyword check on inbound → finalizeHandoff('keyword_match')
 *   3. Mint ephemeral api_token + setup MCP context
 *   4. Build tool set (in-process bridge to lib/mcp/tools)
 *   5. Load history sliding window
 *   6. PiAgentRuntime executes the Agent Loop with CRM stop policy callbacks
 *   7. Detect handoff signal → finalizeHandoff('agent_invoked_tool')
 *   8. !dry_run → outbound message via sendMessageHandler (canal da sessão)
 *   9. finalizeRun
 *  10. revoke ephemeral token (always)
 *
 * Robustness:
 *   - Try/catch global: any throw → finalizeRun('failed', error_message=...).
 *   - Dry-run path bypasses concurrency unique guard, channel dispatch, outbound row.
 *   - Plaintext API keys are never logged.
 */
import type { AgentRuntime } from "@/lib/agent-runtime";
import { llmEdgeConfigFromEnv, runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { createPool } from "@/lib/agent-engine/db/pool";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";
import { finalizeRun, sendFinalResponse } from "@/lib/ai/runtime/finalize";
import { finalizeHandoff } from "@/lib/ai/runtime/handoff";
import { loadHistoryWithBudget } from "@/lib/ai/runtime/history";
import { mintEphemeralToken, revokeEphemeralToken } from "@/lib/ai/runtime/mcp_token";
import { pickToolsFromMcp, type RuntimeHandoffSignal } from "@/lib/ai/runtime/tools";
import { serializeSteps } from "@/lib/ai/runtime/serialize";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";

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

export interface RunAgentInput {
  runId: string;
  /** Runtime is supplied by the application/worker composition root. */
  runtime: AgentRuntime;
  /** Optional override for test mode invocations from /ai/agents/:id/versions/:vid/test. */
  override?: {
    sampleMessage?: string;
    sampleContact?: { name?: string; phone?: string };
  };
}

export interface RunAgentResult {
  run_id: string;
  status: "completed" | "failed" | "aborted" | "handoff" | "skipped";
  final_text?: string;
  tool_calls?: ReturnType<typeof serializeSteps>;
  tokens_in?: number;
  tokens_out?: number;
  cost_cents?: number;
  latency_ms?: number;
  steps_count?: number;
  abort_reason?: string;
  error_code?: string;
  error_message?: string;
  would_send_to?: { session: string | null; chat_id: string | null };
}

interface RunRow {
  id: string;
  organization_id: string;
  agent_id: string;
  agent_version_id: string;
  conversation_id: string | null;
  contact_id: string | null;
  channel_session_id: string | null;
  inbound_message_id: string | null;
  status: string;
  is_dry_run: boolean;
}

interface VersionRow {
  id: string;
  organization_id: string;
  agent_id: string;
  system_prompt: string;
  provider: string;
  model: string;
  credential_id: string | null;
  tool_ids: string[];
  channel_session_id: string;
  max_steps: number;
  token_budget: number;
  cost_budget_cents: number;
  history_message_window: number;
  history_token_window: number;
  handoff_keywords: string[];
  handoff_tool_enabled: boolean;
  created_by: string | null;
}

interface AgentRow {
  id: string;
  organization_id: string;
  created_by: string | null;
}

function buildSentinelRegex(keywords: string[]): RegExp | null {
  const cleaned = keywords.filter((k) => typeof k === "string" && k.trim().length > 0);
  if (cleaned.length === 0) return null;
  const escaped = cleaned.map((k) => k.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(${escaped.join("|")})`, "i");
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const admin = createAdminClient();
  const startedAt = Date.now();

  // 1) Load run row.
  const { data: runRaw } = await admin
    .from("ai_agent_runs")
    .select(
      "id, organization_id, agent_id, agent_version_id, conversation_id, contact_id, channel_session_id, inbound_message_id, status, is_dry_run",
    )
    .eq("id", input.runId)
    .maybeSingle();

  const run = runRaw as RunRow | null;
  if (!run) {
    return { run_id: input.runId, status: "failed", error_code: "run_not_found" };
  }

  // Idempotency: terminal states early-return; running is treated as in-flight elsewhere.
  if (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "aborted" ||
    run.status === "handoff"
  ) {
    return { run_id: run.id, status: "skipped" };
  }

  // 2) Promote to running. For non-dry-run rows, the partial unique index
  // (status='running' AND is_dry_run=false) protects from double-execution.
  const { error: promoteErr } = await admin
    .from("ai_agent_runs")
    .update({ status: "running" })
    .eq("id", run.id)
    .eq("organization_id", run.organization_id);
  if (promoteErr) {
    if (promoteErr.code === "23505") {
      // Conversation already has a running run.
      return { run_id: run.id, status: "skipped", abort_reason: "conv_busy" };
    }
    return failFast(run, "internal_error", `promote_failed: ${promoteErr.message}`, startedAt);
  }

  void audit({
    action: "ai_agent.run_started",
    organizationId: run.organization_id,
    resourceType: "ai_agent_run",
    resourceId: run.id,
    metadata: {
      agent_id: run.agent_id,
      agent_version_id: run.agent_version_id,
      is_dry_run: run.is_dry_run,
    },
  });
  await admin.rpc(
    "emit_event" as never,
    {
      p_event_type: "ai_agent.run_started",
      p_entity_kind: "ai_agent_run",
      p_entity_id: run.id,
      p_payload: { run_id: run.id, agent_id: run.agent_id, is_dry_run: run.is_dry_run },
      p_metadata: { source: "agent-runtime" },
      p_organization_id: run.organization_id,
    } as never,
  );

  let ephemeralTokenId: string | null = null;

  try {
    // 3) Load version.
    const { data: versionRaw } = await admin
      .from("ai_agent_versions")
      .select(
        // `pipeline_ids` e `knowledge_source_ids` ENTRAM no SELECT.
        //
        // A linha 445 lia `version.pipeline_ids` de um objeto que este SELECT
        // nunca trouxe: o `?? []` do call site absorvia o `undefined` e o escopo
        // ficava SEMPRE vazio neste runtime — a marcação da tela existia e não
        // valia aqui. Coluna lida que o SELECT não pede é o defeito que
        // `agent-version-columns-drift.test.ts` existe para pegar nas cópias
        // vigiadas; esta não é uma delas.
        "id, organization_id, agent_id, system_prompt, provider, model, credential_id, tool_ids, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, created_by, pipeline_ids, knowledge_source_ids",
      )
      .eq("id", run.agent_version_id)
      .eq("organization_id", run.organization_id)
      .maybeSingle();
    const version = versionRaw as VersionRow | null;
    if (!version) {
      return await failRun(run, "version_not_found", "agent version missing", startedAt);
    }

    const { data: agentRaw } = await admin
      .from("ai_agents")
      .select("id, organization_id, created_by")
      .eq("id", run.agent_id)
      .eq("organization_id", run.organization_id)
      .maybeSingle();
    const agent = agentRaw as AgentRow | null;

    // 4) Resolve inbound text + dispatch context.
    let inboundBody: string | null = null;
    let chatId: string | null = null;
    let waSessionName: string | null = null;
    const conversationIdForHandoff: string | null = run.conversation_id;

    if (run.is_dry_run) {
      inboundBody = input.override?.sampleMessage?.trim() ?? null;
      chatId = input.override?.sampleContact?.phone ?? null;
    } else if (run.inbound_message_id) {
      const { data: msg } = await admin
        .from("messages")
        .select("body")
        .eq("id", run.inbound_message_id)
        .eq("organization_id", run.organization_id)
        .maybeSingle();
      inboundBody = (msg?.body as string | null) ?? null;
    }

    // For non-dry-run, prefetch session_name + contact phone (chatId).
    if (!run.is_dry_run && run.conversation_id) {
      const { data: convRaw } = await admin
        .from("conversations")
        .select(
          `id, group_chat_id, is_group, contacts:contact_id(phone_number, wa_identity, wa_lid), channel_sessions:channel_session_id(${CHANNEL_SESSION_REF_COLUMNS})`,
        )
        .eq("id", run.conversation_id)
        .eq("organization_id", run.organization_id)
        .maybeSingle();
      const conv = convRaw as unknown as {
        id: string;
        group_chat_id: string | null;
        is_group: boolean;
        contacts: {
          phone_number: string | null;
          wa_identity: string | null;
          wa_lid: string | null;
        } | null;
        channel_sessions: ChannelSessionRef | null;
      } | null;
      if (conv) {
        // Mesmo seam do handler de envio: quem sabe de que coluna sai o ref da
        // sessão, e como o telefone vira endereço, é `lib/channels/`.
        waSessionName = conv.channel_sessions ? resolveSessionRef(conv.channel_sessions) : null;
        chatId = getAdapter(
          conv.channel_sessions?.provider ?? DEFAULT_CHANNEL_PROVIDER,
        ).resolveRecipient({
          isGroup: conv.is_group,
          groupChatId: conv.group_chat_id,
          phoneNumber: conv.contacts?.phone_number,
          waIdentity: conv.contacts?.wa_identity,
          waLid: conv.contacts?.wa_lid,
        });
      }

      // GATE DE ELEGIBILIDADE — este caminho de ensaio/execução interna
      // também não pode
      // responder uma conversa que uma origem elegível não autorizou. Mesma
      // regra pura do drain/turno. Fail-closed: erro de leitura → falha o run
      // antes de qualquer custo de LLM.
      try {
        const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
          organizationId: run.organization_id,
          conversationId: run.conversation_id,
          agora: new Date(),
          ttlMs: ttlDaAutorizacaoMs(process.env),
        });
        if (elegib !== null && !elegib.permite) {
          return await failRun(
            run,
            "nao_elegivel_para_ia",
            `elegibilidade: ${elegib.motivo}`,
            startedAt,
          );
        }
      } catch (err) {
        return await failRun(
          run,
          "nao_elegivel_para_ia",
          `elegibilidade indeterminada: ${err instanceof Error ? err.message.slice(0, 120) : "erro"}`,
          startedAt,
        );
      }
    }

    if (!inboundBody) {
      return await failRun(run, "inbound_missing", "no inbound body to process", startedAt);
    }

    // 5) Sentinel keyword check (BEFORE LLM cost).
    const sentinel = buildSentinelRegex(version.handoff_keywords ?? []);
    if (sentinel && sentinel.test(inboundBody)) {
      await finalizeHandoff({
        runId: run.id,
        organizationId: run.organization_id,
        conversationId: conversationIdForHandoff,
        reason: "requested_human",
        source: "sentinel",
        latencyMs: Date.now() - startedAt,
        isDryRun: run.is_dry_run,
      });
      return {
        run_id: run.id,
        status: "handoff",
        abort_reason: "sentinel:requested_human",
        latency_ms: Date.now() - startedAt,
        tokens_in: 0,
        tokens_out: 0,
        cost_cents: 0,
        steps_count: 0,
        would_send_to: { session: waSessionName, chat_id: chatId },
      };
    }

    // 6) Mint ephemeral token + build MCP context.
    const ephemeral = await mintEphemeralToken({
      organizationId: run.organization_id,
      runId: run.id,
      versionCreatedBy: version.created_by,
      agentCreatedBy: agent?.created_by,
    });
    ephemeralTokenId = ephemeral.id;

    const auth: McpAuthResult = {
      organizationId: run.organization_id,
      role: "ai_operator",
      actor: {
        type: "ai_agent",
        // `id` é o RUN — é o que correlaciona a chamada de tool com o turno no
        // audit. `agent_id` é a linha em `ai_agents`, e é a única que pode ir
        // para `crm_lead_activities.actor_agent_id` (FK). Enquanto só existia
        // `id`, toda tool de escrita chamada por este runtime perdia a atividade
        // na FK: o lead mudava e a timeline não registrava. Ver `Actor` em
        // lib/api/handlers/types.ts.
        id: run.id,
        agent_id: run.agent_id,
        role: "ai_operator",
        api_token_id: ephemeral.id,
      },
      apiTokenId: ephemeral.id,
      scopes: [
        "mcp:read",
        "mcp:write",
        "actor:ai_agent",
        `agent_run:${run.id}`,
        "role:ai_operator",
      ],
    };
    const ctx: McpContext = {
      organizationId: run.organization_id,
      role: "ai_operator",
      actor: auth.actor,
      apiTokenId: ephemeral.id,
      requestId: run.id,
      supabase: admin,
    };
    const handoffSignal: RuntimeHandoffSignal = { triggered: false };
    const tools = pickToolsFromMcp({
      supabase: admin,
      ctx,
      auth,
      toolIds: version.tool_ids ?? [],
      handoffToolEnabled: version.handoff_tool_enabled,
      // `?? []` — o clone sem a coluna 0125 nasce FECHADO.
      pipelineIds: (version as { pipeline_ids?: string[] }).pipeline_ids ?? [],
      handoffSignal,
    });

    // 7) Load history with budget.
    const history = run.conversation_id
      ? await loadHistoryWithBudget(admin, {
          conversationId: run.conversation_id,
          organizationId: run.organization_id,
          messageWindow: version.history_message_window,
          tokenWindow: version.history_token_window,
          excludeMessageId: run.inbound_message_id ?? undefined,
        })
      : [];

    // 8) Pi owns the Agent Loop; CRM still owns the stop policy and handoff state.
    let abortReason: string | null = null;
    const accumulatedUsage = { inputTokens: 0, outputTokens: 0 };

    // 9) Run the loop through the canonical Model Gateway/runtime seam.
    const messages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: inboundBody },
    ];

    const call = await runModelCall(
      llmPool(),
      llmConfig(),
      {
        tenantId: run.organization_id,
        agentId: run.agent_id,
        leadId: run.contact_id,
        purpose: "agent_turn",
        system: version.system_prompt,
        messages,
        tools,
        model: version.model,
        maxSteps: version.max_steps,
        llmOverride: { provider: version.provider, credentialId: version.credential_id },
        shouldStopAfterTurn: async ({ usage, costCents }) => {
          if (handoffSignal.triggered) {
            abortReason = "handoff_tool";
            return true;
          }
          accumulatedUsage.inputTokens += usage.inputTokens;
          accumulatedUsage.outputTokens += usage.outputTokens;
          if (accumulatedUsage.inputTokens + accumulatedUsage.outputTokens > version.token_budget) {
            abortReason = "token_budget_exceeded";
            return true;
          }
          if ((costCents ?? 0) > version.cost_budget_cents) {
            abortReason = "cost_budget_exceeded";
            return true;
          }
          return false;
        },
      },
      { runtime: input.runtime },
    );
    const result = call.result;

    // 11) Aggregate metrics.
    const usage = {
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
    };
    const cost = call.costCents ?? 0;
    const latencyMs = Date.now() - startedAt;
    const trace = serializeSteps(result.steps as never);

    // 13) Handoff via tool call?
    if (handoffSignal.triggered) {
      await finalizeHandoff({
        runId: run.id,
        organizationId: run.organization_id,
        conversationId: conversationIdForHandoff,
        reason: (handoffSignal.reason as never) ?? "requested_human",
        source: "tool",
        latencyMs,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costCents: cost,
        stepsCount: result.turnCount,
        toolCalls: trace,
        isDryRun: run.is_dry_run,
      });
      return {
        run_id: run.id,
        status: "handoff",
        abort_reason: `tool:${handoffSignal.reason ?? "requested_human"}`,
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        cost_cents: cost,
        latency_ms: latencyMs,
        steps_count: result.turnCount,
        tool_calls: trace,
        would_send_to: { session: waSessionName, chat_id: chatId },
      };
    }

    // 14) Budget abort detected by the CRM-owned post-turn policy?
    if (abortReason) {
      await finalizeRun({
        runId: run.id,
        organizationId: run.organization_id,
        status: "aborted",
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costCents: cost,
        latencyMs,
        stepsCount: result.turnCount,
        toolCalls: trace,
        abortReason,
        isDryRun: run.is_dry_run,
      });
      return {
        run_id: run.id,
        status: "aborted",
        abort_reason: abortReason,
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        cost_cents: cost,
        latency_ms: latencyMs,
        steps_count: result.turnCount,
        tool_calls: trace,
        would_send_to: { session: waSessionName, chat_id: chatId },
      };
    }

    // 15) Hit max steps without natural finish?
    if (result.turnCount >= version.max_steps && abortReason === null) {
      await finalizeRun({
        runId: run.id,
        organizationId: run.organization_id,
        status: "aborted",
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        costCents: cost,
        latencyMs,
        stepsCount: result.turnCount,
        toolCalls: trace,
        abortReason: "max_steps_reached",
        isDryRun: run.is_dry_run,
      });
      return {
        run_id: run.id,
        status: "aborted",
        abort_reason: "max_steps_reached",
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        cost_cents: cost,
        latency_ms: latencyMs,
        steps_count: result.turnCount,
        tool_calls: trace,
        would_send_to: { session: waSessionName, chat_id: chatId },
      };
    }

    // 16) Happy path. Send the reply through the channel when not dry-run.
    let outboundMessageId: string | null = null;
    const finalText = (result.text ?? "").trim();
    if (!run.is_dry_run && finalText && run.conversation_id) {
      outboundMessageId = await sendFinalResponse({
        supabase: admin,
        organizationId: run.organization_id,
        runId: run.id,
        agentId: run.agent_id,
        conversationId: run.conversation_id,
        text: finalText,
        requestId: run.id,
      });
    }

    await finalizeRun({
      runId: run.id,
      organizationId: run.organization_id,
      status: "completed",
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
      costCents: cost,
      latencyMs,
      stepsCount: result.turnCount,
      toolCalls: trace,
      outboundMessageId,
      isDryRun: run.is_dry_run,
    });

    return {
      run_id: run.id,
      status: "completed",
      final_text: finalText,
      tokens_in: usage.inputTokens,
      tokens_out: usage.outputTokens,
      cost_cents: cost,
      latency_ms: latencyMs,
      steps_count: result.turnCount,
      tool_calls: trace,
      would_send_to: { session: waSessionName, chat_id: chatId },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await failRun(run, "runtime_error", message, startedAt);
  } finally {
    if (ephemeralTokenId) {
      await revokeEphemeralToken(ephemeralTokenId).catch(() => {
        // Token TTL=300s; lingering revoke failure is non-critical.
      });
    }
  }
}

async function failRun(
  run: RunRow,
  code: string,
  message: string,
  startedAt: number,
): Promise<RunAgentResult> {
  const latencyMs = Date.now() - startedAt;
  await finalizeRun({
    runId: run.id,
    organizationId: run.organization_id,
    status: "failed",
    errorCode: code,
    errorMessage: message,
    latencyMs,
    isDryRun: run.is_dry_run,
  });
  return {
    run_id: run.id,
    status: "failed",
    error_code: code,
    error_message: message,
    latency_ms: latencyMs,
  };
}

function failFast(run: RunRow, code: string, message: string, startedAt: number): RunAgentResult {
  // Used when we couldn't even promote to running — no row mutation here.
  return {
    run_id: run.id,
    status: "failed",
    error_code: code,
    error_message: message,
    latency_ms: Date.now() - startedAt,
  };
}
