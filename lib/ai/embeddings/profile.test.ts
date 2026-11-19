import { describe, expect, it } from "vitest";
import { assertEmbedding, embeddingProfile } from "./profile";
const input = { provider: "siliconflow" as const, base_url: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", dimensions: 1024 as const, model_revision: "1", enabled: true };
describe("embedding vector-space identity", () => {
  it("keeps SiliconFlow distinct from Bailian/OpenAI even at identical dimensions", () => {
    const sf = embeddingProfile(input);
    const ali = embeddingProfile({ ...input, provider: "bailian", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "text-embedding-v4" });
    expect(sf.fingerprint).not.toBe(ali.fingerprint);
    expect(embeddingProfile({ ...input, model_revision: "2" }).fingerprint).not.toBe(sf.fingerprint);
    expect(embeddingProfile({ ...input, enabled: false }).fingerprint).toBe(sf.fingerprint);
  });
  it.each(["http://127.0.0.1/v1", "https://169.254.169.254/v1", "https://[::1]/v1", "https://api.siliconflow.cn.evil.test/v1",
    "https://api.siliconflow.cn:8443/v1", "https://user:password@api.siliconflow.cn/v1", "https://api.siliconflow.cn/v1?api_key=secret", "https://api.siliconflow.cn/v1#fragment",
    "https://api.openai.com/v1", "https://2130706433/v1"])("rejects unreviewed endpoint %s", (base_url) => {
    expect(() => embeddingProfile({ ...input, base_url })).toThrow();
  });
  it("does not pretend BGE supports a 1536-dimensional output", () => {
    expect(() => embeddingProfile({ ...input, dimensions: 1536 })).toThrow("embedding_model_dimensions_unsupported");
  });
  it.each([1024, 1536] as const)("supports Bailian text-embedding-v4 at %s", (dimensions) => {
    expect(embeddingProfile({ ...input, provider: "bailian", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "text-embedding-v4", dimensions }).dimensions).toBe(dimensions);
  });
  it.each([[1, 2], Array(1024).fill(0), Array(1024).fill(NaN), Array(1024).fill(Infinity), Array(1024).fill("1")].map((vector) => ({ vector })))("rejects malformed vectors", ({ vector }) => {
    expect(() => assertEmbedding(vector, 1024)).toThrow("embedding_vector_invalid");
  });
  it("accepts a finite nonzero vector without padding or truncation", () => {
    expect(() => assertEmbedding(Array(1024).fill(0.1), 1024)).not.toThrow();
  });
});
