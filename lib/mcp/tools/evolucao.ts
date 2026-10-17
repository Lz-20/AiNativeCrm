import { searchCompanyWiki } from "@/lib/ai/integrations/weknora";
import { integrationBinding } from "@/lib/ai/integrations/config";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
/**
 * Capacidades do pacote "Aprender e evoluir" — o acervo da empresa e a memoria
 * da organizacao.
 *
 * PROMOCAO DE CAPACIDADE SOMBRA: `search_knowledge` ja existia dentro do turno
 * do agente (`lib/agent-engine/agent/inbound-turn.ts`), funcionando e invisivel
 * — o humano que configura nao a via, nao a desligava e nao auditava seu uso.
 * Aqui ela vira capacidade de primeira classe: entra no catalogo, aparece na
 * tela e passa pela mesma auditoria das demais.
 *
 * A regra de busca NAO e reimplementada: vive em `lib/ai/knowledge/busca.ts` e
 * e a mesma para o agente e para a pessoa.
 */
import { z } from "zod";

import { buscarConhecimento, resolverAcervoDoAgente } from "@/lib/ai/knowledge/busca";
import { loadOrgMemoryFromSupabase, orgMemoryEvidence } from "@/lib/agent-engine/agent/org-memory";
import type { McpToolDefinition } from "../types";

// ---------------------------------------------------------------------------
// buscar no acervo
// ---------------------------------------------------------------------------

const buscarInputShape = {
  pergunta: z.string().trim().min(1).describe("O que se quer saber, em linguagem natural."),
  quantidade: z.number().int().min(1).max(10).optional().default(5),
  /**
   * So e necessario quando quem chama NAO e um agente (ex: cliente MCP externo
   * operado por uma pessoa). Agente nenhum precisa informar: ele e o proprio.
   */
  assistente_id: z.string().uuid().optional(),
};

/**
 * Limiar de similaridade — o MESMO default do banco desde a migration 0097.
 *
 * Era 0.72 aqui, e o produto tinha TRÊS limiares para o mesmo acervo: 0.40 na
 * RPC, 0.72 no turno do agente e 0.72 nesta capacidade. Duas pessoas
 * perguntando a mesma coisa pelo mesmo material recebiam respostas diferentes
 * conforme a porta por onde entraram.
 */
const LIMIAR_PADRAO = 0.4;

export const crmSearchKnowledge: McpToolDefinition<typeof buscarInputShape> = {
  name: "crm_search_knowledge",
  description:
    "Busca semantica no acervo de conhecimento da organizacao (RAG). Devolve os trechos mais " +
    "relevantes com a similaridade de cada um. Quando nada passa do limiar, devolve " +
    "`melhor_similaridade` para distinguir 'nao ha nada sobre isso' de 'ha algo perto, mas fraco'.",
  inputSchema: buscarInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const agentId =
      input.assistente_id ?? (ctx.actor.type === "ai_agent" ? ctx.actor.id : undefined);

    if (!agentId) {
      return {
        erro: "assistente_nao_informado",
        mensagem:
          "Cada assistente consulta o proprio acervo. Informe qual assistente deve responder.",
      };
    }

    const fontes = ctx.knowledgeSourceIds
      ? [...ctx.knowledgeSourceIds]
      : await resolverAcervoDoAgente(ctx.supabase, ctx.organizationId, agentId);
    if (fontes.length === 0) {
      // Nao e erro: e um estado legitimo e acionavel — o assistente ainda nao
      // tem material publicado. Devolver como falha faria o modelo tratar como
      // bug e tentar de novo em vez de dizer que nao sabe.
      return {
        trechos: [],
        evidence: [],
        retrieval: {
          status: "unavailable",
          namespace: "organization_wiki",
          missing: ["published_knowledge_sources"],
        },
        melhor_similaridade: null,
        aviso: "assistente_sem_acervo_publicado",
      };
    }

    const wiki = integrationBinding(ctx.organizationId, "weknora")
      ? await searchCompanyWiki(getRequestPool(), ctx.organizationId, fontes, input.pergunta, input.quantidade)
        .catch(() => ({ evidence: [], status: "unavailable", handledSourceIds: [] as string[] }))
      : { evidence: [], status: "disabled", handledSourceIds: [] as string[] };
    const localSources = fontes.filter((sourceId) => !wiki.handledSourceIds.includes(sourceId));
    const resultado = localSources.length ? await buscarConhecimento(ctx.supabase, {
      organizationId: ctx.organizationId,
      knowledgeSourceIds: localSources,
      pergunta: input.pergunta,
      topK: input.quantidade,
      limiar: LIMIAR_PADRAO,
    }) : { trechos: [], melhorSimilaridade: null };

    return {
      trechos: resultado.trechos,
      evidence: [...wiki.evidence, ...resultado.trechos.map((trecho) => ({
        id: trecho.chunk_id,
        namespace: "organization_wiki",
        kind: trecho.metadata?.source_type === "wiki" ? "wiki_page" : "document",
        title: trecho.source_name ?? "Material da organização",
        excerpt: trecho.content,
        score: trecho.similarity,
        locator: {
          provider: "local_pgvector",
          sourceId: trecho.knowledge_source_id ?? "legacy_knowledge_source",
          ...(trecho.index_version_id ? { revision: trecho.index_version_id } : {}),
          ...(trecho.knowledge_source_id && trecho.index_version_id ? {
            uri: `/api/v1/ai/knowledge/sources/${trecho.knowledge_source_id}/trechos?version_id=${trecho.index_version_id}&chunk_id=${trecho.chunk_id}`,
          } : {}),
        },
        metadata: {
          ...trecho.metadata,
          revision_kind: "index_version",
          ...(trecho.position !== undefined ? { position: trecho.position } : {}),
          ...(trecho.content_hash ? { content_hash: trecho.content_hash } : {}),
        },
      }))],
      retrieval: {
        wiki_status: wiki.status,
        status: resultado.trechos.length > 0 || wiki.evidence.length > 0 ? "complete" : "empty",
        namespace: "organization_wiki",
        missing: [],
      },
      melhor_similaridade: resultado.melhorSimilaridade,
    };
  },
};

// ---------------------------------------------------------------------------
// listar o material do acervo
// ---------------------------------------------------------------------------

const listarMateriaisInputShape = {
  apenas_ativos: z.boolean().optional().default(true),
};

export const crmListKnowledgeSources: McpToolDefinition<typeof listarMateriaisInputShape> = {
  name: "crm_list_knowledge_sources",
  description:
    "Lista os materiais que compoem o acervo de conhecimento da organizacao, com estado de " +
    "indexacao e contagem de trechos. Util para saber se uma resposta faltou por ausencia de " +
    "material ou por falha de indexacao.",
  inputSchema: listarMateriaisInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    let q = ctx.supabase
      .from("ai_knowledge_sources")
      .select(
        "id, agent_id, name, source_type, status, last_index_status, last_index_error, last_indexed_at, chunks_count, is_active, created_at",
      )
      // Service role bypassa RLS: o filtro por organizacao e manual e
      // obrigatorio, e a fonte e o contexto autenticado, nunca a entrada.
      .eq("organization_id", ctx.organizationId)
      .order("created_at", { ascending: false });

    if (input.apenas_ativos) q = q.eq("is_active", true);

    const { data, error } = await q;
    if (error) throw new Error(`listar_materiais_falhou: ${error.message}`);

    return { materiais: data ?? [] };
  },
};

// ---------------------------------------------------------------------------
// propostas de melhoria (flywheel) — LEITURA. A IA não aprova a si mesma.
// ---------------------------------------------------------------------------

const propostasInputShape = {
  limite: z.number().int().min(1).max(20).optional().default(10),
};

export const crmListImprovementProposals: McpToolDefinition<typeof propostasInputShape> = {
  name: "crm_list_improvement_proposals",
  description:
    "Lista as propostas de melhoria que o ciclo de aprendizado gerou, com tipo, alvo e a " +
    "evidência que as motivou. LEITURA apenas: aprovar continua sendo decisão de uma pessoa.",
  inputSchema: propostasInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("flywheel_distiller_proposals")
      .select("id, run_id, dataset, type, target, content, evidence, proposed_at")
      .eq("organization_id", ctx.organizationId)
      .order("proposed_at", { ascending: false })
      .limit(input.limite);

    if (error) throw new Error(`listar_propostas_falhou: ${error.message}`);
    return { propostas: data ?? [] };
  },
};

// ---------------------------------------------------------------------------
// memória da organização
// ---------------------------------------------------------------------------

const lerMemoriaInputShape = {
  limite: z.number().int().min(1).max(50).optional().default(20),
};

export const crmGetOrgMemory: McpToolDefinition<typeof lerMemoriaInputShape> = {
  name: "crm_get_org_memory",
  description:
    "Lê o que a empresa registrou sobre si mesma — políticas, combinados e aprendizados que " +
    "valem para todo atendimento. Inclui documento publicado, revisão e aprendizados ativos. " +
    "Use antes de inventar regra de negócio; limite restringe apenas a lista legada anotacoes.",
  inputSchema: lerMemoriaInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const memory = await loadOrgMemoryFromSupabase(ctx.supabase, ctx.organizationId);
    // Compatibilidade: anotacoes mantém campos/limite/ordem legados. A memória
    // canônica completa é idêntica à injetada no inbound e no Workbench.
    const anotacoes = [...memory.entries]
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))
      .slice(0, input.limite);
    return {
      anotacoes, memory, evidence: orgMemoryEvidence(memory),
      retrieval: {
        status: memory.document || memory.entries.length ? "complete" : "empty",
        namespace: "organization_memory", missing: [],
      },
    };
  },
};

const gravarMemoriaInputShape = {
  titulo: z.string().trim().min(3).max(200),
  corpo: z.string().trim().min(10).max(4000),
};

export const crmSaveOrgMemory: McpToolDefinition<typeof gravarMemoriaInputShape> = {
  name: "crm_save_org_memory",
  description:
    "Registra um aprendizado que vale para toda a operação, não para um cliente só. Nasce com " +
    "origem 'agent' para o humano distinguir o que a IA anotou do que ele mesmo escreveu.",
  inputSchema: gravarMemoriaInputShape,
  category: "write",
  // `ai_operator`: a rota equivalente (`ai/memory/entries` POST) exige `manager`
  // — um atendente humano não escreve política da empresa pela tela, e a IA não
  // pode ter mais poder que uma pessoa do mesmo papel.
  requiresRole: "ai_operator",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("org_memory_entries")
      .insert({
        organization_id: ctx.organizationId,
        title: input.titulo,
        body: input.corpo,
        source: "agent",
        status: "active",
      })
      .select("id, title, status, created_at")
      .single();

    if (error) throw new Error(`gravar_memoria_falhou: ${error.message}`);
    return { anotacao: data };
  },
};
