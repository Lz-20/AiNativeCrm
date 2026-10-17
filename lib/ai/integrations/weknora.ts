import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { enabledIntegration, type IntegrationBinding } from "./config";
import { integrationFetch } from "./http";
import { integrationQuery } from "./db";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const pageSchema = z.object({
  id,
  knowledge_base_id: id,
  slug: z.string().min(1).max(255),
  title: z.string().max(512),
  content: z.string().max(100000),
  version: z.number().int().positive(),
  status: z.literal("published"),
  source_refs: z.array(z.string().max(1000)).min(1).max(20),
  chunk_refs: z.array(z.string().max(200)).max(200).nullable().optional(),
  updated_at: z.string().datetime({ offset: true }),
  deleted_at: z.null().optional(),
});
const documentSchema = z.object({
  id,
  knowledge_base_id: id,
  title: z.string().max(512),
  updated_at: z.string().datetime({ offset: true }),
  file_hash: z.string().max(200).optional(),
  parse_status: z.literal("completed"),
  enable_status: z.string().refine((value) => value === "enabled" || value === "enable"),
  deleted_at: z.null().optional(),
});
type Document = z.infer<typeof documentSchema>;
interface Source {
  id: string;
  source_metadata: { provider: "weknora"; knowledge_base_id: string; visibility: "organization" };
  updated_at: string;
}
const sourceMetadata = z.object({
  provider: z.literal("weknora"),
  knowledge_base_id: id,
  visibility: z.literal("organization"),
});
const manifestSchema = z.object({
  provider: z.literal("weknora"),
  knowledge_base_id: id,
  page_id: id,
  slug: z.string(),
  title: z.string(),
  page_version: z.number().int().positive(),
  page_updated_at: z.string(),
  content_hash: z.string(),
  source_revision: z.string(),
  sources: z.array(documentSchema).min(1).max(20),
  chunk_ids: z.array(z.string()).max(200),
  authority: z.literal("derived_company_knowledge_not_commercial_approval"),
});

async function json(
  binding: IntegrationBinding,
  path: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
) {
  const response = await integrationFetch(
    binding,
    path,
    { method: "GET", signal, headers: { "X-API-Key": binding.api_key! } },
    fetchImpl,
  );
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("weknora_response_too_large");
  return JSON.parse(text) as unknown;
}
async function sourcesFor(pool: Pool, org: string, authorized: string[]) {
  if (!authorized.length) return [];
  const { rows } = await integrationQuery<Source>(
    pool,
    `select id,source_metadata,updated_at from ai_knowledge_sources where organization_id=$1 and id=any($2::uuid[])
     and is_active=true and status='ready' and source_type='wiki' and source_metadata->>'provider'='weknora'`,
    [org, authorized],
  );
  return rows.flatMap((row) => {
    const parsed = sourceMetadata.safeParse(row.source_metadata);
    return parsed.success ? [{ ...row, source_metadata: parsed.data }] : [];
  });
}
function sameSource(left: Source, right: Source | undefined) {
  return (
    right &&
    JSON.stringify(left.source_metadata) === JSON.stringify(right.source_metadata) &&
    String(left.updated_at) === String(right.updated_at)
  );
}
async function document(
  binding: IntegrationBinding,
  kb: string,
  documentId: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<Document> {
  id.parse(documentId);
  const response = z
    .object({ data: documentSchema })
    .parse(
      await json(binding, `/api/v1/knowledge/${encodeURIComponent(documentId)}`, signal, fetchImpl),
    );
  if (response.data.id !== documentId || response.data.knowledge_base_id !== kb)
    throw new Error("wiki_source_scope_mismatch");
  return response.data;
}
function slugPath(slug: string) {
  if (slug.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("wiki_slug_invalid");
  return slug.split("/").map(encodeURIComponent).join("/");
}

/** A published CRM source grants an entire uniform-visibility KB, never a filtered mixed-ACL synthesis. */
export async function searchCompanyWiki(
  pool: Pool,
  org: string,
  authorizedSourceIds: string[],
  query: string,
  limit = 5,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
) {
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  const binding = await enabledIntegration(pool, org, "weknora");
  if (!binding) return { evidence: [], status: "disabled", handledSourceIds: [] as string[] };
  const allowed = await sourcesFor(pool, org, authorizedSourceIds);
  const evidence = [];
  const max = Math.max(1, Math.min(10, limit));
  for (const source of allowed.slice(0, 5)) {
    const kb = source.source_metadata.knowledge_base_id;
    if (!binding.knowledge_base_ids?.includes(kb) || binding.visibility !== "organization")
      continue;
    const response = z
      .object({ pages: z.array(z.unknown()).max(100) })
      .parse(
        await json(
          binding,
          `/api/v1/knowledgebase/${encodeURIComponent(kb)}/wiki/search?q=${encodeURIComponent(query.slice(0, 2000))}&limit=${max}`,
          signal,
          fetchImpl,
        ),
      );
    for (const candidate of response.pages.slice(0, max)) {
      signal?.throwIfAborted();
      const candidateIdentity = z.object({ slug: z.string() }).safeParse(candidate);
      if (!candidateIdentity.success) continue;
      // Search snippets are not evidence; read the actual current published page and its sources.
      try {
        const page = pageSchema.parse(
          await json(
            binding,
            `/api/v1/knowledgebase/${encodeURIComponent(kb)}/wiki/pages/${slugPath(candidateIdentity.data.slug)}`,
            signal,
            fetchImpl,
          ),
        );
        if (page.knowledge_base_id !== kb) throw new Error("wiki_page_scope_mismatch");
        const documentIds = [...new Set(page.source_refs.map((ref) => ref.split("|")[0]!))].sort();
        const docs = await Promise.all(
          documentIds.map((ref) => document(binding, kb, ref, signal, fetchImpl)),
        );
        if (docs.some((doc) => Date.parse(doc.updated_at) > Date.parse(page.updated_at))) continue; // stale derived prose
        const current = await sourcesFor(pool, org, [source.id]);
        if (!sameSource(source, current[0])) continue;
        // A second source read catches withdrawal/version change while the synthesis was fetched.
        const finalDocs = await Promise.all(
          documentIds.map((ref) => document(binding, kb, ref, signal, fetchImpl)),
        );
        if (JSON.stringify(docs) !== JSON.stringify(finalDocs)) continue;
        const manifest = manifestSchema.parse({
          provider: "weknora",
          knowledge_base_id: kb,
          page_id: page.id,
          slug: page.slug,
          title: page.title,
          page_version: page.version,
          page_updated_at: page.updated_at,
          content_hash: hash(page.content),
          source_revision: String(source.updated_at),
          sources: docs,
          chunk_ids: page.chunk_refs ?? [],
          authority: "derived_company_knowledge_not_commercial_approval",
        });
        const manifestHash = hash(JSON.stringify(manifest));
        const { rows } = await integrationQuery<{ id: string }>(
          pool,
          `insert into ai_wiki_evidence(organization_id,source_id,manifest_hash,manifest,content)
           values($1,$2,$3,$4::jsonb,$5) on conflict(organization_id,source_id,manifest_hash) do nothing returning id`,
          [org, source.id, manifestHash, JSON.stringify(manifest), page.content],
        );
        const receipt =
          rows[0] ??
          (
            await integrationQuery<{ id: string }>(
              pool,
              "select id from ai_wiki_evidence where organization_id=$1 and source_id=$2 and manifest_hash=$3",
              [org, source.id, manifestHash],
            )
          ).rows[0];
        if (!receipt) throw new Error("wiki_manifest_unavailable");
        evidence.push({
          id: receipt.id,
          namespace: "organization_wiki",
          kind: "wiki_page",
          title: page.title,
          excerpt: page.content.slice(0, 12000),
          locator: {
            provider: "weknora",
            sourceId: source.id,
            revision: manifestHash,
            uri: `/api/v1/ai/integrations/wiki/evidence/${receipt.id}`,
          },
          metadata: {
            page_version: page.version,
            content_hash: manifest.content_hash,
            source_manifest: docs,
            chunk_ids: manifest.chunk_ids,
            authority: manifest.authority,
            revision_kind: "immutable_observation_manifest",
          },
        });
      } catch {
        signal?.throwIfAborted(); /* Fail closed per synthesized page; no partial ACL filtering. */
      }
      if (evidence.length >= max) break;
    }
    if (evidence.length >= max) break;
  }
  return {
    evidence,
    status: evidence.length ? "complete" : "empty",
    handledSourceIds: allowed.map((source) => source.id),
  };
}

export async function readCompanyWikiEvidence(
  pool: Pool,
  org: string,
  evidenceId: string,
  signal: AbortSignal = AbortSignal.timeout(8000),
) {
  const binding = await enabledIntegration(pool, org, "weknora");
  if (!binding) return null;
  const { rows } = await integrationQuery<{
    source_id: string;
    manifest: unknown;
    content: string;
  }>(
    pool,
    "select source_id,manifest,content from ai_wiki_evidence where organization_id=$1 and id=$2",
    [org, evidenceId],
  );
  const row = rows[0];
  if (!row) return null;
  const manifest = manifestSchema.parse(row.manifest);
  const current = (await sourcesFor(pool, org, [row.source_id]))[0];
  if (
    !current ||
    !binding.knowledge_base_ids?.includes(manifest.knowledge_base_id) ||
    current.source_metadata.knowledge_base_id !== manifest.knowledge_base_id ||
    String(current.updated_at) !== manifest.source_revision
  )
    return null;
  const currentPage = pageSchema.parse(
    await json(
      binding,
      `/api/v1/knowledgebase/${encodeURIComponent(manifest.knowledge_base_id)}/wiki/pages/${slugPath(manifest.slug)}`,
      signal,
    ),
  );
  if (
    currentPage.id !== manifest.page_id ||
    currentPage.knowledge_base_id !== manifest.knowledge_base_id ||
    currentPage.version !== manifest.page_version ||
    hash(currentPage.content) !== manifest.content_hash
  )
    return null;
  const liveDocumentIds = [...new Set(currentPage.source_refs.map((ref) => ref.split("|")[0]!))].sort();
  if (JSON.stringify(liveDocumentIds) !== JSON.stringify(manifest.sources.map((source) => source.id).sort()) ||
      JSON.stringify([...(currentPage.chunk_refs ?? [])].sort()) !== JSON.stringify([...manifest.chunk_ids].sort())) return null;
  const currentDocs = await Promise.all(
    manifest.sources.map((source) =>
      document(binding, manifest.knowledge_base_id, source.id, signal),
    ),
  );
  if (JSON.stringify(currentDocs) !== JSON.stringify(manifest.sources)) return null;
  if (!sameSource(current, (await sourcesFor(pool, org, [row.source_id]))[0])) return null;
  return {
    id: evidenceId,
    revision: hash(JSON.stringify(manifest)),
    manifest,
    content: row.content,
  };
}
