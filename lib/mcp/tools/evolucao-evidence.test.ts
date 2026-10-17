import { describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ search: vi.fn(), sources: vi.fn() }));
vi.mock("@/lib/ai/knowledge/busca", () => ({ buscarConhecimento: mocked.search, resolverAcervoDoAgente: mocked.sources }));
import { crmSearchKnowledge } from "./evolucao";
import { normalizeKnowledgeEvidence } from "@/lib/ai/knowledge/evidence";
describe("MCP to specialist Wiki provenance", () => {
  it("keeps the exact observed source/index/chunk through the real tool adapter and normalizer", async () => {
    const source = "11111111-1111-4111-8111-111111111111";
    const version = "22222222-2222-4222-8222-222222222222";
    const chunk = "33333333-3333-4333-8333-333333333333";
    mocked.search.mockResolvedValue({ melhorSimilaridade: 0.9, trechos: [{ chunk_id: chunk, knowledge_source_id: source,
      source_name: "Pricing Wiki", content: "Approved price excludes freight", similarity: 0.9,
      index_version_id: version, position: 3, content_hash: "sha", metadata: { source_type: "wiki" } }] });
    const result = await crmSearchKnowledge.handler({ pergunta: "price", quantidade: 5 }, {
      actor: { type: "ai_agent", id: "agent" }, organizationId: "org", knowledgeSourceIds: [source], supabase: {},
    } as never);
    expect(mocked.search).toHaveBeenCalledWith({}, expect.objectContaining({ organizationId: "org", knowledgeSourceIds: [source] }));
    expect(normalizeKnowledgeEvidence(result)).toEqual([expect.objectContaining({ id: chunk, kind: "wiki_page",
      locator: { provider: "local_pgvector", sourceId: source, revision: version,
        uri: `/api/v1/ai/knowledge/sources/${source}/trechos?version_id=${version}&chunk_id=${chunk}` },
      metadata: { source_type: "wiki", revision_kind: "index_version", position: 3, content_hash: "sha" } })]);
  });
});
