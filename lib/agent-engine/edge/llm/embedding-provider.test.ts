import { describe, expect, it, vi } from "vitest";
import { requestEmbedding as governedRequest } from "./embedding-provider";
import type { EmbeddingProfile } from "@/lib/ai/embeddings/profile";
vi.mock("@/lib/ai/embeddings/operation-store",()=>({
  // This file isolates wire validation. Real admission/concurrency is exercised
  // against PG15/17 + a counting HTTP receiver in embedding-operations.test.ts.
  executeAuthorizedEmbedding:(_p:unknown,_i:unknown,_a:unknown,send:()=>Promise<unknown>)=>send(),
}));
const requestEmbedding=(p:EmbeddingProfile,key:string,text:string,fetcher?:typeof fetch)=>governedRequest(p,key,text,fetcher,
  {organizationId:'synthetic-org',kind:'query',sourceIds:['synthetic-source']});
import { embeddingProfile } from "@/lib/ai/embeddings/profile";
const sf = embeddingProfile({ provider: "siliconflow", base_url: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", dimensions: 1024, model_revision: "1", enabled: true });
function response(overrides = {}) {
  return new Response(JSON.stringify({ model: sf.model, data: [{ index: 0, embedding: Array(1024).fill(0.1) }], usage: { prompt_tokens: 8 }, ...overrides }));
}
describe("offline provider wire contract (synthetic vectors, not a live acceptance)", () => {
  it("sends the selected provider/model and does not send unsupported dimensions to BGE", async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    const result = await requestEmbedding(sf, "synthetic-test-credential", "SVC-101", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.siliconflow.cn/v1/embeddings");
    expect(JSON.parse(init.body)).toEqual({ model: "BAAI/bge-m3", input: "SVC-101", encoding_format: "float" });
    expect(init.redirect).toBe("manual");
    expect(result.embedding).toHaveLength(1024);
    expect(result.promptTokens).toBe(8);
  });
  it("sends the explicit dimension to Bailian", async () => {
    const p = embeddingProfile({ provider: "bailian", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "text-embedding-v4", dimensions: 1536, model_revision: "1", enabled: true });
    const fetcher = vi.fn().mockResolvedValue(response({ model: p.model, data: [{ index: 0, embedding: Array(1536).fill(0.1) }] }));
    expect((await requestEmbedding(p, "synthetic-test-credential", "SVC-101", fetcher)).embedding).toHaveLength(1536);
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).dimensions).toBe(1536);
  });
  it("accepts Bailian's documented total_tokens usage rather than inventing zero", async () => {
    const result = await requestEmbedding(sf, "synthetic-test-credential", "SVC-101", vi.fn().mockResolvedValue(response({ usage: { total_tokens: 12 } })));
    expect(result.promptTokens).toBe(12);
  });
  it("rejects missing usage instead of recording a fictional zero-token success", async () => {
    await expect(requestEmbedding(sf, "synthetic-test-credential", "SVC-101", vi.fn().mockResolvedValue(response({ usage: null })))).rejects.toThrow("embedding_response_invalid");
  });
  it.each([401, 403, 429, 500, 503])("classifies HTTP %s without leaking upstream text or falling back", async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response("synthetic-secret private customer text", { status }));
    await expect(requestEmbedding(sf, "synthetic-test-credential", "SVC-101", fetcher)).rejects.toMatchObject({ code: "embedding_upstream_rejected", httpStatus: status, message: "embedding_upstream_rejected" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects redirects to internal destinations", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }));
    await expect(requestEmbedding(sf, "synthetic-test-credential", "SVC-101", fetcher)).rejects.toThrow("embedding_transport_failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not echo arbitrary network errors", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("synthetic-secret private customer text"));
    await expect(requestEmbedding(sf, "synthetic-test-credential", "SVC-101", fetcher)).rejects.toThrow("embedding_transport_failed");
  });
  it.each([{ model: "wrong-model" }, { data: [{ index: 0, embedding: [1, 2] }] }, { data: [{ index: 1, embedding: Array(1024).fill(0.1) }] }, { data: [] }])("rejects incompatible responses", async (override) => {
    await expect(requestEmbedding(sf, "synthetic-test-credential", "SVC-101", vi.fn().mockResolvedValue(response(override)))).rejects.toThrow();
  });
  it("never fetches a forged profile or empty input", async () => {
    const fetcher = vi.fn();
    await expect(requestEmbedding({ ...sf, baseUrl: "http://localhost/v1" }, "synthetic-test-credential", "x", fetcher)).rejects.toThrow();
    await expect(requestEmbedding(sf, "synthetic-test-credential", "", fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
