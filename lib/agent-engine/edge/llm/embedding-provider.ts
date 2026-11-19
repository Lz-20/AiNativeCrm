import { allowlistedFetch, buildAllowlist } from "../egress";
import { assertEmbedding, embeddingProfile, EmbeddingConfigurationError, type EmbeddingProfile } from "@/lib/ai/embeddings/profile";
import { executeAuthorizedEmbedding, type EmbeddingAccess } from "@/lib/ai/embeddings/operation-store";

/** OpenAI-compatible wire format; the destination is the selected provider. */
export async function requestEmbedding(profile: EmbeddingProfile, apiKey: string, input: string,
  fetchImpl?: typeof fetch, access?: EmbeddingAccess): Promise<{ embedding: number[]; promptTokens: number }> {
  if (!access) throw new EmbeddingConfigurationError("embedding_authorization_required");
  return executeAuthorizedEmbedding(profile, input, access, () => sendEmbedding(profile, apiKey, input, fetchImpl));
}

/** Private wire primitive: all exported calls pass the durable admission gate. */
async function sendEmbedding(profile: EmbeddingProfile, apiKey: string, input: string,
  fetchImpl?: typeof fetch) {
  const start = Date.now();
  const checked = embeddingProfile({ provider: profile.provider, base_url: profile.baseUrl,
    model: profile.model, dimensions: profile.dimensions, model_revision: profile.revision, enabled: true });
  if (checked.fingerprint !== profile.fingerprint) throw new EmbeddingConfigurationError("embedding_profile_invalid");
  if (!input.trim() || input.length > 32000) throw new EmbeddingConfigurationError("embedding_input_invalid");
  let response: Response;
  try {
    response = await allowlistedFetch(profile.baseUrl + "/embeddings", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: profile.model, input, encoding_format: "float",
        // SiliconFlow BGE has a fixed dimension and does NOT accept this knob.
        ...(profile.provider !== "siliconflow" ? { dimensions: profile.dimensions } : {}) }),
      signal: AbortSignal.timeout(30000),
    }, { allowlist: buildAllowlist([profile.baseUrl]), ...(fetchImpl ? { fetchImpl } : {}) });
  } catch { throw new EmbeddingConfigurationError("embedding_transport_failed"); }
  if (!response.ok) throw new EmbeddingConfigurationError("embedding_upstream_rejected", response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new EmbeddingConfigurationError("embedding_response_invalid");
  const parts: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new Error(); }
      parts.push(part.value);
    }
    const data = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
      model?: string; data?: Array<{ index?: number; embedding?: unknown }>; usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    if (data.model !== profile.model || data.data?.length !== 1 || data.data[0]?.index !== 0)
      throw new Error();
    const embedding = data.data[0].embedding;
    assertEmbedding(embedding, profile.dimensions);
    const tokens = data.usage?.prompt_tokens ?? data.usage?.total_tokens;
    if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) throw new Error();
    return { embedding, promptTokens: tokens, latencyMs: Date.now() - start,
      upstreamRequestId: response.headers.get("x-siliconcloud-trace-id") ?? response.headers.get("x-request-id") ?? undefined };
  } catch (error) {
    if (error instanceof EmbeddingConfigurationError) throw error;
    throw new EmbeddingConfigurationError("embedding_response_invalid");
  } finally { reader.releaseLock(); }
}
