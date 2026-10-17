import { expect, test } from "@playwright/test";

test("真实模型运行持久化三个只读 specialist 并产生可评测父运行", async ({ page }) => {
  test.setTimeout(360_000);

  await page.goto("/login?next=%2Fapp%2Fai%2Fworkbench");
  await page.locator("#email").fill(process.env.CRM_DEMO_EMAIL ?? "demo@example.invalid");
  await page.locator("#password").fill(process.env.CRM_DEMO_PASSWORD ?? "PiNativeDemo!2026");
  await page.getByRole("button", { name: /登录|Entrar/ }).click();
  await page.waitForURL(/\/app\/ai\/workbench/, { timeout: 45_000 });

  await page.getByRole("button", { name: /CRM 主管 Agent/ }).click();
  const leadsResponse = await page.request.get(
    "/api/v1/ai/workbench/objects?kind=lead&q=%E6%9E%97%E6%99%93%E6%A2%85",
  );
  expect(leadsResponse.ok()).toBeTruthy();
  const leads = (await leadsResponse.json()).data as Array<{ id: string; label: string }>;
  const lead = leads.find((item) => item.label.includes("林晓梅"));
  expect(lead).toBeTruthy();
  await page.getByLabel("CRM 对象类型").selectOption("lead");
  const objectResults = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/v1/ai/workbench/objects" && url.searchParams.get("q") === "林晓梅"
    );
  });
  await page.getByLabel("搜索 CRM 对象").fill("林晓梅");
  await objectResults;
  await page
    .getByRole("button", { name: new RegExp(lead!.label) })
    .first()
    .click();
  await page.locator("#run-mode").selectOption("inspect");
  await page
    .locator("textarea")
    .fill(
      "请对当前选中的商机做一次完整审查：核对客户沟通事实、商机阶段与跟进风险，并查询‘商机成交审批政策’。综合独立证据给出事实、冲突、缺失材料和下一步建议。如果知识库没有证据，必须明确写出知识缺口。只读，不要修改 CRM。",
    );

  const startPromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/ai/workbench/runs") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "运行 Agent" }).click();
  const startResponse = await startPromise;
  expect(startResponse.ok()).toBeTruthy();
  const started = (await startResponse.json()).data as { run_id: string };

  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/v1/ai/workbench/runs/${started.run_id}`);
        if (!response.ok()) return "unavailable";
        return ((await response.json()).data as { status: string }).status;
      },
      { timeout: 330_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toMatch(/^(completed|partial|failed)$/);

  const detailResponse = await page.request.get(`/api/v1/ai/workbench/runs/${started.run_id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()).data as {
    status: string;
    final_text: string | null;
    error_code: string | null;
    events: Array<{ sequence: number; event_type: string; payload: Record<string, unknown> }>;
    proposals: Array<{ tool_name: string; status: string }>;
    specialists: Array<{ id: string; specialist_key: string; status: string }>;
  };
  const deterministicResponse = await page.request.get(
    `/api/v1/ai/workbench/runs/${started.run_id}/evaluation`,
  );
  expect(deterministicResponse.ok()).toBeTruthy();
  const deterministicEvaluation = (await deterministicResponse.json()).data as {
    verdict: string;
    score: number | null;
    profileKey: string;
    dimensions: Array<{ key: string; verdict: string; findings: unknown[] }>;
    summary: Record<string, number>;
    semanticJudge: { status: string };
  };
  expect(deterministicEvaluation.semanticJudge.status).toBe("not_configured");
  const semanticResponse = await page.request.post(
    `/api/v1/ai/workbench/runs/${started.run_id}/evaluation`,
  );
  expect(semanticResponse.ok()).toBeTruthy();
  const evaluation = (await semanticResponse.json()).data as typeof deterministicEvaluation & {
    cached: boolean;
  };

  const completedTools = detail.events
    .filter((event) => event.event_type === "tool_completed")
    .map((event) => ({ tool: event.payload.tool, status: event.payload.status }));
  const eventTypes = detail.events.map((event) => event.event_type);
  console.info(
    `REAL_AGENT_EVAL_RESULT=${JSON.stringify({
      runId: started.run_id,
      status: detail.status,
      errorCode: detail.error_code,
      finalText: detail.final_text,
      completedTools,
      eventTypes,
      proposals: detail.proposals,
      specialists: detail.specialists,
      deterministicEvaluation,
      evaluation,
    })}`,
  );

  expect(["completed", "partial"]).toContain(detail.status);
  expect(detail.final_text?.trim().length ?? 0).toBeGreaterThan(0);
  expect(detail.final_text).not.toMatch(/now produce (?:the )?final answer/i);
  expect(detail.final_text).not.toMatch(/^now\b/i);
  expect(detail.final_text).not.toMatch(/write it in (?:chinese|english)/i);
  expect(detail.final_text).not.toMatch(/(?:^|\n)(?:let me|i should|format:\s*report)\b/i);
  if (detail.status === "partial") expect(detail.error_code).toBe("answer_likely_truncated");
  expect(detail.specialists.map((item) => item.specialist_key).sort()).toEqual(
    ["customer_evidence", "opportunity_diagnosis", "policy_advisor"].sort(),
  );
  expect(detail.specialists.every((item) => ["completed", "partial"].includes(item.status))).toBe(
    true,
  );
  expect(eventTypes).toEqual(
    expect.arrayContaining([
      "collaboration_started",
      "specialist_started",
      "specialist_completed",
      "collaboration_completed",
    ]),
  );
  expect(evaluation.profileKey).toBe("crm_supervisor_v1");
  expect(evaluation.summary.specialistRuns).toBe(3);
  expect(evaluation.summary.structuredClaims).toBeGreaterThan(0);
  expect(evaluation.semanticJudge.status).toBe("completed");
});
