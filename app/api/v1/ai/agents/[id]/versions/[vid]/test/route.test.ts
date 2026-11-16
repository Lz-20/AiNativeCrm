/**
 * Runtime real do "Testar agente" (issue #71).
 *
 * O preview usa o mesmo core e as mesmas dependências de um turno normal. Este
 * teste fixa o contrato de falha desse caminho: o run guarda um checkpoint
 * útil e a pessoa recebe orientação legível, sem detalhes internos do provider.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { testAgentVersion } from "@/lib/agent-engine/agent/sandbox";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ModelCallError } from "@/lib/agent-runtime/errors";
import { logger } from "@/lib/logger";
import { readAgentModelBinding } from "@/lib/agent-engine/agent/model-binding-summary";
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/agent-engine/agent/model-binding-summary", () => ({ readAgentModelBinding: vi.fn() }));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/agent-engine/agent/sandbox", () => ({
  testAgentVersion: vi.fn(async () => {
    throw new Error("AI_GATEWAY_API_KEY ausente");
  }),
}));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";

function stubAdmin(atualizacoes: Record<string, unknown>[]) {
  return {
    from: (table: string) => {
      if (table === "ai_agent_versions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: VERSION,
                      agent_id: AGENT,
                      organization_id: ORG,
                      system_prompt: "oi",
                      provider: "anthropic",
                      model: "claude-sonnet-4-6",
                      channel_session_id: null,
                      max_steps: 3,
                      token_budget: 1000,
                      cost_budget_cents: 100,
                      tool_ids: [],
                    },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      // ai_agent_runs
      return {
        insert: () => ({
          select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }),
        }),
        update: (payload: Record<string, unknown>) => {
          atualizacoes.push(payload);
          const chain = {
            eq: () => chain,
            then: (ok: (value: { error: null }) => unknown) =>
              Promise.resolve({ error: null }).then(ok),
          };
          return chain;
        },
      };
    },
  };
}

describe("POST .../versions/:vid/test — core compartilhado", () => {
  const atualizacoes: Record<string, unknown>[] = [];
  const requestPool = { query: vi.fn() };
  const turnDeps = {};

  beforeEach(() => {
    vi.clearAllMocks();
    atualizacoes.length = 0;
    const user: AuthUser = {
      id: USER,
      email: "a@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
    };
    vi.mocked(requireRole).mockImplementation(async (min: Role) =>
      ROLE_RANK["admin"] >= ROLE_RANK[min]
        ? { ok: true, user, org: { orgId: ORG, name: "Org", role: "admin" } }
        : ({ ok: false, response: null } as never),
    );
    vi.mocked(createAdminClient).mockReturnValue(stubAdmin(atualizacoes) as never);
    vi.mocked(getRequestPool).mockReturnValue(requestPool as never);
    vi.mocked(requestTurnDeps).mockReturnValue(turnDeps as never);
  });

  it("reads the effective binding without executing a model", async () => {
    vi.mocked(readAgentModelBinding).mockResolvedValueOnce({ bindingMode: "organization_default", source: "organization_default",
      provider: "anthropic", model: "org-model", credentialStatus: "unavailable" });
    const { GET } = await import("./route");
    const response = await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: AGENT, vid: VERSION }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { provider: "anthropic", model: "org-model", credentialStatus: "unavailable" } });
    expect(testAgentVersion).not.toHaveBeenCalled();
    expect(atualizacoes).toEqual([]);
  });

  it.each(["credential_provider_mismatch", "model_http_401", "checkpoint_invalid", "model_aborted"] as const)(
    "propagates %s and its request ID without a fake tool success", async (code) => {
      vi.mocked(testAgentVersion).mockRejectedValueOnce(new ModelCallError(code, code === "checkpoint_invalid" ? "checkpoint" : "runtime",
        code === "model_http_401" ? 401 : null, code === "model_aborted" ? "aborted" : "error"));
      const { POST } = await import("./route");
      const response = await POST(new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sample_message: "synthetic-only-message" }) }), { params: Promise.resolve({ id: AGENT, vid: VERSION }) });
      const requestId = response.headers.get("X-Request-Id");
      expect(await response.json()).toMatchObject({ error: { code, details: { request_id: requestId } } });
      expect(atualizacoes).toContainEqual(expect.objectContaining({ status: code === "model_aborted" ? "aborted" : "failed", error_code: code }));
      expect(atualizacoes.some((value) => "tool_calls" in value)).toBe(false);
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).toContain(requestId);
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("synthetic-only-message");
    });

  it("does not log or persist arbitrary upstream error text", async () => {
    vi.mocked(testAgentVersion).mockRejectedValueOnce(new Error("RAW-SSE-CUSTOMER-SENTINEL Cookie: private; Authorization: private"));
    const { POST } = await import("./route");
    await POST(new NextRequest("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sample_message: "synthetic" }) }), { params: Promise.resolve({ id: AGENT, vid: VERSION }) });
    expect(JSON.stringify([atualizacoes, vi.mocked(logger.error).mock.calls])).not.toMatch(/RAW-SSE|Cookie:|Authorization:/);
  });

  it("falha do core vira checkpoint e orientação legível", async () => {
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sample_message: "oi" }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: AGENT, vid: VERSION }) });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };

    expect(testAgentVersion).toHaveBeenCalledWith(
      requestPool,
      turnDeps,
      expect.objectContaining({
        organizationId: ORG,
        agentId: AGENT,
        versionId: VERSION,
        runId: "run-1",
        sampleMessage: "oi",
      }),
    );
    expect(res.status).toBe(422);
    expect(body.error).toMatchObject({
      code: "preview_failed",
      message: "Não foi possível executar o teste. Confira modelo, credencial e materiais do agente.",
    });
    expect(body.error?.message).not.toContain("AI_GATEWAY_API_KEY");
    // ⚠️ `failed`, não `"error"`. Este teste cobrava `"error"` — e passava,
    // porque o mock do Supabase não tem o CHECK que o Postgres tem. No banco de
    // verdade o update era rejeitado com 23514 e o erro descartado, então o
    // teste verde e a produção quebrada conviviam. O vocabulário da coluna está
    // agora sob `tests/unit/teste-do-agente-usa-status-que-a-coluna-aceita.test.ts`,
    // que lê o CHECK do `baseline.sql` em vez de confiar num mock.
    expect(atualizacoes).toContainEqual(expect.objectContaining({
      status: "failed",
      error_code: "preview_failed",
    }));
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
