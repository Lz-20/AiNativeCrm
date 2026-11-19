/**
 * Embedding de query para o RAG por tenant (F3-08; edge-contract §3 "RAG por tenant").
 *
 * PIN DE CONTRATO (inegociável): o vetor é computado com o MESMO modelo do indexador
 * do CRM — `text-embedding-3-small`, 1536 dimensões. Divergir de modelo/dimensão
 * quebra o recall SILENCIOSAMENTE (os vetores deixam de ser comparáveis), por isso a
 * dimensão é asserida a cada chamada. O modelo é knob (RAG_EMBEDDING_MODEL) só para
 * acompanhar uma futura troca do indexador do CRM — o default É o contrato.
 *
 * Por que aqui e não em run-model-call: embedding não é generateText (sem output
 * tokens, sem BYOK por org, sem enabled_models — é um modelo FIXO do contrato, com
 * chave server-side única na v1). Vive em edge/llm/ (CLAUDE.md regra dura 5 — SDK/
 * chamada de modelo só nesta camada) como um chamador HTTP mínimo, MESMO padrão do
 * count-tokens.ts: fetch nativo (egress em edge/, regra 5), sem SDK novo. A chave só
 * entra no header — nunca em log, erro ou contexto do modelo (regra dura 7).
 */

import { requestEmbedding } from './embedding-provider';
import { embeddingProfile } from '@/lib/ai/embeddings/profile';
import type { EmbeddingAccess } from '@/lib/ai/embeddings/operation-store';
import type { Logger } from '../../obs/logger';

/** Dimensão do text-embedding-3-small — pin de contrato do CRM (edge-contract §3). */
export const RAG_EMBEDDING_DIMENSIONS = 1536;

export interface EmbedConfig {
  /** Old callers without tenant/source authorization fail closed. */
  access?: EmbeddingAccess;
  apiKey: string;
  /** id do modelo de embedding — default text-embedding-3-small (pin de contrato). */
  model: string;
  /** default: API pública da OpenAI; override para gateway compatível. */
  baseUrl?: string;
  timeoutMs: number;
  /** logger do evento de segurança de egress bloqueado (F4-03; opcional). */
  log?: Logger;
}

/**
 * Monta a config a partir do env validado (padrão crmEdgeConfigFromEnv). A chave é
 * opcional no boot — o daemon sobe sem RAG configurado; quem for embedar exige aqui,
 * com instrução.
 */
export function embedConfigFromEnv(env: {
  RAG_EMBEDDING_API_KEY?: string;
  RAG_EMBEDDING_MODEL: string;
  RAG_EMBEDDING_TIMEOUT_MS: number;
}): EmbedConfig {
  if (!env.RAG_EMBEDDING_API_KEY) {
    throw new Error(
      'RAG não configurado — defina RAG_EMBEDDING_API_KEY no .env (chave OpenAI do embedding, edge-contract §3/§4)',
    );
  }
  return {
    apiKey: env.RAG_EMBEDDING_API_KEY,
    model: env.RAG_EMBEDDING_MODEL,
    timeoutMs: env.RAG_EMBEDDING_TIMEOUT_MS,
  };
}

/** Falha de transporte/shape do embedding — transiente; nunca carrega a query nem a chave. */
export class EmbedError extends Error {
  readonly httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = 'EmbedError';
    this.httpStatus = httpStatus;
  }
}

/**
 * Embeda UMA query. Devolve o vetor de 1536 dims; qualquer divergência de dimensão
 * (modelo trocado sem casar o indexador do CRM) é ERRO — recall quebrado é pior que
 * chamada recusada. O corpo de erro da OpenAI é truncado e nunca embute a chave.
 */
export async function embedQuery(cfg: EmbedConfig, query: string): Promise<number[]> {
  if (!cfg.access || cfg.model !== 'text-embedding-3-small') throw new EmbedError('embedding_authorization_required');
  const base = (cfg.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '');
  const profile = embeddingProfile({provider:'openai',base_url:base.endsWith('/v1')?base:base+'/v1',model:'text-embedding-3-small',dimensions:1536,model_revision:'1',enabled:true});
  const result = await requestEmbedding(profile,cfg.apiKey,query,undefined,cfg.access);
  return result.embedding;
}
