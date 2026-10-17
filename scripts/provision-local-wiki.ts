/** Provision only synthetic Wiki content in the loopback WeKnora validation service. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCredential } from "@/lib/ai/credentials";

interface WikiEntity {
  id: string;
  name?: string;
  display_name?: string;
  parse_status?: string;
  token?: string;
  slug?: string;
  content?: string;
  version?: number;
  source_refs?: string[];
  status?: string;
}
interface WikiResponse {
  success?: boolean;
  token?: string;
  active_tenant?: { id: number };
  data?: WikiEntity;
  pages?: WikiEntity[];
}

async function main() {
  assert(
    ["localhost", "127.0.0.1"].includes(new URL(process.env.SUPABASE_DB_URL ?? "").hostname),
    "local_demo_db_required",
  );
  const path = resolve("infra/local-agent-services/.env.generated");
  let text = readFileSync(path, "utf8");
  const values = Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
  const store = (key: string, value: string) => {
    assert(!/[\n\r]/.test(value));
    text =
      text
        .split("\n")
        .filter((l) => !l.startsWith(`${key}=`))
        .join("\n")
        .trimEnd() + `\n${key}=${value}\n`;
    values[key] = value;
    writeFileSync(path, text, { mode: 0o600 });
  };
  const base = "http://127.0.0.1:8088";
  // The deployed upstream ignored max_pages_per_ingest=2 and generated 11 pages.
  // Reusing a configured read-only fixture must not silently start paid synthesis.
  const requiresProvisioning = [
    "WEKNORA_MODEL_ID",
    "WEKNORA_KB_ID",
    "WEKNORA_API_KEY",
    "WEKNORA_DOCUMENT_ID",
  ].some((key) => !values[key]);
  assert(
    !requiresProvisioning || process.argv.includes("--allow-unbounded-synthetic-ingest"),
    "wiki_fixture_missing_explicit_unbounded_synthesis_approval_required",
  );
  let token = "";
  async function api<T = WikiResponse>(
    route: string,
    method = "GET",
    body?: unknown,
    allowFailure = false,
  ): Promise<T> {
    const r = await fetch(base + route, {
      method,
      signal: AbortSignal.timeout(120000),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!allowFailure)
      assert(r.ok, `wiki_api_${method}_${route.replace(/[a-f0-9-]{36}/g, "id")}_${r.status}`);
    return r.json();
  }
  let login = await api(
    "/api/v1/auth/login",
    "POST",
    { email: "agent-services@localhost.test", password: values.WEKNORA_USER_PASSWORD },
    true,
  );
  if (!login.success) {
    await api("/api/v1/auth/register", "POST", {
      username: "CRM Local Validation",
      email: "agent-services@localhost.test",
      password: values.WEKNORA_USER_PASSWORD,
    });
    login = await api("/api/v1/auth/login", "POST", {
      email: "agent-services@localhost.test",
      password: values.WEKNORA_USER_PASSWORD,
    });
  }
  assert(login.token && login.active_tenant?.id, "wiki_login_required");
  token = login.token;
  store("WEKNORA_TENANT_ID", String(login.active_tenant.id));
  if (!values.WEKNORA_MODEL_ID) {
    const listed = await api<{ data: WikiEntity[] }>("/api/v1/models");
    let model = listed.data.find(
      (m) => m.name === "space-bunny-free" && m.display_name === "CRM 本地 Wiki 真实模型",
    );
    if (!model) {
      const credential = await loadCredential(
        "0e644ce3-e1ba-4b4c-8e41-9860e292f965",
        "3ea5dbc2-050b-4324-a489-8a17c2b654c3",
      );
      assert.equal(credential.provider, "opencode");
      model = (
        await api("/api/v1/models", "POST", {
          name: "space-bunny-free",
          display_name: "CRM 本地 Wiki 真实模型",
          type: "KnowledgeQA",
          source: "remote",
          parameters: {
            provider: "generic",
            base_url: "https://opencode.ai/zen/v1",
            api_key: credential.apiKey,
            max_concurrency: 1,
            context_window: 32768,
            max_output_tokens: 2048,
            spec: { api: "openai-completions" },
          },
        })
      ).data;
    }
    assert(model?.id, "wiki_model_missing");
    store("WEKNORA_MODEL_ID", model.id);
  }
  if (!values.WEKNORA_KB_ID) {
    const listed = await api<{ data: WikiEntity[] }>("/api/v1/knowledge-bases");
    let kb = listed.data.find((k) => k.name === "CRM 本地合成产品 Wiki");
    if (!kb)
      kb = (
        await api("/api/v1/knowledge-bases", "POST", {
          name: "CRM 本地合成产品 Wiki",
          type: "wiki",
          description: "仅用于真实服务联调，不代表商业承诺。",
          indexing_strategy: {
            vector_enabled: false,
            keyword_enabled: false,
            wiki_enabled: true,
            graph_enabled: false,
          },
          wiki_config: {
            synthesis_model_id: values.WEKNORA_MODEL_ID,
            extraction_granularity: "focused",
            content_instructions:
              "用简体中文整理，明确标注为演示合成资料。所有结论都需要原文引用。",
            ingest_batch_size: 1,
            ingest_map_parallel: 1,
            ingest_reduce_parallel: 1,
            ingest_max_inflight: 1,
          },
          chunking_config: { chunk_size: 512, chunk_overlap: 50 },
        })
      ).data;
    assert(kb?.id, "wiki_kb_missing");
    store("WEKNORA_KB_ID", kb.id);
  }
  if (!values.WEKNORA_API_KEY) {
    const key = await api(`/api/v1/tenants/${values.WEKNORA_TENANT_ID}/api-keys`, "POST", {
      name: "CRM 只读 Wiki 检索",
      full_access: false,
      knowledge_base_ids: [values.WEKNORA_KB_ID],
      capabilities: ["retrieve"],
    });
    assert(key.data?.token, "wiki_scoped_key_missing");
    store("WEKNORA_API_KEY", key.data.token);
  }
  if (!values.WEKNORA_DOCUMENT_ID) {
    const document = await api(
      `/api/v1/knowledge-bases/${values.WEKNORA_KB_ID}/knowledge/manual`,
      "POST",
      {
        title: "演示合成产品资料与人工确认规则",
        status: "publish",
        content:
          "# 演示合成产品资料\n\n本文仅用于 CRM 本地联调，不代表任何真实客户、产品价格或商业承诺。\n\n## 产品能力\nPi Native CRM 使用 Pi Agent Core 执行多步工具调用。客户记忆只保存人工确认的偏好和事实，CRM 数据库仍是事实来源，Mem0 提供向量检索。公司产品资料由 Wiki 知识库提供，并保留原始文档引用。\n\n## 人工确认\n发送外部客户消息和其他不可逆动作必须等待人工确认。读取 CRM 数据可自动执行；本次测试为 inspect 模式，不发送外部消息、不修改商机。\n\n## 可观测性\nLangfuse 接收脱敏的真实模型和工具调用 Trace，以及 Eval 分数，不上传客户原文、密钥或隐藏推理。",
      },
    );
    assert(document.data?.id, "wiki_document_missing");
    store("WEKNORA_DOCUMENT_ID", document.data.id);
  }
  const doc = await api(`/api/v1/knowledge/${values.WEKNORA_DOCUMENT_ID}`);
  const pages = await api<{ pages?: WikiEntity[]; data?: WikiEntity[] }>(
    `/api/v1/knowledgebase/${values.WEKNORA_KB_ID}/wiki/pages`,
  );
  if (process.argv.includes("--publish-synthetic")) {
    assert.equal(doc.data?.parse_status, "completed", "wait_for_real_wiki_generation");
    const candidates = (pages.pages ?? []).filter(
      (page) =>
        page.slug === "entity/pi-native-crm" &&
        page.source_refs?.length === 1 &&
        page.source_refs[0] === values.WEKNORA_DOCUMENT_ID &&
        page.content?.includes("演示合成"),
    );
    assert.equal(candidates.length, 1, "reviewed_synthetic_product_page_required");
    for (const page of candidates) {
      if (page.status === "published") continue;
      assert(page.version && page.slug);
      const published = await api<WikiEntity>(
        `/api/v1/knowledgebase/${values.WEKNORA_KB_ID}/wiki/pages/${page.slug}`,
        "PUT",
        { status: "published", version: page.version },
      );
      assert.equal(published.status, "published");
      console.info(
        JSON.stringify({
          publishedSyntheticPage: page.id,
          sourceDocument: values.WEKNORA_DOCUMENT_ID,
        }),
      );
    }
  }
  console.info(
    JSON.stringify({
      synthetic: true,
      tenantId: values.WEKNORA_TENANT_ID,
      knowledgeBaseId: values.WEKNORA_KB_ID,
      documentId: values.WEKNORA_DOCUMENT_ID,
      parseStatus: doc.data?.parse_status,
      pageCount: pages.pages?.length ?? pages.data?.length,
      realModel: "opencode/space-bunny-free",
      keyCapability: "retrieve",
    }),
  );
}
void main().catch((error) => {
  console.error({
    provisionFailed: true,
    code: error instanceof assert.AssertionError ? error.message : "local_wiki_provision_failed",
  });
  process.exitCode = 1;
});
