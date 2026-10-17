import { readCompanyWikiEvidence } from "@/lib/ai/integrations/weknora";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseRuntimeMessages } from "./workbench-state";
import { knowledgeEvidenceUri, observedKnowledgeEvidence } from "@/lib/ai/knowledge/evidence";

/** Mirrors the runnable-version selection in the Workbench start route.
 * Built-ins have a draft version and may intentionally have no published pointer. */
export async function currentWorkbenchSourceIds(
  db: SupabaseClient,
  organizationId: string,
  agentId: string,
): Promise<string[]> {
  const { data: agent, error } = await db
    .from("ai_agents")
    .select("origin, published_version_id")
    .eq("organization_id", organizationId)
    .eq("id", agentId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error("observed_evidence_agent_read_failed");
  if (!agent) return [];
  let query = db
    .from("ai_agent_versions")
    .select("knowledge_source_ids")
    .eq("organization_id", organizationId)
    .eq("agent_id", agentId)
    .order("version_number", { ascending: false })
    .limit(1);
  if (agent.origin !== "builtin" && agent.published_version_id)
    query = query.eq("id", agent.published_version_id);
  const { data: version, error: versionError } = await query.maybeSingle();
  if (versionError) throw new Error("observed_evidence_agent_version_read_failed");
  return Array.isArray(version?.knowledge_source_ids) ? version.knowledge_source_ids : [];
}

/** A narrow, re-authorized projection. Never return raw model state/tool bodies. */
export async function loadWorkbenchObservedEvidence(
  db: SupabaseClient,
  input: { organizationId: string; agentId: string; runIds: string[] },
) {
  const { data: states, error } = await db
    .from("ai_agent_run_states")
    .select("run_id, messages")
    .eq("organization_id", input.organizationId)
    .in("run_id", input.runIds);
  if (error) throw new Error("observed_evidence_read_failed");
  const messages = (states ?? []).flatMap((state) => {
    const parsed = parseRuntimeMessages(state.messages);
    if (!parsed) throw new Error("observed_evidence_state_corrupt");
    return parsed;
  });
  const evidence = observedKnowledgeEvidence(messages);
  const wiki = evidence.filter((item) => item.namespace === "organization_wiki");
  const memory = evidence.filter((item) => item.namespace === "organization_memory");
  const allowed = wiki.length
    ? await currentWorkbenchSourceIds(db, input.organizationId, input.agentId)
    : [];
  const [
    { data: sources, error: sourceError },
    { data: pointers, error: pointerError },
    { data: entries, error: entryError },
  ] = await Promise.all([
    allowed.length
      ? db
          .from("ai_knowledge_sources")
          .select("id, active_kb_version_id")
          .eq("organization_id", input.organizationId)
          .eq("is_active", true)
          .eq("status", "ready")
          .in("id", allowed)
      : Promise.resolve({ data: [], error: null }),
    memory.length
      ? db
          .from("org_memory_pointers")
          .select("version_id")
          .eq("organization_id", input.organizationId)
      : Promise.resolve({ data: [], error: null }),
    memory.length
      ? db
          .from("org_memory_entries")
          .select("id")
          .eq("organization_id", input.organizationId)
          .eq("status", "active")
          .in(
            "id",
            memory
              .filter((item) => item.metadata?.memory_kind === "entry")
              .map((item) => item.locator.sourceId),
          )
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (sourceError || pointerError || entryError)
    throw new Error("observed_evidence_authorization_failed");
  const sourceById = new Map((sources ?? []).map((source) => [source.id, source]));
  const documentIds = new Set((pointers ?? []).map((pointer) => pointer.version_id));
  const entryIds = new Set((entries ?? []).map((entry) => entry.id));
  const verifiedWiki = new Map<string, Awaited<ReturnType<typeof readCompanyWikiEvidence>>>();
  const candidates = wiki.filter((item) => item.locator.provider === "weknora" && sourceById.has(item.locator.sourceId)).slice(-10);
  const wikiDeadline = AbortSignal.timeout(8000);
  for (let i = 0; i < candidates.length && !wikiDeadline.aborted; i += 2) {
    await Promise.all(candidates.slice(i, i + 2).map(async (item) => {
      try { verifiedWiki.set(item.id, await readCompanyWikiEvidence(getRequestPool(), input.organizationId, item.id, wikiDeadline)); }
      catch { /* Unverifiable/withdrawn synthesis never reappears from saved history. */ }
    }));
  }
  return evidence.flatMap((item) => {
    const externalWiki = item.locator.provider === "weknora";
    const verified = verifiedWiki.get(item.id);
    if (externalWiki && (!verified || verified.revision !== item.locator.revision)) return [];
    const source = sourceById.get(item.locator.sourceId);
    const readable =
      item.namespace === "organization_wiki"
        ? Boolean(source)
        : item.metadata?.memory_kind === "document"
          ? documentIds.has(item.locator.sourceId)
          : item.metadata?.memory_kind === "entry" && entryIds.has(item.locator.sourceId);
    if (!readable) return [];
    return [
      {
        id: item.id,
        namespace: item.namespace,
        title: item.title.slice(0, 240),
        excerpt: (verified?.content ?? item.excerpt).slice(0, 1800),
        source_id: item.locator.sourceId,
        revision: item.locator.revision ?? null,
        revision_kind: externalWiki
          ? "immutable_observation_manifest"
          : item.namespace === "organization_wiki"
            ? "index_version"
            : "memory_snapshot",
        index_status: externalWiki
          ? "current"
          : source
            ? item.locator.revision
              ? source.active_kb_version_id === item.locator.revision
                ? "current"
                : "superseded"
              : "unknown"
            : null,
        uri: knowledgeEvidenceUri(item),
        ...(typeof item.metadata?.position === "number"
          ? { position: item.metadata.position }
          : {}),
      },
    ];
  });
}
