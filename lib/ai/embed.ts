/** Canonical embedding entry for every RAG indexer and retriever.
 * Explicit profiles never fall back to the legacy OpenAI/gateway path.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { embed } from "ai";

import {
  DIMENSOES_DO_EMBEDDING,
  MODELO_DE_EMBEDDING,
  resolverChaveDeEmbedding,
  type ChaveDeEmbedding,
  type PontoDeEmbedding,
} from "@/lib/ai/embeddings/chave";
import { gatewayHeaders, type ModelId } from "@/lib/ai/gateway";
import { requestEmbedding } from "@/lib/agent-engine/edge/llm/embedding-provider";
import { assertEmbedding, EmbeddingConfigurationError, type EmbeddingProfile } from "./embeddings/profile";

export interface EmbedOptions {
  organizationId: string;
  /**
   * Qual ponto de IA está chamando. Muda apenas de QUAL binding a chave sai —
   * o modelo é o mesmo por contrato, e divergir quebraria o recall em silêncio.
   */
  ponto?: PontoDeEmbedding;
  /**
   * Chave já resolvida. Existe para o indexador resolver UMA vez e embedar N
   * chunks: sem isto, indexar um documento de 200 trechos decifraria a
   * credencial 200 vezes.
   */
  chave?: ChaveDeEmbedding;
  model?: ModelId;
}

export interface EmbedResult {
  embedding: number[];
  promptTokens: number;
  model: string;
  profile?: EmbeddingProfile;
}

/** Falta de chave é um ESTADO do tenant, não um acidente: tipo próprio para quem
 *  chama poder mostrar a tela certa em vez de repetir um erro genérico. */
export class SemChaveDeEmbeddingError extends Error {
  readonly code = "embedding_sem_chave";
  constructor(readonly organizationId: string) {
    super(
      "Esta organização não tem uma credencial de embedding disponível. Configure o provedor do conhecimento.",
    );
    this.name = "SemChaveDeEmbeddingError";
  }
}

export async function embedText(
  content: string,
  opts: EmbedOptions,
): Promise<EmbedResult> {
  const chave =
    opts.chave ?? (await resolverChaveDeEmbedding(opts.organizationId, opts.ponto));
  if (!chave) {
    throw new SemChaveDeEmbeddingError(opts.organizationId);
  }

  if (chave.profile) {
    if (chave.organizationId !== opts.organizationId)
      throw new EmbeddingConfigurationError("embedding_tenant_mismatch");
    if (opts.model && opts.model !== chave.profile.model)
      throw new EmbeddingConfigurationError("embedding_profile_override_forbidden");
    const result = await requestEmbedding(chave.profile, chave.apiKey ?? "", content);
    return { ...result, model: chave.profile.fingerprint, profile: chave.profile };
  }

  const modelId = String(opts.model ?? MODELO_DE_EMBEDDING);
  if (modelId !== MODELO_DE_EMBEDDING) throw new EmbeddingConfigurationError("embedding_profile_override_forbidden");

  // COM gateway: a string `openai/text-embedding-3-small` é roteada por ele, que
  // lê `AI_GATEWAY_API_KEY` do process.env. Headers vão junto p/ observabilidade
  // por tenant + ZDR.
  //
  // SEM gateway: precisa ser o provider OpenAI EXPLÍCITO. Passar a string com
  // barra aqui não cai no OpenAI direto — no AI SDK, id com barra é resolvido
  // pelo gateway da Vercel mesmo sem chave, entrando no plano anônimo, cujo teto
  // devolve `GatewayRateLimitError` e derruba a busca na base de conhecimento.
  const resolvido = chave.viaGateway
    ? modelId
    : createOpenAI({
        apiKey: chave.apiKey ?? "",
        ...(chave.baseUrl ? { baseURL: chave.baseUrl } : {}),
      }).textEmbeddingModel(modelId.replace(/^openai\//, ""));

  let result;
  try { result = await embed({
    model: resolvido,
    value: content,
    headers: chave.viaGateway
      ? gatewayHeaders({ organizationId: opts.organizationId })
      : undefined,
  }); } catch { throw new EmbeddingConfigurationError("embedding_upstream_failed"); }

  // Dimensão asserida a cada chamada: divergir de modelo quebra o recall em
  // SILÊNCIO (os vetores deixam de ser comparáveis), e uma chamada recusada é
  // infinitamente melhor que um acervo que responde errado com nota alta.
  if (result.embedding.length !== DIMENSOES_DO_EMBEDDING) {
    throw new Error(
      `embedding com ${result.embedding.length} dimensões, esperado ${DIMENSOES_DO_EMBEDDING} ` +
        `(pin de contrato ${modelId}) — recall quebraria em silêncio`,
    );
  }
  assertEmbedding(result.embedding, DIMENSOES_DO_EMBEDDING);

  // EmbedResult.embedding is `number[]` for single-value embed.
  const promptTokens =
    (result.usage as { tokens?: number; promptTokens?: number } | undefined)?.tokens ??
    (result.usage as { tokens?: number; promptTokens?: number } | undefined)?.promptTokens ??
    0;

  return { embedding: result.embedding, promptTokens, model: modelId };
}
