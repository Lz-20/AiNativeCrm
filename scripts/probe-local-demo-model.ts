/** Real, bounded synthetic provider probe. Never prints credentials or private prompts. */
import { loadCredential } from "@/lib/ai/credentials";
import assert from "node:assert/strict";

async function main() {
  assert(
    ["localhost", "127.0.0.1"].includes(new URL(process.env.SUPABASE_DB_URL ?? "").hostname),
    "local_demo_db_required",
  );
  const credential = await loadCredential(
    "0e644ce3-e1ba-4b4c-8e41-9860e292f965",
    "3ea5dbc2-050b-4324-a489-8a17c2b654c3",
  );
  for (const stream of [false, true]) {
    const response = await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(60000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.apiKey}` },
      body: JSON.stringify({
        model: "space-bunny-free",
        messages: [
          {
            role: "user",
            content: "This is a synthetic connectivity probe. Reply exactly: LOCAL_OK",
          },
        ],
        max_tokens: 128,
        stream,
      }),
    });
    const body = await response.text();
    if (!stream) {
      let data: {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        error?: { code?: string };
        usage?: unknown;
      } = {};
      try {
        data = JSON.parse(body);
      } catch {
        /* report malformed response without leaking body */
      }
      console.info(
        JSON.stringify({
          stream,
          httpStatus: response.status,
          contentType: response.headers.get("content-type"),
          bytes: body.length,
          finishReason: data.choices?.[0]?.finish_reason,
          contentLength: data.choices?.[0]?.message?.content?.length,
          exactMatch: data.choices?.[0]?.message?.content?.trim() === "LOCAL_OK",
          errorCode: data.error?.code,
          usage: data.usage,
        }),
      );
    } else {
      const chunks = body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => {
          try {
            return JSON.parse(line.slice(5));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      console.info(
        JSON.stringify({
          stream,
          httpStatus: response.status,
          contentType: response.headers.get("content-type"),
          bytes: body.length,
          chunkCount: chunks.length,
          deltaLength: chunks.reduce(
            (sum, chunk) => sum + (chunk.choices?.[0]?.delta?.content?.length ?? 0),
            0,
          ),
          finishReasons: chunks.map((chunk) => chunk.choices?.[0]?.finish_reason).filter(Boolean),
          firstChunkKeys: chunks[0] ? Object.keys(chunks[0]) : [],
        }),
      );
    }
  }
}
void main().catch(() => {
  console.error("Synthetic provider probe failed; credentials suppressed.");
  process.exitCode = 1;
});
