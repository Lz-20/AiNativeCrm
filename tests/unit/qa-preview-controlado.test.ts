import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  afirmarDestinoDoPreviewControlado,
  CONFIG_PREVIEW_CONTROLADO,
  prepararPreviewControlado,
} from "../e2e/helpers/qa-preview-controlado";
import { resolveOrgLlmConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { applyPreviewPolicy, newPreviewResult, scenarioContext, type TurnPreview } from "@/lib/agent-engine/agent/preview";
import type { GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";
import { tool } from "@/lib/agent-engine/edge/llm/run-model-call";
import { runPiAiSdkCall } from "@/lib/agent-runtime/pi/ai-sdk-compat";
import { createPreviewAgentRuntime } from "@/lib/agent-runtime/pi/preview-fixture";

const destination = {
  url: "http://127.0.0.1:54321",
  dbUrl: "postgresql://localhost:54322/postgres",
  appUrl: "http://localhost:3001",
};

describe("fixture do preview controlado", () => {
  it.each([
    { ...destination, url: "https://example.supabase.co" },
    { ...destination, dbUrl: "postgresql://production.example/postgres" },
    { ...destination, appUrl: "https://crm.example" },
    { ...destination, url: "" },
    { ...destination, dbUrl: "" },
  ])("recusa destino remoto ou ambíguo antes de abrir o banco", (target) => {
    expect(() => afirmarDestinoDoPreviewControlado(target, "true")).toThrow(/locais/);
  });

  it("exige o modo controlado explicitamente", () => {
    expect(() => afirmarDestinoDoPreviewControlado(destination, undefined)).toThrow(/controlado/);
    expect(() => afirmarDestinoDoPreviewControlado(destination, "true")).not.toThrow();
  });

  it("valida só destinos, mesmo quando o objeto inclui credenciais opacas", () => {
    const credentials = { ...destination, serviceRole: "opaque-test-token", origem: "ambiente" };
    expect(() => afirmarDestinoDoPreviewControlado(credentials, "true")).not.toThrow();
  });

  it("resolve o mesmo provider da chave interna do runtime, sem decifrar o placeholder", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ llm: {} }] })
      .mockResolvedValueOnce({ rows: [] });
    const config = await resolveOrgLlmConfig(
      { query } as unknown as pg.Pool,
      { anthropicApiKey: "local-controlled-provider" },
      "org-local",
      { provider: CONFIG_PREVIEW_CONTROLADO.provider, credentialId: "fixture-unvalidated" },
    );
    expect(config.provider).toBe("anthropic");
    expect(config.origemDaChave).toBe("chave_da_instalacao");
    expect(query.mock.calls[1]?.[0]).toContain("validated_at is not null");
  });

  it("prepara só IDs próprios e limpa runs antes das FKs restritas", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: sql.includes("select u.id") ? [{ id: "admin-local" }] : [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
    const fixture = await prepararPreviewControlado(pool, {
      destination, controlled: "true", orgId: "org-local", adminEmail: "admin@invariant.test",
    });
    expect(fixture.provider).toBe("anthropic");
    expect(fixture.agentId).not.toBe(fixture.channelId);
    expect(queries.some(({ sql }) => sql.includes("validated_at") && sql.includes("null"))).toBe(true);
    expect(queries.find(({ sql }) => sql.includes("insert into channel_knobs"))?.params).toEqual([
      "org-local", fixture.channelId, 0, 24,
    ]);
    await fixture.cleanup();
    const deletes = queries.filter(({ sql }) => sql.startsWith("delete"));
    expect(deletes.map(({ sql }) => sql.match(/^delete from (\w+)/)?.[1])).toEqual([
      "ai_agent_runs", "ai_agent_versions", "ai_agents", "channel_knobs", "channel_sessions", "ai_provider_credentials",
    ]);
    for (const deletion of deletes) {
      expect(deletion.sql).toContain("organization_id=$1");
      expect(deletion.params?.[0]).toBe("org-local");
      expect([fixture.agentId, fixture.channelId, fixture.credentialId]).toContain(deletion.params?.[1]);
    }
  });

  it("recusa organização ou identidade inesperada e reverte a transação", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool;
    await expect(prepararPreviewControlado(pool, {
      destination, controlled: "true", orgId: "other-org", adminEmail: "admin@invariant.test",
    })).rejects.toThrow(/identidade/);
    expect(query.mock.calls.map((call) => call[0])).toContain("rollback");
    expect(query.mock.calls.some((call) => String(call[0]).startsWith("insert"))).toBe(false);
  });
});

async function previewAtNight(optedOut = false, fixtureWindow = true) {
  const now = new Date("2026-10-28T05:00:00Z"); // 02h na organização.
  const p = {
    kind: "sandbox", organizationId: "org-local", runId: "preview-local",
    contactId: null, channelId: "channel-local", agent: {},
    context: scenarioContext([]), result: newPreviewResult(),
  } as TurnPreview;
  const ctx: GateContext = {
    now, body: "", optedOut, provider: DEFAULT_CHANNEL_PROVIDER,
    messagingWindow: { lastInboundAt: now },
    pacing: {
      knobs: { ...PACING_DEFAULTS, ...(fixtureWindow ? CONFIG_PREVIEW_CONTROLADO.pacing : {}) },
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null }, crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] }, promise: { table: null },
    semanticPromise: null, disclosure: { template: null, isFirstOutbound: true, mode: "inject" },
    lgpd: null, casesEnabled: false, hasOpenCase: false, openedCaseThisTurn: false,
    internalVocabularyEnforced: true,
  };
  const actualSend = vi.fn();
  const tools = applyPreviewPolicy({
    send_message: tool({ inputSchema: z.object({ body: z.string() }), execute: actualSend }),
  }, p, ctx, () => []);
  await runPiAiSdkCall({
    system: "Sugira uma resposta no preview.", messages: [{ role: "user", content: "Olá" }], tools,
    model: { provider: CONFIG_PREVIEW_CONTROLADO.provider, model: CONFIG_PREVIEW_CONTROLADO.model, apiKey: "local-controlled-provider" },
    maxSteps: 4, runtime: createPreviewAgentRuntime("internal-marker"),
  });
  expect(actualSend).not.toHaveBeenCalled();
  return p.result;
}

describe("Pi controlado com a política real de preview", () => {
  it("produz candidato não vazio à noite somente no canal de teste 24h", async () => {
    const result = await previewAtNight();
    expect(result.candidates[0]?.body).toContain("Posso ajudar");
    expect(result.proposals).toEqual([]);
    expect(result.impediments).toEqual([]);
  });
  it("mantém o veto de horário do produto fora da fixture", async () => {
    const result = await previewAtNight(false, false);
    expect(result.candidates).toEqual([]);
    expect(result.impediments[0]?.code).toBe("outside_window");
  });
  it("mantém opt-out mesmo com o provider controlado e janela 24h", async () => {
    const result = await previewAtNight(true);
    expect(result.candidates).toEqual([]);
    expect(result.impediments[0]?.code).toBe("contato_bloqueado");
  });
});
