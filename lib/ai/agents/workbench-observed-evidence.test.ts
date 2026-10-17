import { describe, expect, it } from "vitest";
import { loadWorkbenchObservedEvidence } from "./workbench-observed-evidence";
const raw = {
  evidence: [
    {
      id: "chunk",
      namespace: "organization_wiki",
      kind: "wiki_page",
      title: "Wiki",
      excerpt: "Verified policy excerpt",
      locator: { provider: "local_pgvector", sourceId: "source", revision: "old-index" },
      metadata: { position: 0 },
    },
  ],
};
function client(
  options: {
    disabled?: boolean;
    failure?: string;
    malformed?: boolean;
    published?: boolean;
    revoked?: boolean;
  } = {},
) {
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  return {
    reads,
    db: {
      from(table: string) {
        const filters: Array<[string, unknown]> = [];
        reads.push({ table, filters });
        const rows =
          table === "ai_agents"
            ? {
                origin: options.published ? "user" : "builtin",
                published_version_id: options.published ? "published" : null,
              }
            : table === "ai_agent_versions"
              ? { knowledge_source_ids: options.revoked ? [] : ["source"] }
              : table === "ai_agent_run_states"
                ? [
                    {
                      run_id: "run",
                      messages: options.malformed
                        ? {}
                        : [
                            { role: "system", content: "private prompt" },
                            {
                              role: "tool",
                              toolName: "crm_get_contact",
                              toolCallId: "c",
                              content: '{"private":"customer secrets"}',
                            },
                            {
                              role: "tool",
                              toolName: "crm_search_knowledge",
                              toolCallId: "k",
                              content: JSON.stringify(raw),
                            },
                          ],
                    },
                  ]
                : table === "ai_knowledge_sources" && !options.disabled
                  ? [{ id: "source", active_kb_version_id: "new-index" }]
                  : [];
        const response = () => ({
          data: rows,
          error: options.failure === table ? { message: "offline error" } : null,
        });
        const builder = {
          select: () => builder,
          is: () => builder,
          order: () => builder,
          limit: () => builder,
          maybeSingle: () => Promise.resolve(response()),
          eq: (key: string, value: unknown) => {
            filters.push([key, value]);
            return builder;
          },
          in: (key: string, value: unknown) => {
            filters.push([key, value]);
            return builder;
          },
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(response()).then(resolve),
        };
        return builder;
      },
    },
  };
}
const input = { organizationId: "org", agentId: "agent", runIds: ["run", "child"] };
describe("Workbench observed evidence projection", () => {
  it("returns only observed knowledge and marks an older index without rewriting its quote", async () => {
    const { db, reads } = client();
    const result = await loadWorkbenchObservedEvidence(db as never, input);
    expect(result).toEqual([
      expect.objectContaining({
        excerpt: "Verified policy excerpt",
        index_status: "superseded",
        revision: "old-index",
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/customer secrets|private prompt/);
    expect(
      reads.every((read) =>
        read.filters.some(([key, value]) => key === "organization_id" && value === "org"),
      ),
    ).toBe(true);
    expect(reads[0]!.filters).toContainEqual(["run_id", ["run", "child"]]);
    expect(reads.find((read) => read.table === "ai_knowledge_sources")!.filters).toContainEqual([
      "is_active",
      true,
    ]);
    expect(reads.find((read) => read.table === "ai_knowledge_sources")!.filters).toContainEqual([
      "id",
      ["source"],
    ]);
    expect(reads.find((read) => read.table === "ai_agent_versions")!.filters).not.toContainEqual([
      "id",
      null,
    ]);
  });
  it("uses the current custom published source selection and honors revocation", async () => {
    const { db, reads } = client({ published: true, revoked: true });
    expect(await loadWorkbenchObservedEvidence(db as never, input)).toEqual([]);
    expect(reads.find((read) => read.table === "ai_agent_versions")!.filters).toContainEqual([
      "id",
      "published",
    ]);
  });
  it("does not expose archived/revoked source snippets from old run state", async () => {
    expect(
      await loadWorkbenchObservedEvidence(client({ disabled: true }).db as never, input),
    ).toEqual([]);
  });
  it.each(["ai_agent_run_states", "ai_knowledge_sources"])(
    "fails closed on %s read failures",
    async (failure) => {
      await expect(
        loadWorkbenchObservedEvidence(client({ failure }).db as never, input),
      ).rejects.toThrow();
    },
  );
  it("does not treat a corrupt persisted observation as no evidence", async () => {
    await expect(
      loadWorkbenchObservedEvidence(client({ malformed: true }).db as never, input),
    ).rejects.toThrow("state_corrupt");
  });
});
