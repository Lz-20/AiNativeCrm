import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/ai/embed", () => ({
  embedText: vi.fn(() => {
    throw new Error("live_embedding_forbidden");
  }),
}));
import { buscarConhecimento } from "./busca";
function db(fail = false) {
  const filters: Array<[string, unknown]> = [];
  const builder = {
    select: () => builder,
    eq: (field: string, value: unknown) => {
      filters.push([field, value]);
      return builder;
    },
    in: (field: string, value: unknown) => {
      filters.push([field, value]);
      return builder;
    },
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({
        data: [
          {
            id: "chunk",
            knowledge_source_id: "source",
            kb_version_id: "observed-version",
            position: 2,
            content_hash: "hash",
          },
        ],
        error: fail ? { message: "offline failure" } : null,
      }).then(resolve),
  };
  return {
    filters,
    client: {
      from: vi.fn(() => builder),
      rpc: vi.fn().mockResolvedValue({
        data: [
          {
            chunk_id: "chunk",
            knowledge_source_id: "source",
            source_name: "Wiki",
            content: "Policy",
            similarity: 0.9,
          },
        ],
        error: null,
      }),
    },
  };
}
const input = {
  organizationId: "org",
  knowledgeSourceIds: ["source"],
  pergunta: "policy",
  topK: 5,
  limiar: 0.4,
};
const embed = vi.fn().mockResolvedValue({ embedding: [0.1, 0.2] });
describe("retrieval provenance", () => {
  it("reads index identity from the observed chunk with explicit tenant/source bounds", async () => {
    const { client, filters } = db();
    const result = await buscarConhecimento(client as never, input, { embed });
    expect(result.trechos[0]).toMatchObject({
      index_version_id: "observed-version",
      position: 2,
      content_hash: "hash",
    });
    expect(client.from).toHaveBeenCalledWith("ai_chunks");
    expect(filters).toEqual([
      ["organization_id", "org"],
      ["knowledge_source_id", ["source"]],
      ["id", ["chunk"]],
    ]);
    expect(client.rpc).toHaveBeenCalledWith(
      "fn_buscar_trechos_das_fontes",
      expect.objectContaining({ p_organization_id: "org", p_source_ids: ["source"] }),
    );
  });
  it("fails visibly when provenance read fails instead of inventing a current version", async () => {
    await expect(buscarConhecimento(db(true).client as never, input, { embed })).rejects.toThrow(
      "proveniencia_de_conhecimento_falhou",
    );
  });
  it("never calls an embedding provider for an empty allowed corpus", async () => {
    const unused = vi.fn();
    expect(
      await buscarConhecimento(
        db().client as never,
        { ...input, knowledgeSourceIds: [] },
        { embed: unused },
      ),
    ).toEqual({ trechos: [], melhorSimilaridade: null });
    expect(unused).not.toHaveBeenCalled();
  });
});
