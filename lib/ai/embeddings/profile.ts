import { createHash } from "node:crypto";
import { z } from "zod";

export const embeddingConfigurationSchema = z.object({
  provider: z.enum(["siliconflow", "bailian", "openai"]),
  base_url: z.string().max(240),
  model: z.string().trim().min(1).max(100),
  dimensions: z.union([z.literal(1024), z.literal(1536)]),
  model_revision: z.string().regex(/^[a-zA-Z0-9._-]{1,40}$/).default("1"),
  enabled: z.boolean().default(false),
}).strict();
export type EmbeddingConfiguration = z.infer<typeof embeddingConfigurationSchema>;
export interface EmbeddingProfile {
  provider: EmbeddingConfiguration["provider"];
  baseUrl: string;
  model: string;
  dimensions: 1024 | 1536;
  revision: string;
  fingerprint: string;
}
export class EmbeddingConfigurationError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number) {
    super(code);
    this.name = "EmbeddingConfigurationError";
  }
}
const ENDPOINTS = {
  siliconflow: ["https://api.siliconflow.cn/v1"],
  bailian: ["https://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
  openai: ["https://api.openai.com/v1"],
} as const;

/** Tenant configuration can select reviewed public endpoints, never arbitrary URLs. */
export function embeddingProfile(input: EmbeddingConfiguration): EmbeddingProfile {
  let url: URL;
  try { url = new URL(input.base_url); }
  catch { throw new EmbeddingConfigurationError("embedding_endpoint_invalid"); }
  const baseUrl = url.href.replace(/\/$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port ||
      !(ENDPOINTS[input.provider] as readonly string[]).includes(baseUrl))
    throw new EmbeddingConfigurationError("embedding_endpoint_not_allowed");
  const supported = input.provider === "siliconflow"
    ? ["BAAI/bge-m3", "Pro/BAAI/bge-m3"].includes(input.model) && input.dimensions === 1024
    : input.provider === "bailian" ? input.model === "text-embedding-v4"
    : input.model === "text-embedding-3-small";
  if (!supported) throw new EmbeddingConfigurationError("embedding_model_dimensions_unsupported");
  const identity = [1, input.provider, baseUrl, input.model, input.dimensions, input.model_revision];
  return { provider: input.provider, baseUrl, model: input.model, dimensions: input.dimensions,
    revision: input.model_revision,
    fingerprint: "embedding:v1:" + createHash("sha256").update(JSON.stringify(identity)).digest("hex") };
}

/** Never pad/truncate or accept nonfinite/zero vectors. */
export function assertEmbedding(vector: unknown, dimensions: number): asserts vector is number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions ||
      !vector.every((v) => typeof v === "number" && Number.isFinite(v)) || !vector.some((v) => v !== 0))
    throw new EmbeddingConfigurationError("embedding_vector_invalid");
}
