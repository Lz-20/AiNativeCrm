/**
 * Memória da organização: documento publicado + aprendizados ativos.
 *
 * Os adaptadores pg (inbound/Workbench) e Supabase (MCP) resolvem a mesma
 * representação, sem cache. A revisão identifica o conteúdo observado, não
 * promete um snapshot transacional entre documento e aprendizados mutáveis.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type pg from 'pg';
import type { KnowledgeEvidence } from '@/lib/ai/knowledge/contracts';

export interface OrgMemoryEntry {
  id: string;
  title: string;
  body: string;
}

/** Contrato mínimo preservado para os consumidores/renderizadores legados. */
export interface LoadedOrgMemory {
  content: string | null;
  entries: OrgMemoryEntry[];
}

export interface ResolvedOrgMemoryEntry extends OrgMemoryEntry {
  source: string;
  status: 'active';
  created_at: string;
  updated_at: string;
}

export interface ResolvedOrgMemory extends LoadedOrgMemory {
  schema_version: 1;
  organization_id: string;
  revision: string;
  document: {
    version_id: string;
    version_number: number;
    content: string;
    created_at: string;
    published_at: string;
  } | null;
  entries: ResolvedOrgMemoryEntry[];
}

type Timestamp = string | Date;
interface DocumentRow {
  id: string;
  organization_id: string;
  version_id: string;
  version_number: number;
  content: string;
  created_at: Timestamp;
  published_at: Timestamp;
}
interface EntryRow extends OrgMemoryEntry {
  organization_id: string;
  source: string;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

function timestamp(value: Timestamp): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('org_memory_timestamp_invalid');
  return date.toISOString();
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Um único contrato de publicação, ordenação e revisão para as duas portas. */
function resolveOrgMemory(
  organizationId: string,
  row: DocumentRow | null,
  rows: EntryRow[],
): ResolvedOrgMemory {
  if (row && (row.organization_id !== organizationId || !row.id || row.id !== row.version_id ||
    !Number.isInteger(row.version_number) || typeof row.content !== 'string')) {
    throw new Error('org_memory_published_document_invalid');
  }
  const document = row ? {
    version_id: row.id,
    version_number: row.version_number,
    content: row.content,
    created_at: timestamp(row.created_at),
    published_at: timestamp(row.published_at),
  } : null;
  const entries = rows.map((entry): ResolvedOrgMemoryEntry => {
    if (entry.organization_id !== organizationId || entry.status !== 'active')
      throw new Error('org_memory_entry_scope_invalid');
    return {
      id: entry.id, title: entry.title, body: entry.body,
      source: entry.source, status: 'active',
      created_at: timestamp(entry.created_at), updated_at: timestamp(entry.updated_at),
    };
  }).sort((left, right) => compare(left.created_at, right.created_at) || compare(left.id, right.id));
  const canonical = { schema_version: 1 as const, organization_id: organizationId, document, entries };
  return {
    ...canonical,
    revision: `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`,
    // Alias legado; document.content é a fonte única do documento publicado.
    content: document?.content ?? null,
  };
}

export async function loadOrgMemory(db: pg.Pool, tenantId: string): Promise<ResolvedOrgMemory> {
  if (!tenantId) throw new Error('org_memory_organization_missing');
  const { rows: docRows } = await db.query<DocumentRow>(
    `select p.version_id, p.updated_at as published_at,
            v.id, v.organization_id, v.version_number, v.content, v.created_at
     from org_memory_pointers p
     left join org_memory_versions v on v.id = p.version_id and v.organization_id = p.organization_id
     where p.organization_id = $1`,
    [tenantId],
  );
  const { rows: entryRows } = await db.query<EntryRow>(
    `select id, organization_id, title, body, source, status, created_at, updated_at
     from org_memory_entries
     where organization_id = $1 and status = 'active'
     order by created_at asc, id asc`,
    [tenantId],
  );
  // LEFT JOIN mantém ponteiro inválido visível: nunca degrada para "sem regras".
  return resolveOrgMemory(tenantId, docRows[0] ?? null, entryRows);
}

/** O limite legado da tool não pode truncar políticas do contexto canônico. */
export async function loadOrgMemoryFromSupabase(
  db: SupabaseClient,
  organizationId: string,
): Promise<ResolvedOrgMemory> {
  if (!organizationId) throw new Error('org_memory_organization_missing');
  const pointerResult = await db.from('org_memory_pointers')
    .select('version_id, updated_at')
    .eq('organization_id', organizationId).maybeSingle();
  if (pointerResult.error) throw new Error('org_memory_pointer_read_failed', { cause: pointerResult.error });
  let document: DocumentRow | null = null;
  if (pointerResult.data) {
    const versionResult = await db.from('org_memory_versions')
      .select('id, organization_id, version_number, content, created_at')
      .eq('organization_id', organizationId)
      .eq('id', pointerResult.data.version_id).maybeSingle();
    if (versionResult.error) throw new Error('org_memory_document_read_failed', { cause: versionResult.error });
    if (!versionResult.data) throw new Error('org_memory_published_document_invalid');
    document = {
      ...versionResult.data,
      version_id: pointerResult.data.version_id,
      published_at: pointerResult.data.updated_at,
    } as DocumentRow;
  }
  const entries: EntryRow[] = [];
  const pageSize = 500;
  // PostgREST tem teto por resposta; paginação evita memória silenciosamente parcial.
  for (let offset = 0; ;) {
    const result = await db.from('org_memory_entries')
      .select('id, organization_id, title, body, source, status, created_at, updated_at', { count: 'exact' })
      .eq('organization_id', organizationId).eq('status', 'active')
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (result.error) throw new Error('org_memory_entries_read_failed', { cause: result.error });
    const page = (result.data ?? []) as EntryRow[];
    if (result.count === null || !Number.isSafeInteger(result.count) || result.count < 0)
      throw new Error('org_memory_entries_count_unavailable');
    entries.push(...page);
    offset += page.length;
    if (offset >= result.count) break;
    if (page.length === 0) throw new Error('org_memory_entries_incomplete');
  }
  return resolveOrgMemory(organizationId, document, entries);
}

/** Proveniência sem corpos de políticas/aprendizados para os eventos do runtime. */
export function orgMemoryProvenance(memory: ResolvedOrgMemory) {
  return {
    orgMemoryRevision: memory.revision,
    orgMemoryVersionId: memory.document?.version_id ?? null,
    orgMemoryVersionNumber: memory.document?.version_number ?? null,
    orgMemoryEntriesCount: memory.entries.length,
  };
}

/** Evidências apontam para a versão/entrada real; nunca para um ID sintético. */
export function orgMemoryEvidence(memory: ResolvedOrgMemory): KnowledgeEvidence[] {
  const locator = (sourceId: string) => ({
    provider: 'organization_memory', sourceId, revision: memory.revision, uri: '/app/ai/memory',
  });
  const evidence: KnowledgeEvidence[] = memory.document ? [{
    id: memory.document.version_id,
    namespace: 'organization_memory', kind: 'organization_memory',
    title: `Memória da organização · versão ${memory.document.version_number}`,
    excerpt: memory.document.content,
    locator: locator(memory.document.version_id),
    metadata: { memory_kind: 'document', version_number: memory.document.version_number },
  }] : [];
  for (const entry of memory.entries) evidence.push({
    id: entry.id, namespace: 'organization_memory', kind: 'organization_memory',
    title: entry.title, excerpt: entry.body, locator: locator(entry.id),
    metadata: { memory_kind: 'entry', source: entry.source, updated_at: entry.updated_at },
  });
  return evidence;
}

/** Bloco do prefixo estável — '' quando a org não tem memória (zero custo). */
export function renderOrgMemory(mem: LoadedOrgMemory): string {
  if (mem.content === null && mem.entries.length === 0) return '';
  const parts: string[] = ['=== memória da organização (regras e aprendizados — valem para TODO atendimento) ==='];
  if ('revision' in mem && typeof mem.revision === 'string') parts.push(`Revisão: ${mem.revision}`);
  if (mem.content !== null) parts.push(mem.content.trim());
  if (mem.entries.length > 0) {
    parts.push('--- aprendizados ---');
    for (const e of mem.entries) parts.push(`- ${e.title}: ${e.body}`);
  }
  return parts.join('\n');
}

/** Ordem canônica do prefixo: playbook → memória da org → índice de skills. */
export function composeSystemPrompt(input: {
  playbookPrompt: string;
  orgMemoryBlock: string;
  skillIndex: string;
}): string {
  const blocks = [input.playbookPrompt];
  if (input.orgMemoryBlock !== '') blocks.push(input.orgMemoryBlock);
  if (input.skillIndex !== '') {
    blocks.push(
      `=== skills (índice — o corpo carrega no turno quando a situação dispara) ===\n${input.skillIndex}`,
    );
  }
  return blocks.join('\n\n');
}
