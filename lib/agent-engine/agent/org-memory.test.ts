import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/ai/knowledge/busca', () => ({ buscarConhecimento: vi.fn(), resolverAcervoDoAgente: vi.fn() }));
import { crmGetOrgMemory } from '@/lib/mcp/tools/evolucao';
import {
  composeSystemPrompt, loadOrgMemory, loadOrgMemoryFromSupabase,
  orgMemoryEvidence, orgMemoryProvenance, renderOrgMemory,
} from './org-memory';

const organizationId = 'org1';
const created = '2026-09-01T00:00:00.000Z';
const updated = '2026-10-01T00:00:00.000Z';
const doc = {
  id: 'v1', organization_id: organizationId, version_id: 'v1', version_number: 3,
  content: 'Regras publicadas da org.', created_at: created, published_at: updated,
};
const entry = {
  id: 'e1', organization_id: organizationId, title: 'Horário', body: 'Atendemos 8h-18h.',
  source: 'manual', status: 'active', created_at: created, updated_at: updated,
};

function poolSeq(responses: Array<{ rows: unknown[] }>): pg.Pool {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  return { query } as unknown as pg.Pool;
}

type Result = { data: unknown; error: { message: string } | null; count?: number | null };
function supabaseStub(overrides: Partial<Record<string, Result[]>> = {}) {
  const results: Record<string, Result[]> = {
    org_memory_pointers: [{ data: { version_id: doc.id, updated_at: updated }, error: null }],
    org_memory_versions: [{ data: doc, error: null }],
    org_memory_entries: [{ data: [entry], error: null }],
    ...overrides,
  };
  const entriesCount = results.org_memory_entries!.reduce((total, result) => total + (Array.isArray(result.data) ? result.data.length : 0), 0);
  const calls: Array<{ table: string; filters: unknown[][]; order: unknown[][]; range?: number[] }> = [];
  const db = {
    from(table: string) {
      const call = { table, filters: [] as unknown[][], order: [] as unknown[][], range: undefined as number[] | undefined };
      calls.push(call);
      const resolve = async () => {
        const result = results[table]?.shift();
        if (!result) throw new Error(`unexpected_query:${table}`);
        return table === 'org_memory_entries' ? { count: entriesCount, ...result } : result;
      };
      const builder = {
        select: () => builder,
        eq: (...filter: unknown[]) => { call.filters.push(filter); return builder; },
        order: (...order: unknown[]) => { call.order.push(order); return builder; },
        range: (from: number, to: number) => { call.range = [from, to]; return builder; },
        maybeSingle: resolve,
        then: (onFulfilled: (value: Result) => unknown, onRejected: (reason: unknown) => unknown) =>
          resolve().then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

async function pgMemory(document = doc, entries = [entry]) {
  return loadOrgMemory(poolSeq([{ rows: [document] }, { rows: entries }]), organizationId);
}

describe('memória canônica publicada', () => {
  it('pg e MCP resolvem documento, revisão e aprendizados idênticos com timestamps normalizados', async () => {
    const pool = poolSeq([
      { rows: [{ ...doc, created_at: new Date(created), published_at: new Date(updated) }] },
      { rows: [{ ...entry, created_at: new Date(created), updated_at: new Date(updated) }] },
    ]);
    const { db } = supabaseStub();
    const memory = await loadOrgMemory(pool, organizationId);
    expect(memory).toEqual(await loadOrgMemoryFromSupabase(db, organizationId));
    expect(memory).toMatchObject({
      schema_version: 1, organization_id: organizationId, content: doc.content,
      document: { version_id: doc.id, version_number: 3, published_at: updated },
      entries: [{ id: 'e1', source: 'manual', status: 'active' }],
    });
    expect(memory.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(renderOrgMemory(memory)).toContain(doc.content);
    expect(renderOrgMemory(memory)).toContain(memory.revision);
  });

  it('filtra todas as queries pela organização e a versão exclusivamente pelo ponteiro publicado', async () => {
    const pool = poolSeq([{ rows: [doc] }, { rows: [entry] }]);
    await loadOrgMemory(pool, organizationId);
    expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining('v.organization_id = p.organization_id'), [organizationId]);
    expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining('where p.organization_id = $1'), [organizationId]);
    expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining("where organization_id = $1 and status = 'active'"), [organizationId]);
    const { db, calls } = supabaseStub();
    await loadOrgMemoryFromSupabase(db, organizationId);
    for (const call of calls) expect(call.filters).toContainEqual(['organization_id', organizationId]);
    expect(calls.find((call) => call.table === 'org_memory_versions')?.filters).toContainEqual(['id', 'v1']);
    expect(calls.at(-1)?.filters).toContainEqual(['status', 'active']);
    expect(calls.at(-1)?.order).toEqual([['created_at', { ascending: true }], ['id', { ascending: true }]]);
  });

  it('mantém aprendizados sem documento publicado, sem usar rascunho nem buscar versão mais recente', async () => {
    const { db, calls } = supabaseStub({ org_memory_pointers: [{ data: null, error: null }] });
    const memory = await loadOrgMemoryFromSupabase(db, organizationId);
    expect(memory.document).toBeNull();
    expect(memory.content).toBeNull();
    expect(memory.entries).toHaveLength(1);
    expect(calls.some((call) => call.table === 'org_memory_versions')).toBe(false);
  });

  it('org sem memória retorna contexto vazio nas duas portas', async () => {
    const { db } = supabaseStub({
      org_memory_pointers: [{ data: null, error: null }],
      org_memory_entries: [{ data: [], error: null }],
    });
    const memory = await loadOrgMemory(poolSeq([{ rows: [] }, { rows: [] }]), organizationId);
    expect(memory).toEqual(await loadOrgMemoryFromSupabase(db, organizationId));
    expect(memory).toMatchObject({ content: null, document: null, entries: [] });
    expect(renderOrgMemory(memory)).toBe('');
  });

  it('ordem e revisão são estáveis; publicar, editar ou arquivar aprendizado altera a revisão', async () => {
    const second = { ...entry, id: 'e2' };
    const original = await pgMemory(doc, [second, entry]);
    expect(original.entries.map((item) => item.id)).toEqual(['e1', 'e2']);
    expect(await pgMemory(doc, [entry, second])).toEqual(original);
    expect((await pgMemory({ ...doc, id: 'v2', version_id: 'v2', version_number: 4 })).revision).not.toBe(original.revision);
    expect((await pgMemory(doc, [entry, { ...second, body: 'Novo aprendizado.' }])).revision).not.toBe(original.revision);
    expect((await pgMemory(doc, [entry])).revision).not.toBe(original.revision);
  });

  it('não reutiliza cache entre turnos/publicações', async () => {
    const pool = poolSeq([
      { rows: [doc] }, { rows: [entry] },
      { rows: [{ ...doc, id: 'v2', version_id: 'v2', version_number: 4 }] }, { rows: [entry] },
    ]);
    expect((await loadOrgMemory(pool, organizationId)).document?.version_id).toBe('v1');
    expect((await loadOrgMemory(pool, organizationId)).document?.version_id).toBe('v2');
  });

  it('pagina aprendizados para não truncar políticas no limite do PostgREST', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ ...entry, id: `entry-${index}` }));
    const { db, calls } = supabaseStub({ org_memory_entries: [
      { data: firstPage, error: null }, { data: [{ ...entry, id: 'last' }], error: null },
    ] });
    const memory = await loadOrgMemoryFromSupabase(db, organizationId);
    expect(memory.entries).toHaveLength(501);
    expect(calls.filter((call) => call.table === 'org_memory_entries').map((call) => call.range)).toEqual([[0, 499], [500, 999]]);
    expect(memory).toEqual(await pgMemory(doc, [...firstPage, { ...entry, id: 'last' }]));
  });

  it('continua a paginação quando o servidor limita a resposta abaixo de 500 linhas', async () => {
    const { db, calls } = supabaseStub({ org_memory_entries: [
      { data: [entry], error: null }, { data: [{ ...entry, id: 'e2' }], error: null },
    ] });
    expect((await loadOrgMemoryFromSupabase(db, organizationId)).entries).toHaveLength(2);
    expect(calls.filter((call) => call.table === 'org_memory_entries').map((call) => call.range)).toEqual([[0, 499], [1, 500]]);
  });

  it('sem contagem confiável não promete memória completa', async () => {
    const { db } = supabaseStub({ org_memory_entries: [{ data: [entry], error: null, count: null }] });
    await expect(loadOrgMemoryFromSupabase(db, organizationId)).rejects.toThrow('org_memory_entries_count_unavailable');
  });

  it.each(['org_memory_pointers', 'org_memory_versions', 'org_memory_entries'])('falha de %s não vira memória vazia ou parcial', async (table) => {
    const { db } = supabaseStub({ [table]: [{ data: null, error: { message: 'database unavailable' } }] });
    await expect(loadOrgMemoryFromSupabase(db, organizationId)).rejects.toThrow(/org_memory_.*read_failed/);
  });

  it('ponteiro órfão/cross-tenant falha fechado nas duas portas', async () => {
    const { db } = supabaseStub({ org_memory_versions: [{ data: null, error: null }] });
    await expect(loadOrgMemoryFromSupabase(db, organizationId)).rejects.toThrow('org_memory_published_document_invalid');
    await expect(pgMemory({ ...doc, organization_id: 'other-org' })).rejects.toThrow('org_memory_published_document_invalid');
    const pool = poolSeq([{ rows: [{ ...doc, id: null, organization_id: null }] }, { rows: [] }]);
    await expect(loadOrgMemory(pool, organizationId)).rejects.toThrow('org_memory_published_document_invalid');
  });

  it.each([{ organization_id: 'other-org' }, { status: 'archived' }, { status: 'proposed' }])('rejeita aprendizado fora do escopo: %j', async (override) => {
    await expect(pgMemory(doc, [{ ...entry, ...override }])).rejects.toThrow('org_memory_entry_scope_invalid');
  });

  it('erro pg e ausência de organização não são tratados como ausência de políticas', async () => {
    const query = vi.fn().mockRejectedValue(new Error('database unavailable'));
    await expect(loadOrgMemory({ query } as unknown as pg.Pool, organizationId)).rejects.toThrow('database unavailable');
    const { db } = supabaseStub();
    await expect(loadOrgMemoryFromSupabase(db, '')).rejects.toThrow('org_memory_organization_missing');
  });

  it('emite proveniência sem corpos e evidências com IDs persistidos de documento/entrada', async () => {
    const memory = await pgMemory();
    expect(orgMemoryProvenance(memory)).toEqual({ orgMemoryRevision: memory.revision, orgMemoryVersionId: 'v1', orgMemoryVersionNumber: 3, orgMemoryEntriesCount: 1 });
    expect(JSON.stringify(orgMemoryProvenance(memory))).not.toContain(doc.content);
    expect(orgMemoryEvidence(memory)).toMatchObject([
      { id: 'v1', excerpt: doc.content, metadata: { memory_kind: 'document' }, locator: { sourceId: 'v1', revision: memory.revision } },
      { id: 'e1', excerpt: entry.body, metadata: { memory_kind: 'entry' }, locator: { sourceId: 'e1', revision: memory.revision } },
    ]);
  });

  it('crm_get_org_memory preserva anotacoes limitadas, sem cortar documento/políticas canônicas', async () => {
    const older = { ...entry, id: 'e2', updated_at: created };
    const { db } = supabaseStub({ org_memory_entries: [{ data: [older, entry], error: null }] });
    const result = await crmGetOrgMemory.handler({ limite: 1 }, { organizationId, supabase: db } as never);
    const memory = await pgMemory(doc, [entry, older]);
    expect(result).toEqual({
      anotacoes: [memory.entries[0]], memory, evidence: orgMemoryEvidence(memory),
      retrieval: { status: 'complete', namespace: 'organization_memory', missing: [] },
    });
  });
});

describe('renderOrgMemory compatível', () => {
  it('vazio quando não há doc nem entries legados', () => {
    expect(renderOrgMemory({ content: null, entries: [] })).toBe('');
  });
  it('doc + entries legados viram bloco determinístico', () => {
    const out = renderOrgMemory({ content: 'Doc.', entries: [{ id: 'e1', title: 'T', body: 'B' }] });
    expect(out).toContain('=== memória da organização (regras e aprendizados — valem para TODO atendimento) ===');
    expect(out).toContain('Doc.');
    expect(out).toContain('- T: B');
  });
});

describe('composeSystemPrompt', () => {
  it('ordem: playbook → memória → índice de skills; blocos vazios somem sem separadores órfãos', () => {
    expect(composeSystemPrompt({ playbookPrompt: 'P', orgMemoryBlock: '', skillIndex: '' })).toBe('P');
    const full = composeSystemPrompt({ playbookPrompt: 'P', orgMemoryBlock: 'M', skillIndex: 'S' });
    expect(full.indexOf('P')).toBeLessThan(full.indexOf('M'));
    expect(full.indexOf('M')).toBeLessThan(full.indexOf('S'));
    expect(full).toContain('=== skills (índice — o corpo carrega no turno quando a situação dispara) ===');
  });
});
