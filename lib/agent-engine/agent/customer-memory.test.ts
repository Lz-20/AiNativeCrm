import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const messages = vi.hoisted(() =>
  vi.fn(async () => ({ messages: [], cursor: null, has_more: false })),
);
vi.mock("@/app/api/v1/messages/_handler", () => ({ listMessagesHandler: messages }));
vi.mock("@/app/api/v1/conversations/_handler", () => ({
  listConversationsHandler: vi.fn(),
  getConversationHandler: vi.fn(),
}));
vi.mock("@/lib/routing/queue", () => ({ getQueuePositions: vi.fn() }));
vi.mock("@/lib/mcp/tools/_users", () => ({ resolveUserNames: vi.fn() }));
import { crmGetConversationHistory } from "@/lib/mcp/tools/conversations";
import { loadCustomerMemoryForConversation } from "./customer-memory";

const boundary = {
  organization_id: "org1",
  contact_id: "contact1",
  conversation_id: "conversation1",
  service_revision: 3,
  demanda_id: "demand1",
  demanda_revision: 2,
  status: "open",
  demanda_fechada_em: null,
};
const checkpoint = {
  ...boundary,
  id: "checkpoint1",
  seq: 20,
  created_at: "2026-10-01T00:00:00Z",
  commitments: ["Retornar amanhã"],
  objections: ["Prazo"],
  next_action: "Conferir estoque",
  rolling_summary: "Cliente aguarda retorno.",
};
const eligibleContact = {
  id: "contact1",
  organization_id: "org1",
  is_anonymized: false,
  is_merged_into: null,
};
function dbStub(
  options: {
    rows?: Record<string, unknown>[];
    boundaries?: Array<Record<string, unknown> | null>;
    queryError?: boolean;
    rpcError?: boolean;
    ignoreFilters?: boolean;
    contacts?: Array<Record<string, unknown> | null>;
    contactErrorAt?: number;
  } = {},
) {
  const boundaries = options.boundaries ?? [boundary, boundary];
  const filters: Array<[string, unknown]> = [];
  const contacts = options.contacts ?? [eligibleContact, eligibleContact];
  const contactCalls: Array<Array<[string, unknown]>> = [];
  const rpc = vi.fn(async () => ({
    data: boundaries.shift() ?? null,
    error: options.rpcError ? new Error("boundary_error") : null,
  }));
  const from = vi.fn((table: string) => {
    const currentFilters: Array<[string, unknown]> = table === "contacts" ? [] : filters;
    if (table === "contacts") contactCalls.push(currentFilters);
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => {
        currentFilters.push([key, value]);
        return builder;
      },
      is: (key: string, value: unknown) => {
        currentFilters.push([key, value]);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () =>
        table === "contacts"
          ? {
              data: contacts.shift() ?? null,
              error:
                options.contactErrorAt === contactCalls.length ? new Error("contact_error") : null,
            }
          : {
              data:
                (options.rows ?? [checkpoint])
                  .filter(
                    (row) =>
                      options.ignoreFilters || filters.every(([key, value]) => row[key] === value),
                  )
                  .sort((left, right) => Number(right.seq) - Number(left.seq))[0] ?? null,
              error: options.queryError ? new Error("query_error") : null,
            },
    };
    return builder;
  });
  return { db: { rpc, from } as unknown as SupabaseClient, rpc, from, filters, contactCalls };
}

describe("memória do cliente somente leitura e escopada", () => {
  it("seleciona somente o checkpoint mais recente da organização, conversa, atendimento e demanda atuais", async () => {
    const wrongScopes = [
      { organization_id: "other-org" },
      { contact_id: "other-contact" },
      { conversation_id: "other-conversation" },
      { service_revision: 2 },
      { demanda_id: "old-demand" },
      { demanda_revision: 1 },
      { conversation_id: null, service_revision: null, demanda_id: null, demanda_revision: null },
    ];
    const { db, filters, rpc, contactCalls } = dbStub({
      rows: [
        ...wrongScopes.map((overrides, i) => ({
          ...checkpoint,
          id: `excluded-${i}`,
          seq: 100 + i,
          ...overrides,
        })),
        { ...checkpoint, id: "older", seq: 19 },
        checkpoint,
      ],
    });
    const result = await loadCustomerMemoryForConversation(db, "org1", "conversation1");
    expect(result).toMatchObject({
      status: "available",
      access: "read_only",
      revision: "20",
      checkpoint: { id: "checkpoint1", commitments: checkpoint.commitments },
    });
    expect(filters).toEqual([
      ["organization_id", "org1"],
      ["contact_id", "contact1"],
      ["conversation_id", "conversation1"],
      ["service_revision", 3],
      ["demanda_id", "demand1"],
      ["demanda_revision", 2],
    ]);
    expect(rpc).toHaveBeenCalledWith("fn_service_boundary", {
      p_org: "org1",
      p_conversation: "conversation1",
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(contactCalls).toEqual([
      [
        ["organization_id", "org1"],
        ["id", "contact1"],
      ],
      [
        ["organization_id", "org1"],
        ["id", "contact1"],
      ],
    ]);
    expect(result.checkpoint).not.toHaveProperty("declaracao");
  });

  it("demanda ausente usa igualdade null, sem misturar demanda anterior", async () => {
    const noDemand = { ...boundary, demanda_id: null, demanda_revision: null };
    const { db, filters } = dbStub({
      boundaries: [noDemand, noDemand],
      rows: [checkpoint, { ...checkpoint, ...noDemand, id: "no-demand" }],
    });
    const result = await loadCustomerMemoryForConversation(db, "org1", "conversation1");
    expect(result.checkpoint?.id).toBe("no-demand");
    expect(filters).toContainEqual(["demanda_id", null]);
    expect(filters).toContainEqual(["demanda_revision", null]);
  });

  it("sem checkpoint na fronteira atual é vazio, sem fallback para memória antiga", async () => {
    const { db } = dbStub({ rows: [{ ...checkpoint, service_revision: 2 }] });
    expect(await loadCustomerMemoryForConversation(db, "org1", "conversation1")).toMatchObject({
      status: "empty",
      revision: null,
      checkpoint: null,
    });
  });

  it("sem fronteira não consulta checkpoints nem alarga para contato", async () => {
    const { db, from } = dbStub({ boundaries: [null] });
    expect(await loadCustomerMemoryForConversation(db, "org1", "conversation1")).toMatchObject({
      status: "unavailable",
      reason: "service_boundary_unavailable",
    });
    expect(from).not.toHaveBeenCalled();
  });

  it.each([{ service_revision: 4 }, { demanda_id: "new-demand" }, { demanda_revision: 3 }])(
    "mudança de fronteira durante leitura recusa checkpoint: %j",
    async (change) => {
      const { db } = dbStub({ boundaries: [boundary, { ...boundary, ...change }] });
      expect(await loadCustomerMemoryForConversation(db, "org1", "conversation1")).toMatchObject({
        status: "unavailable",
        reason: "service_boundary_changed",
        checkpoint: null,
      });
    },
  );

  it("fronteira de outra organização/conversa é recusada antes da leitura", async () => {
    const { db, from } = dbStub({ boundaries: [{ ...boundary, organization_id: "other-org" }] });
    await expect(loadCustomerMemoryForConversation(db, "org1", "conversation1")).rejects.toThrow(
      "service_scope_mismatch",
    );
    expect(from).not.toHaveBeenCalled();
  });

  it("linha incorreta do banco e falhas de consulta falham fechado", async () => {
    const invalid = dbStub({
      rows: [{ ...checkpoint, conversation_id: "other-conversation" }],
      ignoreFilters: true,
    });
    await expect(
      loadCustomerMemoryForConversation(invalid.db, "org1", "conversation1"),
    ).rejects.toThrow("customer_memory_checkpoint_invalid");
    const query = dbStub({ queryError: true });
    await expect(
      loadCustomerMemoryForConversation(query.db, "org1", "conversation1"),
    ).rejects.toThrow("customer_memory_read_failed");
    const rpc = dbStub({ rpcError: true });
    await expect(
      loadCustomerMemoryForConversation(rpc.db, "org1", "conversation1"),
    ).rejects.toThrow("boundary_error");
  });

  it.each([
    ["ausente", null],
    ["anonimizado", { ...eligibleContact, is_anonymized: true }],
    ["fundido", { ...eligibleContact, is_merged_into: "surviving-contact" }],
    ["outra organização", { ...eligibleContact, organization_id: "other-org" }],
    ["outro contato", { ...eligibleContact, id: "other-contact" }],
    ["elegibilidade incompleta", { id: "contact1", organization_id: "org1" }],
  ])("não consulta checkpoint de contato inicialmente inelegível: %s", async (_label, contact) => {
    const { db, from } = dbStub({ contacts: [contact as Record<string, unknown> | null] });
    const result = await loadCustomerMemoryForConversation(db, "org1", "conversation1");
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "contact_memory_unavailable",
      checkpoint: null,
      revision: null,
    });
    expect(from).not.toHaveBeenCalledWith("lead_checkpoints");
    expect(JSON.stringify(result)).not.toContain(checkpoint.rolling_summary);
  });

  it.each([
    ["apagado", null],
    ["anonimizado", { ...eligibleContact, is_anonymized: true }],
    ["fundido", { ...eligibleContact, is_merged_into: "surviving-contact" }],
  ])(
    "descarta checkpoint quando contato fica inelegível durante a leitura: %s",
    async (_label, contact) => {
      const { db, from, contactCalls } = dbStub({
        contacts: [eligibleContact, contact as Record<string, unknown> | null],
      });
      const result = await loadCustomerMemoryForConversation(db, "org1", "conversation1");
      expect(result).toMatchObject({
        status: "unavailable",
        reason: "contact_memory_unavailable",
        checkpoint: null,
        revision: null,
      });
      expect(from).toHaveBeenCalledWith("lead_checkpoints");
      expect(contactCalls).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain(checkpoint.rolling_summary);
    },
  );

  it.each([1, 2])(
    "falha na consulta de elegibilidade %i não libera conteúdo residual",
    async (contactErrorAt) => {
      const { db, from } = dbStub({ contactErrorAt });
      await expect(loadCustomerMemoryForConversation(db, "org1", "conversation1")).rejects.toThrow(
        "customer_memory_contact_read_failed",
      );
      if (contactErrorAt === 1) expect(from).not.toHaveBeenCalledWith("lead_checkpoints");
    },
  );

  it("a ferramenta existente mantém paginação/histórico e adiciona memória somente leitura", async () => {
    const { db } = dbStub();
    const result = await crmGetConversationHistory.handler(
      { conversation_id: "conversation1", limit: 20 },
      {
        organizationId: "org1",
        supabase: db,
        actor: { type: "ai_agent", id: "agent1" },
        requestId: "request1",
      } as never,
    );
    expect(result).toMatchObject({
      messages: [],
      cursor: null,
      has_more: false,
      customer_memory: {
        access: "read_only",
        status: "available",
        revision: "20",
        checkpoint: { id: "checkpoint1" },
      },
    });
    expect(messages).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ organization_id: "org1" }),
      "conversation1",
      { limit: 20, cursor: undefined },
    );
  });
});
