import type { RuntimeMessage } from "@/lib/agent-runtime";
import type { KnowledgeEvidence } from "./contracts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse the product-owned envelope; never copy arbitrary tool payloads to the UI. */
export function normalizeKnowledgeEvidence(value: unknown): KnowledgeEvidence[] {
  const items = record(value)?.evidence;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    const evidence = record(item);
    const locator = record(evidence?.locator);
    if (
      !evidence ||
      !locator ||
      typeof evidence.id !== "string" ||
      typeof locator.sourceId !== "string" ||
      typeof locator.provider !== "string" ||
      !["organization_wiki", "organization_memory"].includes(String(evidence.namespace)) ||
      typeof evidence.title !== "string" ||
      typeof evidence.excerpt !== "string"
    )
      return [];
    return [
      {
        id: evidence.id,
        namespace: evidence.namespace as "organization_wiki" | "organization_memory",
        kind:
          evidence.namespace === "organization_memory"
            ? "organization_memory"
            : evidence.kind === "wiki_page"
              ? "wiki_page"
              : "document",
        title: evidence.title,
        excerpt: evidence.excerpt,
        locator: {
          provider: locator.provider,
          sourceId: locator.sourceId,
          ...(typeof locator.revision === "string" ? { revision: locator.revision } : {}),
          ...(typeof locator.uri === "string" ? { uri: locator.uri } : {}),
        },
        ...(typeof evidence.score === "number" && Number.isFinite(evidence.score)
          ? { score: evidence.score }
          : {}),
        ...(record(evidence.metadata) ? { metadata: record(evidence.metadata)! } : {}),
      } satisfies KnowledgeEvidence,
    ];
  });
}

/** URL is constructed from validated IDs, never trusted from model/tool text. */
export function knowledgeEvidenceUri(evidence: KnowledgeEvidence): string | null {
  if (evidence.namespace === "organization_memory") return "/app/ai/memory";
  const { sourceId, revision } = evidence.locator;
  if (evidence.locator.provider === "weknora") {
    return uuid.test(sourceId) && uuid.test(evidence.id) && /^[a-f0-9]{64}$/.test(revision ?? "")
      ? `/api/v1/ai/integrations/wiki/evidence/${evidence.id}`
      : null;
  }
  if (!uuid.test(sourceId) || !uuid.test(evidence.id) || !revision || !uuid.test(revision))
    return null;
  return `/api/v1/ai/knowledge/sources/${sourceId}/trechos?version_id=${revision}&chunk_id=${evidence.id}`;
}

export function observedKnowledgeEvidence(
  messages: readonly RuntimeMessage[],
): KnowledgeEvidence[] {
  const found = new Map<string, KnowledgeEvidence>();
  for (const message of messages) {
    if (
      message.role !== "tool" ||
      message.isError ||
      !["crm_search_knowledge", "crm_get_org_memory"].includes(message.toolName)
    )
      continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    let value: unknown = message.details;
    try {
      if (text.trim()) value = JSON.parse(text);
    } catch {
      /* Structured details remain usable. */
    }
    for (const evidence of normalizeKnowledgeEvidence(value)) {
      const key = `${evidence.namespace}:${evidence.id}:${evidence.locator.revision ?? ""}`;
      found.set(key, evidence);
    }
  }
  return [...found.values()];
}
