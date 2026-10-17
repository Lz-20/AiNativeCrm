import { expect, test } from "@playwright/test";

/** Local-only: playwright.config.ts rejects any non-loopback Supabase target. */
test("真实模型通过结构化提交口交付只读 CRM 结果", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/login?next=%2Fapp%2Fai%2Fworkbench");
  await page.locator("#email").fill(process.env.CRM_DEMO_EMAIL ?? "demo@example.invalid");
  await page.locator("#password").fill(process.env.CRM_DEMO_PASSWORD ?? "PiNativeDemo!2026");
  await page.getByRole("button", { name: /登录|Entrar/ }).click();
  await page.waitForURL(/\/app\/ai\/workbench/, { timeout: 45_000 });

  const agentsResponse = await page.request.get("/api/v1/ai/agents");
  expect(agentsResponse.ok()).toBeTruthy();
  const agents = (await agentsResponse.json()).data as Array<{
    id: string;
    builtin_key: string | null;
  }>;
  const analyst = agents.find((agent) => agent.builtin_key === "crm_intelligence");
  expect(analyst).toBeDefined();

  const marker = `structured-readonly-${Date.now()}`;
  const startResponse = await page.request.post("/api/v1/ai/workbench/runs", {
    data: {
      agentId: analyst!.id,
      mode: "inspect",
      task: `请只读核对演示 CRM 中“林晓梅”的联系人和关联商机阶段。先调用 crm_search_contacts，再按搜索结果读取联系人或商机。不得修改或发送。最终必须调用 submit_workbench_result 提交一段简短中文 summary、真实读取记录的 UUID evidence、缺失信息和 nextStep。对已读取的联系人或商机，在对应 evidence.assertions 至少写一条工具结果中实际出现的安全字段和值（例如 is_blocked 或 status）；不要编造缺失字段。任务标识 ${marker}。`,
    },
  });
  expect(startResponse.ok(), `start status ${startResponse.status()}`).toBeTruthy();
  const started = (await startResponse.json()).data as { run_id: string };
  expect(started.run_id).toBeTruthy();

  type RunDetail = {
    status: string;
    error_code: string | null;
    budget: { tokenBudget: number };
    result_document: null | {
      revision: number;
      trust: string;
      summary: string;
      evidence: Array<{ sourceId: string; assertions?: Array<{ field: string; equals: string | number | boolean | null }> }>;
      missingInformation: string[];
    };
    events: Array<{ event_type: string; payload: Record<string, unknown> }>;
    proposals: unknown[];
  };
  const readDetail = async (): Promise<RunDetail> => {
    const response = await page.request.get(`/api/v1/ai/workbench/runs/${started.run_id}`);
    expect(response.ok()).toBeTruthy();
    return (await response.json()).data as RunDetail;
  };
  await expect.poll(async () => {
    return (await readDetail()).status;
  }, { timeout: 180_000, intervals: [1000, 2000, 3000] }).toMatch(/^(completed|partial|failed)$/);
  const detail = await readDetail();
  if (!detail.result_document) throw new Error(
    `structured_result_missing: run=${started.run_id} status=${detail.status} code=${detail.error_code} crmTools=${detail.events.filter((event) => event.event_type === "tool_completed").length}`,
  );
  expect(detail.result_document).toMatchObject({
    revision: 1,
    trust: "model_submitted",
    summary: expect.any(String),
  });
  expect(detail.result_document.summary.length).toBeGreaterThan(10);
  expect(detail.result_document.evidence.length).toBeGreaterThan(0);
  expect(detail.result_document.evidence.some((item) => (item.assertions?.length ?? 0) > 0))
    .toBe(true);
  expect(detail.status).toBe("partial");
  expect(detail.error_code).toBe("missing_material");
  expect(detail.events.map((event) => event.event_type)).toEqual(expect.arrayContaining([
    "run_started", "tool_completed", "usage_reported",
  ]));
  expect(detail.events.some((event) =>
    event.event_type === "model_decision" &&
      (event.payload.resultRecovery === "submitted" || event.payload.resultRecovery === "not_needed"),
  )).toBe(true);
  const usage = detail.events.find((event) => event.event_type === "usage_reported")?.payload;
  expect(usage).toMatchObject({ costCents: 0 });
  expect(typeof usage?.calls).toBe("number");
  expect(usage?.calls as number).toBeGreaterThanOrEqual(1);
  expect(typeof usage?.inputTokens).toBe("number");
  expect(typeof usage?.outputTokens).toBe("number");
  expect((usage?.inputTokens as number) + (usage?.outputTokens as number))
    .toBeLessThanOrEqual(detail.budget.tokenBudget);
  expect(detail.proposals).toHaveLength(0);
  const evaluationResponse = await page.request.get(
    `/api/v1/ai/workbench/runs/${started.run_id}/evaluation`,
  );
  expect(evaluationResponse.ok()).toBeTruthy();
  const evaluation = (await evaluationResponse.json()).data as {
    profileRevision: number;
    verdict: string;
    dimensions: Array<{ key: string; findings: Array<{
      code: string; evidence?: Record<string, string | number | boolean | null>;
    }> }>;
  };
  expect(evaluation.profileRevision).toBe(7);
  expect(evaluation.verdict).toBe("needs_review");
  const answerFindings = evaluation.dimensions.find((item) => item.key === "answer_quality")?.findings ?? [];
  expect(answerFindings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "structured_claims_not_independently_verified" }),
  ]));
  expect(answerFindings.some((item) => item.code === "structured_result_unobserved_evidence")).toBe(false);
  expect(answerFindings.some((item) => item.code === "structured_fact_assertion_mismatch")).toBe(false);
  expect(answerFindings.some((item) => item.code === "structured_fact_assertion_unverifiable")).toBe(false);
  expect(answerFindings.find((item) => item.code === "structured_claims_not_independently_verified")
    ?.evidence?.verifiedAssertions).toBeGreaterThan(0);
  console.info(`REAL_STRUCTURED_RESULT=${JSON.stringify({
    runId: started.run_id,
    status: detail.status,
    crmToolCalls: detail.events.filter((event) => event.event_type === "tool_completed").length,
    evidenceReferences: detail.result_document.evidence.length,
    verifiedAssertions: answerFindings.find((item) => item.code === "structured_claims_not_independently_verified")
      ?.evidence?.verifiedAssertions,
    missingItems: detail.result_document.missingInformation.length,
    tokenBudget: detail.budget.tokenBudget,
    tokensUsed: (usage?.inputTokens as number) + (usage?.outputTokens as number),
    modelCalls: usage?.calls,
    evalVerdict: evaluation.verdict,
  })}`);
});
