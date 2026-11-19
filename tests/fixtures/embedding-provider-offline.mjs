/* Test-process preload only. Never shipped in production images. No paid egress. */
import fs from "node:fs";
const nativeFetch = globalThis.fetch;
if (process.env.E2E_EMBEDDING_FIXTURE !== "1") throw new Error("embedding_fixture_requires_explicit_test_mode");
globalThis.fetch = async function offlineEmbeddingFetch(input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname === "api.siliconflow.cn") {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.href !== "https://api.siliconflow.cn/v1/embeddings" ||
        headers.get("authorization") !== "Bearer synthetic-embedding-ci-fixture")
      throw new Error("embedding_fixture_refuses_non_synthetic_request");
    const body = JSON.parse(init?.body ?? "{}");
    if (body.model !== "BAAI/bge-m3" || body.dimensions !== undefined) throw new Error("embedding_fixture_wire_contract");
    const counter = process.env.E2E_EMBEDDING_COUNTER_FILE;
    if (!counter || !counter.startsWith("/tmp/")) throw new Error("embedding_fixture_counter_required");
    fs.appendFileSync(counter, JSON.stringify({ model: body.model, dimensions: 1024, simulated: true }) + "\n");
    return new Response(JSON.stringify({ model: body.model, data: [{ index: 0, embedding: Array(1024).fill(0.1) }], usage: { prompt_tokens: 9, total_tokens: 9 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  if (/(?:^|\.)(openai\.com|deepseek\.com|anthropic\.com|aliyuncs\.com|siliconflow\.(?:cn|com))$/.test(url.hostname))
    throw new Error("paid_provider_egress_forbidden_in_embedding_ci");
  return nativeFetch(input, init);
};
