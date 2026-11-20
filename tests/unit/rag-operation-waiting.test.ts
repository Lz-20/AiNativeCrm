import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingConfigurationError } from "@/lib/ai/embeddings/profile";
const m = vi.hoisted(() => ({ key: vi.fn(), embed: vi.fn() }));
vi.mock("@/lib/ai/embeddings/chave", () => ({ resolverChaveDeEmbedding: m.key }));
vi.mock("@/lib/ai/embed", () => ({
  embedText: m.embed,
  SemChaveDeEmbeddingError: class extends Error {},
}));
vi.mock("@/lib/ai/rag/ingest/documento", () => ({
  extrairTextoDoArquivo: vi.fn(),
  ErroDeExtracao: class extends Error {},
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        update: () => q,
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        maybeSingle: async () => ({
          data: {
            id: "source",
            organization_id: "org",
            is_active: true,
            status: "ready",
            source_type: "documento",
          },
          error: null,
        }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/event-log/dispatcher", () => ({
  getRegisteredHandlers: () => [{ key: "rag-indexer.v1", events: ["knowledge_source.updated"] }],
  dispatchEvent: async (row: Parameters<typeof processRagIndexer>[0]) => [
    await processRagIndexer(row),
  ],
}));
import { processRagIndexer } from "@/workers/rag-indexer";
import { drainEventLog } from "@/lib/event-log/drain";
beforeEach(() => vi.clearAllMocks());
describe("Worker/Cron shared drain preserves waiting events and prior failure history", () => {
  it.each([
    "embedding_disabled",
    "embedding_credential_unavailable",
    "embedding_authorization_required",
    "embedding_lease_busy",
    "embedding_budget_exhausted",
    "embedding_operation_blocked",
  ])("%s keeps pending without spending an attempt", async (code) => {
    m.key.mockRejectedValue(new EmbeddingConfigurationError(code));
    const writes: Record<string, unknown>[] = [];
    const row = {
      id: "event",
      organization_id: "org",
      event_type: "knowledge_source.updated",
      payload: { knowledge_source_id: "source" },
      consumed_by: [],
      attempts: 4,
      created_at: new Date().toISOString(),
    };
    const admin = {
      from: () => {
        let status = "";
        let writing = false;
        const q = {
          select: () => q,
          eq: (key: string, value: string) => {
            if (key === "status") status = value;
            return q;
          },
          in: () => q,
          or: () => q,
          lt: () => q,
          order: () => q,
          limit: () => q,
          update: (value: Record<string, unknown>) => {
            writing = true;
            writes.push(value);
            return q;
          },
          then: (resolve: (v: unknown) => void) =>
            resolve({
              data: writing ? [{ id: row.id }] : status === "processing" ? [] : [row],
              error: null,
            }),
        };
        return q;
      },
    };
    const result = await drainEventLog(admin as never);
    expect(result).toMatchObject({ retried: 1, done: 0, failed: 0, dead: 0 });
    const final = writes.at(-1)!;
    expect(final).toMatchObject({
      status: "pending",
      consumed_by: [],
      last_error: "rag-indexer.v1: " + code,
    });
    expect(final).not.toHaveProperty("attempts");
    expect(Date.parse(final.next_attempt_at as string)).toBeGreaterThan(Date.now());
    expect(m.embed).not.toHaveBeenCalled();
  });
  it("true upstream failures still consume a failure attempt, not a waiting classification", async () => {
    m.key.mockRejectedValue(new EmbeddingConfigurationError("embedding_upstream_rejected", 500));
    const result = await processRagIndexer({
      id: "event",
      organization_id: "org",
      event_type: "knowledge_source.updated",
      payload: { knowledge_source_id: "source" },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      entity_kind: "ai_knowledge_source",
      entity_id: "source",
    });
    expect(result.status).toBe("error");
    expect(m.embed).not.toHaveBeenCalled();
  });
});
