/**
 * Embedding por organização. Uma configuração explícita governa índice e busca:
 * provider/endpoint/model/dimensions/revision + credencial cifrada do mesmo tenant.
 * Desativada, inválida ou sem chave válida falha fechada, sem fallback de provedor.
 * Sem configuração nova, preserva-se o caminho legado OpenAI de 1536 dimensões.
 */
import { byteaToBuffer, decryptKey } from "@/lib/crypto/aes_gcm";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { readEmbeddingConfiguration, credentialForEmbedding } from "./configuration";
import { EmbeddingConfigurationError, type EmbeddingProfile } from "./profile";

/** Os dois pontos de IA que consomem embedding (`lib/ai/pontos/registro.ts`). */
export type PontoDeEmbedding = "embedding_indexar" | "embedding_consultar";

/** Identidade legada, não o perfil configurável de novos índices. */
export const MODELO_DE_EMBEDDING = "openai/text-embedding-3-small";
export const DIMENSOES_DO_EMBEDDING = 1536;

export type OrigemDaChave =
  | "binding_do_ponto"
  | "credencial_da_organizacao"
  | "configuracao_embedding"
  | "gateway_da_instalacao"
  | "chave_da_instalacao";

export const EXPLICACAO_DA_ORIGEM: Record<OrigemDaChave, string> = {
  configuracao_embedding: "Configurada independentemente para a base de conhecimento.",
  binding_do_ponto: "Escolhida por você no painel de Provedores.",
  credencial_da_organizacao: "Usando a chave OpenAI cadastrada em Credenciais.",
  gateway_da_instalacao: "Usando o gateway de IA configurado nesta instalação.",
  chave_da_instalacao: "Usando a chave que veio na instalação.",
};

export interface ChaveDeEmbedding {
  organizationId?: string;
  /** Immutable non-secret vector-space identity for explicitly configured RAG. */
  profile?: EmbeddingProfile;
  /** Plaintext. Vive só no escopo de quem chamou — nunca logada nem persistida. */
  apiKey: string | null;
  /** `null` = falar direto com a OpenAI. */
  baseUrl: string | null;
  /** Quando true, a chamada vai pelo gateway (o SDK lê a chave do process.env). */
  viaGateway: boolean;
  origem: OrigemDaChave;
  /** Rótulo da credencial, quando houver — a tela mostra qual chave está valendo. */
  rotulo: string | null;
  /** Incoerências que não impedem a chamada mas alguém precisa ver. */
  avisos: string[];
}

/**
 * Resolve a chave de embedding da organização, ou `null` quando não há nenhuma.
 *
 * `organizationId` é obrigatório: um resolvedor que aceitasse organização
 * opcional acabaria chamado sem ela justamente no caminho que mais importa,
 * aplicando a configuração de ninguém.
 */
export async function resolverChaveDeEmbedding(
  organizationId: string,
  ponto: PontoDeEmbedding = "embedding_indexar",
): Promise<ChaveDeEmbedding | null> {
  const configured = await readEmbeddingConfiguration(organizationId);
  if (configured) {
    const resolved = await credentialForEmbedding(organizationId, configured);
    return { organizationId, apiKey: resolved.apiKey, baseUrl: resolved.profile.baseUrl, viaGateway: false,
      origem: "configuracao_embedding", rotulo: resolved.label, avisos: [], profile: resolved.profile };
  }
  const avisos: string[] = [];

  // 1 · A escolha explícita do painel.
  const binding = await lerBindingDeEmbedding(ponto, organizationId);
  if (binding?.base_url && binding.base_url.replace(/\/$/, "") !== "https://api.openai.com/v1")
    throw new EmbeddingConfigurationError("embedding_endpoint_requires_profile");
  if (binding?.model_id && ![MODELO_DE_EMBEDDING, "text-embedding-3-small"].includes(binding.model_id))
    throw new EmbeddingConfigurationError("embedding_model_requires_profile");
  if (binding?.credential_id) {
    const credencial = await decifrarCredencial(binding.credential_id, organizationId);
    if (credencial) {
      return {
        apiKey: credencial.apiKey,
        baseUrl: binding.base_url,
        viaGateway: false,
        origem: "binding_do_ponto",
        rotulo: credencial.rotulo,
        avisos,
      };
    }
    throw new EmbeddingConfigurationError("embedding_credential_unavailable");
  }

  // 2 · A credencial OpenAI da organização, sem exigir binding nenhum.
  const daOrg = await credencialOpenAiDaOrganizacao(organizationId);
  if (daOrg) {
    if (daOrg.quantas > 1) {
      avisos.push(
        `Esta organização tem ${daOrg.quantas} chaves OpenAI cadastradas e nenhuma escolhida para ` +
          `a base de conhecimento. Usando "${daOrg.rotulo}" — escolha uma em Provedores para não depender disso.`,
      );
    }
    return {
      apiKey: daOrg.apiKey,
      baseUrl: null,
      viaGateway: false,
      origem: "credencial_da_organizacao",
      rotulo: daOrg.rotulo,
      avisos,
    };
  }

  // 3 · O gateway da instalação. A chave não sai daqui: o SDK a lê do process.env.
  if (env.AI_GATEWAY_API_KEY) {
    return {
      apiKey: null,
      baseUrl: env.AI_GATEWAY_BASE_URL || null,
      viaGateway: true,
      origem: "gateway_da_instalacao",
      rotulo: null,
      avisos,
    };
  }

  // 4 · A chave que o install.sh pediu.
  if (env.OPENAI_API_KEY) {
    return {
      apiKey: env.OPENAI_API_KEY,
      baseUrl: null,
      viaGateway: false,
      origem: "chave_da_instalacao",
      rotulo: null,
      avisos,
    };
  }

  return null;
}

/**
 * Existe chave utilizável para esta organização?
 *
 * Substitui `isEmbeddingProviderConfigured()`, cuja assinatura SEM organização
 * é a raiz do defeito: ela respondia "não" para toda organização que tivesse
 * cadastrado a chave pela tela.
 */
export async function temChaveDeEmbedding(organizationId: string): Promise<boolean> {
  try {
    return (await resolverChaveDeEmbedding(organizationId)) !== null;
  } catch (error) {
    // Uploads may wait for a staged credential; do not fall back or call a provider.
    if (error instanceof EmbeddingConfigurationError && [
      "embedding_disabled", "embedding_credential_unavailable", "credential_provider_mismatch",
    ].includes(error.code)) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Leitura do banco — admin client, filtro de organização SEMPRE programático
// (o service role bypassa RLS; CLAUDE.md, anti-pattern 10).
// ---------------------------------------------------------------------------

interface LinhaDeBinding {
  credential_id: string | null;
  model_id: string;
  base_url: string | null;
}

async function lerBindingDeEmbedding(
  ponto: PontoDeEmbedding,
  organizationId: string,
): Promise<LinhaDeBinding | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("ai_purpose_bindings")
      .select("credential_id, model_id, base_url")
      .eq("organization_id", organizationId)
      .eq("purpose", ponto)
      .eq("is_enabled", true)
      .maybeSingle();
    if (error) throw new EmbeddingConfigurationError("embedding_binding_unavailable");
    return (data as LinhaDeBinding | null) ?? null;
  } catch {
    throw new EmbeddingConfigurationError("embedding_binding_unavailable");
  }
}

async function decifrarCredencial(
  credentialId: string,
  organizationId: string,
): Promise<{ apiKey: string; rotulo: string } | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("label, api_key_encrypted, api_key_iv, api_key_tag")
      .eq("id", credentialId)
      .eq("organization_id", organizationId)
      .eq("provider", "openai")
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .maybeSingle();
    if (!data) return null;
    return {
      apiKey: decryptKey({
        ciphertext: byteaToBuffer(data.api_key_encrypted),
        iv: byteaToBuffer(data.api_key_iv),
        tag: byteaToBuffer(data.api_key_tag),
      }),
      rotulo: String((data as { label?: string }).label ?? ""),
    };
  } catch {
    // Sem detalhe no log: qualquer eco aqui corre o risco de carregar material
    // da credencial.
    return null;
  }
}

/**
 * A credencial OpenAI ativa e validada da organização.
 *
 * Desempate DETERMINÍSTICO pela mais antiga: com duas chaves e nenhuma escolha,
 * "a mais recente" faria o comportamento mudar sozinho no dia em que alguém
 * cadastrasse outra. A tela evita o caso oferecendo a escolha; aqui o que
 * importa é não variar.
 */
async function credencialOpenAiDaOrganizacao(
  organizationId: string,
): Promise<{ apiKey: string; rotulo: string; quantas: number } | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("ai_provider_credentials")
      .select("id, label, api_key_encrypted, api_key_iv, api_key_tag")
      .eq("organization_id", organizationId)
      .eq("provider", "openai")
      .eq("is_active", true)
      .not("validated_at", "is", null)
      .order("created_at", { ascending: true });

    const linhas = (data ?? []) as Array<{
      id: string;
      label: string;
      api_key_encrypted: unknown;
      api_key_iv: unknown;
      api_key_tag: unknown;
    }>;
    const primeira = linhas[0];
    if (!primeira) return null;

    return {
      apiKey: decryptKey({
        ciphertext: byteaToBuffer(primeira.api_key_encrypted),
        iv: byteaToBuffer(primeira.api_key_iv),
        tag: byteaToBuffer(primeira.api_key_tag),
      }),
      rotulo: primeira.label,
      quantas: linhas.length,
    };
  } catch {
    return null;
  }
}
