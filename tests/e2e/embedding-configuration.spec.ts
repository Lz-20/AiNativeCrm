/** Real browser/API/Storage/Worker/pgvector. Only the upstream HTTP response is synthetic. */
import { readFileSync, existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { credenciaisSupabaseDeTeste, destinoEhLocal } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

test("independent embedding configuration and SVC-101 indexing with offline provider", async ({ page, browser }) => {
  test.setTimeout(180_000);
  if (process.env.E2E_EMBEDDING_FIXTURE !== "1") throw new Error("run_with_reviewed_offline_preload");
  const local = credenciaisSupabaseDeTeste();
  if (!destinoEhLocal(local.url) || !local.dbUrl || !destinoEhLocal(local.dbUrl)) throw new Error("isolated_local_supabase_required");
  const db = createClient(local.url, local.serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const creds = await loginComoAdmin(page, lerCreds());
  const { data: org, error: orgError } = await db.from("organizations").select("id").eq("slug", "e2e-test-org").single();
  expect(orgError).toBeNull(); expect(org).toBeTruthy();
  const orgId = org!.id as string;
  const initial = await page.request.get("/api/v1/ai/knowledge/embedding");
  expect(initial.status()).toBe(200);
  expect((await initial.json()).data.configuration).toBeNull();
  const counter = process.env.E2E_EMBEDDING_COUNTER_FILE!;
  const calls = () => existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length : 0;
  const before = calls();
  let credentialId: string | undefined; let sourceId: string | undefined; let blobPath: string | undefined;
  try {
    await page.goto("/app/ai/knowledge/sources");
    const panel = page.getByTestId("embedding-configuration");
    await expect(panel).toBeVisible(); await panel.locator("summary").click();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("BAAI/bge-m3");
    await page.getByLabel("Model revision").fill("ci-fixture");
    await page.getByLabel("API Key（仅新建或更换时填写）").fill("synthetic-embedding-ci-fixture");
    await page.getByLabel(/启用Embedding/).check();
    const saved = page.waitForResponse(r => r.url().endsWith("/api/v1/ai/knowledge/embedding") && r.request().method() === "PUT");
    await page.getByText("保存配置（不调用API）", { exact: true }).click();
    expect((await saved).status()).toBe(200);
    let configuration = (await (await page.request.get("/api/v1/ai/knowledge/embedding")).json()).data.configuration;
    credentialId = configuration.credential_id;
    expect(configuration.enabled).toBe(false); expect(calls()).toBe(before);
    const safeText = await (await page.request.get("/api/v1/ai/knowledge/embedding")).text();
    expect(safeText).not.toContain("synthetic-embedding-ci-fixture");
    const noConsent = await page.request.post("/api/v1/ai/knowledge/embedding/validate", { data: { confirm_cost: false } });
    expect(noConsent.status()).toBe(400); expect(calls()).toBe(before);
    const stale = await page.request.put("/api/v1/ai/knowledge/embedding", { data: {
      provider: "siliconflow", base_url: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", dimensions: 1024,
      model_revision: "ci-fixture", enabled: false, credential_id: credentialId, expected_version: null,
    } });
    expect(stale.status()).toBe(409); expect(calls()).toBe(before);
    // Saving remounts the form to the persisted version; reopen its details element.
    await panel.locator("summary").click();
    const validated = page.waitForResponse(r => r.url().endsWith("/embedding/validate"));
    await page.getByText("验证Embedding（调用供应商，可能计费）", { exact: true }).click();
    expect((await validated).status()).toBe(200); expect(calls()).toBe(before + 1);
    configuration = (await (await page.request.get("/api/v1/ai/knowledge/embedding")).json()).data.configuration;
    expect(configuration.enabled).toBe(false);
    await page.getByLabel(/启用Embedding/).check();
    const enabled = page.waitForResponse(r => r.url().endsWith("/api/v1/ai/knowledge/embedding") && r.request().method() === "PUT");
    await page.getByText("保存配置（不调用API）", { exact: true }).click(); expect((await enabled).status()).toBe(200);
    await page.getByTestId("acervo-adicionar").click();
    await page.getByTestId("material-tipo-documento").click();
    const name = "SVC-101 offline CI " + Date.now();
    await page.getByTestId("material-nome").fill(name);
    await page.getByTestId("material-arquivo").setInputFiles({ name: "CRM-test-service-v1.md", mimeType: "text/markdown",
      buffer: Buffer.from("# CRM 测试服务手册 v1\n测试服务编号：SVC-101。服务时间：工作日09:00—18:00。只读巡检，不发送消息。") });
    const uploaded = page.waitForResponse(r => r.url().endsWith("/knowledge/sources/upload"));
    await page.getByTestId("material-criar").click(); expect((await uploaded).status()).toBe(201);
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    const { data: source } = await db.from("ai_knowledge_sources").select("id,source_metadata").eq("organization_id", orgId).eq("name", name).single();
    expect(source).toBeTruthy(); sourceId = source!.id; blobPath = source!.source_metadata?.blob_path;
    const drained = await page.request.post("/api/v1/cron/event-log-drain", { headers: { authorization: `Bearer ${process.env.INTERNAL_SECRET}` } });
    expect(drained.status()).toBe(200); const drain = (await drained.json()).data;
    expect(drain.failed + drain.dead).toBe(0);
    const { data: indexed } = await db.from("ai_knowledge_sources").select("active_kb_version_id,last_index_status").eq("organization_id", orgId).eq("id", sourceId).single();
    expect(indexed?.active_kb_version_id).toBeTruthy();
    const { data: version } = await db.from("ai_knowledge_versions").select("status,is_active,embedding_model,embedding_dims,embedding_profile").eq("organization_id", orgId).eq("id", indexed!.active_kb_version_id).single();
    expect(version).toMatchObject({ status: "ready", is_active: true, embedding_dims: 1024 });
    const { data: hits, error: searchError } = await db.rpc("fn_search_knowledge_profile", { p_organization_id: orgId,
      p_source_ids: [sourceId], p_embedding: JSON.stringify(Array(1024).fill(0.1)), p_fingerprint: version!.embedding_model, p_dimensions: 1024, p_k: 5, p_threshold: -1 });
    expect(searchError).toBeNull(); expect(hits?.[0]).toMatchObject({ knowledge_source_id: sourceId, source_name: name, index_version_id: indexed!.active_kb_version_id });
    expect(hits?.[0]?.content).toContain("SVC-101");
    await page.reload(); const card = page.getByTestId(`material-${sourceId}`);
    await card.getByRole("button", { name: "Ver o que ele aprendeu" }).click();
    await expect(page.getByTestId("material-trechos-lista")).toContainText("SVC-101");
    const managerContext = await browser.newContext();
    try {
      const manager = await managerContext.newPage(); await manager.goto("/login");
      await manager.locator("#email").fill(creds.users.manager!.email); await manager.locator("#password").fill(creds.password);
      await manager.getByRole("button", { name: /Entrar|登录/ }).click(); await manager.waitForURL(/\/app/);
      await manager.goto("/app/ai/knowledge/sources");
      await expect(manager.getByTestId("embedding-configuration")).toBeVisible();
      await expect(manager.getByLabel("API Key（仅新建或更换时填写）")).toHaveCount(0);
      expect((await manager.request.put("/api/v1/ai/knowledge/embedding", { data: {} })).status()).toBe(403);
    } finally { await managerContext.close(); }
    await page.screenshot({ path: "test-results/embedding-svc101-offline.png", fullPage: true });
  } finally {
    // Only synthetic fixtures in the verified loopback test database; no deployed state.
    await db.from("ai_embedding_configurations").delete().eq("organization_id", orgId).eq("model_revision", "ci-fixture");
    if (sourceId) await db.from("ai_knowledge_sources").delete().eq("organization_id", orgId).eq("id", sourceId);
    if (blobPath) await db.storage.from("ai-policy").remove([blobPath]);
    if (credentialId) await db.from("ai_provider_credentials").delete().eq("organization_id", orgId).eq("id", credentialId);
  }
});
