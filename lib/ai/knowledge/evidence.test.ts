import { describe, expect, it } from "vitest";
import type { RuntimeMessage } from "@/lib/agent-runtime";
import {
  knowledgeEvidenceUri,
  normalizeKnowledgeEvidence,
  observedKnowledgeEvidence,
} from "./evidence";

const source = "11111111-1111-4111-8111-111111111111";
const version = "22222222-2222-4222-8222-222222222222";
const chunk = "33333333-3333-4333-8333-333333333333";
const value = {
  evidence: [
    {
      id: chunk,
      namespace: "organization_wiki",
      kind: "wiki_page",
      title: "Política aprovada",
      excerpt: "Prazo depende de confirmação.",
      score: 0.91,
      locator: {
        provider: "local_pgvector",
        sourceId: source,
        revision: version,
        uri: "javascript:alert(1)",
      },
      metadata: { position: 2, content_hash: "hash" },
    },
  ],
};
const tool = (name = "crm_search_knowledge", isError = false): RuntimeMessage => ({
  role: "tool",
  toolCallId: "call",
  toolName: name,
  content: JSON.stringify(value),
  isError,
});
describe("real observed knowledge envelope", () => {
  it("preserves the nested locator and immutable chunk identity for specialists", () => {
    expect(normalizeKnowledgeEvidence(value)[0]).toEqual(value.evidence[0]);
  });
  it("only accepts successful allowlisted knowledge observations and deduplicates replay", () => {
    expect(
      observedKnowledgeEvidence([
        tool(),
        tool(),
        tool("crm_get_contact"),
        tool("crm_search_knowledge", true),
      ]),
    ).toHaveLength(1);
    expect(
      observedKnowledgeEvidence([{ role: "assistant", content: JSON.stringify(value) }]),
    ).toEqual([]);
  });
  it("builds a safe WeKnora receipt link without trusting arbitrary locators", () => {
    const evidence = normalizeKnowledgeEvidence(value)[0]!;
    const wiki = {
      ...evidence,
      locator: {
        ...evidence.locator,
        provider: "weknora",
        revision: "a".repeat(64),
        uri: "https://evil.invalid",
      },
    };
    expect(knowledgeEvidenceUri(wiki)).toBe(`/api/v1/ai/integrations/wiki/evidence/${chunk}`);
    expect(knowledgeEvidenceUri({ ...wiki, id: "../../secret" })).toBeNull();
  });
  it("rebuilds a precise local URI rather than trusting an injected location", () => {
    const evidence = normalizeKnowledgeEvidence(value)[0]!;
    expect(knowledgeEvidenceUri(evidence)).toBe(
      `/api/v1/ai/knowledge/sources/${source}/trechos?version_id=${version}&chunk_id=${chunk}`,
    );
    expect(knowledgeEvidenceUri({ ...evidence, id: "not-a-uuid" })).toBeNull();
    expect(
      knowledgeEvidenceUri({ ...evidence, locator: { ...evidence.locator, revision: undefined } }),
    ).toBeNull();
  });
});
