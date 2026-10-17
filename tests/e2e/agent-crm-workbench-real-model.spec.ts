import { expect, test, type Page } from "@playwright/test";

async function undoPriorReversibleChecks(page: Page): Promise<void> {
  const response = await page.request.get("/api/v1/ai/workbench/runs");
  expect(response.ok()).toBeTruthy();
  const runs = (await response.json()).data as Array<{ id: string; task: string }>;
  for (const run of runs.filter((item) => item.task.includes("[E2E reversible check]"))) {
    const detailResponse = await page.request.get(`/api/v1/ai/workbench/runs/${run.id}`);
    if (!detailResponse.ok()) continue;
    const detail = (await detailResponse.json()).data as {
      proposals: Array<{ id: string; tool_name: string; status: string }>;
    };
    for (const proposal of detail.proposals.filter(
      (item) => item.tool_name === "crm_update_lead" && item.status === "executed",
    )) {
      const undo = await page.request.post(
        `/api/v1/ai/workbench/runs/${run.id}/proposals/${proposal.id}/undo`,
      );
      expect(undo.ok(), `prior reversible run ${run.id} should be safely restored`).toBeTruthy();
    }
  }
}

/**
 * Local-only real-model path: login UI -> built-in agent -> durable queue ->
 * Pi tool call against synthetic demo CRM data -> persisted event replay.
 * The Playwright config refuses a non-loopback Supabase URL before this runs.
 */
test("CRM 情报员通过真实模型读取演示 CRM 并持久化完整运行轨迹", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/login?next=%2Fapp%2Fai%2Fworkbench");
  await page.locator("#email").fill(process.env.CRM_DEMO_EMAIL ?? "demo@example.invalid");
  await page.locator("#password").fill(process.env.CRM_DEMO_PASSWORD ?? "PiNativeDemo!2026");
  await page.getByRole("button", { name: /登录|Entrar/ }).click();
  await page.waitForURL(/\/app\/ai\/workbench/, { timeout: 45_000 });

  await expect(page.getByRole("heading", { name: "Agent–CRM 工作台" })).toBeVisible();
  await expect(
    page.getByText("Enter 发送 · Shift+Enter 换行 · 每次发送创建独立运行，CRM 提供上下文"),
  ).toBeVisible();
  await page.getByLabel("内置 Agent").selectOption({ label: "CRM 情报员" });
  await page.locator("#run-mode").selectOption("inspect");
  await page
    .locator("textarea")
    .fill(
      "请调用 crm_search_contacts 只读搜索工具，精确查找姓名‘林晓梅’，然后读取该联系人的资料和关联商机。报告 CRM 中能核实的姓名与商机阶段，并说明依据。只读，不要修改任何内容。",
    );
  await page.getByRole("button", { name: "运行 Agent" }).click();

  await expect(page.getByText(/运行状态：completed/)).toBeVisible({ timeout: 150_000 });

  const listResponse = await page.request.get("/api/v1/ai/workbench/runs");
  expect(listResponse.ok()).toBeTruthy();
  const listBody = await listResponse.json();
  const run = (listBody.data as Array<{ id: string; status: string }>)[0];
  if (!run) throw new Error("workbench_run_missing_from_history");
  expect(run?.status).toBe("completed");

  const detailResponse = await page.request.get(`/api/v1/ai/workbench/runs/${run.id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()).data as {
    final_text: string | null;
    events: Array<{ event_type: string; payload: Record<string, unknown> }>;
    proposals: Array<{ tool_name: string }>;
  };
  expect(detail.final_text?.trim().length ?? 0).toBeGreaterThan(0);
  expect(detail.events.map((event) => event.event_type)).toEqual(
    expect.arrayContaining([
      "run_started",
      "context_loaded",
      "model_decision",
      "tool_completed",
      "run_completed",
    ]),
  );
  const completedTools = detail.events
    .filter((event) => event.event_type === "tool_completed")
    .map((event) => event.payload.tool);
  expect(completedTools).toEqual(
    expect.arrayContaining(["crm_search_contacts", "crm_get_contact", "crm_list_leads"]),
  );
  expect(detail.proposals).toHaveLength(0);
  const usage = detail.events.find((event) => event.event_type === "usage_reported");
  expect(usage?.payload.calls).toBeGreaterThan(0);
});

test("销售运营 Agent 通过真实模型更新演示商机并使用业务补偿撤销", async ({ page }) => {
  test.setTimeout(240_000);

  await page.goto("/login?next=%2Fapp%2Fai%2Fworkbench");
  await page.locator("#email").fill(process.env.CRM_DEMO_EMAIL ?? "demo@example.invalid");
  await page.locator("#password").fill(process.env.CRM_DEMO_PASSWORD ?? "PiNativeDemo!2026");
  await page.getByRole("button", { name: /登录|Entrar/ }).click();
  await page.waitForURL(/\/app\/ai\/workbench/, { timeout: 45_000 });
  await undoPriorReversibleChecks(page);

  const seedResponse = await page.request.get(
    "/api/v1/ai/workbench/objects?kind=lead&q=%E6%9E%97%E6%99%93%E6%A2%85",
  );
  expect(seedResponse.ok()).toBeTruthy();
  const leads = (await seedResponse.json()).data as Array<{ id: string; label: string }>;
  const original = leads.find((lead) => lead.label.includes("林晓梅"));
  expect(original, "演示组织应有林晓梅的 CRM 商机").toBeTruthy();
  const temporaryTitle = `${original!.label} [E2E reversible check]`;

  await page.getByLabel("内置 Agent").selectOption({ label: "销售运营 Agent" });
  await page.getByRole("button", { name: "任务设置" }).click();
  await page.getByLabel("CRM 对象类型").selectOption("lead");
  const objectResults = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/v1/ai/workbench/objects" &&
      url.searchParams.get("kind") === "lead" &&
      url.searchParams.get("q") === "林晓梅"
    );
  });
  await page.getByLabel("搜索 CRM 对象").fill("林晓梅");
  await objectResults;
  const scopedLeadOption = page.getByRole("button", { name: `${original!.label} open` });
  await expect(scopedLeadOption).toBeVisible();
  await scopedLeadOption.click();
  await expect(page.getByText(`目标对象：${original!.label}`, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#run-mode").selectOption("act");
  await page
    .locator("textarea")
    .fill(
      `只处理当前选中的商机。先读取它，再仅把标题改为“${temporaryTitle}”。只允许调用 crm_update_lead 修改 title，不要改阶段、金额、联系人或其他字段，不要创建任务或发送消息。完成后报告改动字段。`,
    );
  const runResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/ai/workbench/runs") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "运行 Agent" }).click();
  const runResponse = await runResponsePromise;
  if (!runResponse.ok())
    throw new Error(
      `workbench_run_start_failed:${runResponse.status()}:request=${JSON.stringify(runResponse.request().postDataJSON())}:response=${JSON.stringify(await runResponse.json())}`,
    );
  await expect(page.getByText(/运行状态：(completed|partial|failed)/).first()).toBeVisible({
    timeout: 210_000,
  });

  const listResponse = await page.request.get("/api/v1/ai/workbench/runs");
  expect(listResponse.ok()).toBeTruthy();
  const runs = (await listResponse.json()).data as Array<{ id: string; status: string }>;
  const run = runs[0];
  const detailResponse = await page.request.get(`/api/v1/ai/workbench/runs/${run!.id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()).data as {
    events: Array<{ event_type: string; payload: Record<string, unknown> }>;
    proposals: Array<{
      id: string;
      tool_name: string;
      status: string;
      preview: { changedFields?: string[] };
    }>;
  };
  const proposal = detail.proposals.find((item) => item.tool_name === "crm_update_lead");
  const proposalStatusBeforeUndo = proposal?.status;
  if (proposal?.status === "executed") {
    const changedResponse = await page.request.get(
      "/api/v1/ai/workbench/objects?kind=lead&q=%5BE2E%20reversible%20check%5D",
    );
    expect(changedResponse.ok()).toBeTruthy();
    const changedLeads = (await changedResponse.json()).data as Array<{
      id: string;
      label: string;
    }>;
    expect(
      changedLeads.some((lead) => lead.id === original!.id && lead.label === temporaryTitle),
    ).toBeTruthy();

    const undoResponse = await page.request.post(
      `/api/v1/ai/workbench/runs/${run!.id}/proposals/${proposal.id}/undo`,
    );
    expect(undoResponse.ok()).toBeTruthy();
    expect((await undoResponse.json()).data.status).toBe("undone");
    const restoredResponse = await page.request.get(
      "/api/v1/ai/workbench/objects?kind=lead&q=%E6%9E%97%E6%99%93%E6%A2%85",
    );
    expect(restoredResponse.ok()).toBeTruthy();
    const restored = (await restoredResponse.json()).data as Array<{ id: string; label: string }>;
    expect(restored.find((lead) => lead.id === original!.id)?.label).toBe(original!.label);
  }

  expect(proposalStatusBeforeUndo).toBe("executed");
  expect(proposal?.preview.changedFields).toEqual(["title"]);
  expect(detail.events.map((event) => event.event_type)).toEqual(
    expect.arrayContaining(["policy_checked", "crm_state_changed", "run_resumed", "run_completed"]),
  );

  expect(run?.status).toBe("completed");
});

test("客户沟通 Agent 的转人工提案必须经确认，拒绝后安全续跑", async ({ page }) => {
  test.setTimeout(240_000);

  await page.goto("/login?next=%2Fapp%2Fai%2Fworkbench");
  await page.locator("#email").fill(process.env.CRM_DEMO_EMAIL ?? "demo@example.invalid");
  await page.locator("#password").fill(process.env.CRM_DEMO_PASSWORD ?? "PiNativeDemo!2026");
  await page.getByRole("button", { name: /登录|Entrar/ }).click();
  await page.waitForURL(/\/app\/ai\/workbench/, { timeout: 45_000 });

  const conversationsResponse = await page.request.get(
    "/api/v1/ai/workbench/objects?kind=conversation&q=%E6%BC%94%E7%A4%BA%E5%AE%A2%E6%88%B7",
  );
  expect(conversationsResponse.ok()).toBeTruthy();
  const conversations = (await conversationsResponse.json()).data as Array<{
    id: string;
    label: string;
  }>;
  const conversation = conversations.find((item) => item.label.includes("演示客户"));
  expect(conversation, "demo:seed 应准备一条停止外部渠道的合成会话").toBeTruthy();

  await page.getByLabel("内置 Agent").selectOption({ label: "客户沟通 Agent" });
  await page.getByRole("button", { name: "任务设置" }).click();
  await page.getByLabel("CRM 对象类型").selectOption("conversation");
  const objectResults = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/v1/ai/workbench/objects" && url.searchParams.get("q") === "演示客户"
    );
  });
  await page.getByLabel("搜索 CRM 对象").fill("演示客户");
  await objectResults;
  await page
    .getByRole("button", { name: new RegExp(conversation!.label) })
    .first()
    .click();
  await page.keyboard.press("Escape");
  await page.locator("#run-mode").selectOption("act");
  await page
    .locator("textarea")
    .fill(
      "当前选中的演示会话预览明确显示客户要求真人客服。必须调用 crm_request_human_handoff 为这个精确 conversation_id 创建待确认提案；reason 用 customer_requested_human，urgency 用 high，客户诉求用中文简洁概述，target_user_id 留空由系统路由。该工具在 Harness 批准前不会执行转交。不得只写建议，不要声称已经转交。",
    );
  const runResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/ai/workbench/runs") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "运行 Agent" }).click();
  const runResponse = await runResponsePromise;
  expect(runResponse.ok()).toBeTruthy();
  const run = (await runResponse.json()).data as { run_id: string };
  try {
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/v1/ai/workbench/runs/${run.run_id}`);
          if (!response.ok()) return "unavailable";
          return ((await response.json()).data as { status: string }).status;
        },
        { timeout: 210_000 },
      )
      .toMatch(/^(awaiting_confirmation|completed|partial|failed)$/);
  } catch (error) {
    const latest = await page.request.get(`/api/v1/ai/workbench/runs/${run.run_id}`);
    if (latest.ok()) {
      const current = (await latest.json()).data as { status: string };
      if (current.status === "running" || current.status === "queued")
        await page.request.post(`/api/v1/ai/workbench/runs/${run.run_id}/cancel`);
    }
    throw error;
  }
  const detailResponse = await page.request.get(`/api/v1/ai/workbench/runs/${run.run_id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()).data as {
    status: string;
    proposals: Array<{ id: string; tool_name: string; status: string }>;
    events: Array<{ event_type: string; payload: Record<string, unknown> }>;
  };
  expect(detail.status).toBe("awaiting_confirmation");
  const proposal = detail.proposals.find((item) => item.tool_name === "crm_request_human_handoff");
  expect(proposal?.status).toBe("pending");
  expect(detail.events.map((event) => event.event_type)).toContain("human_confirmation_requested");

  const decisionResponse = await page.request.post(
    `/api/v1/ai/workbench/runs/${run.run_id}/proposals/${proposal!.id}/decision`,
    { data: { decision: "reject", reason: "E2E 验证拒绝后不会触发 handoff" } },
  );
  expect(decisionResponse.ok()).toBeTruthy();
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/v1/ai/workbench/runs/${run.run_id}`);
        if (!response.ok()) return "unavailable";
        return ((await response.json()).data as { status: string }).status;
      },
      { timeout: 150_000 },
    )
    .toBe("completed");
  const finalResponse = await page.request.get(`/api/v1/ai/workbench/runs/${run.run_id}`);
  expect(finalResponse.ok()).toBeTruthy();
  const finalDetail = (await finalResponse.json()).data as typeof detail;
  expect(finalDetail.proposals.find((item) => item.id === proposal!.id)?.status).toBe("rejected");
  expect(finalDetail.events.map((event) => event.event_type)).toContain(
    "human_confirmation_received",
  );
  expect(finalDetail.events.map((event) => event.event_type)).not.toContain("crm_state_changed");
});

test("CRM 主管 Agent 通过真实模型交叉读取商机和跟进队列", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/login?next=%2Fapp%2Fai%2Fworkbench");
  await page.locator("#email").fill(process.env.CRM_DEMO_EMAIL ?? "demo@example.invalid");
  await page.locator("#password").fill(process.env.CRM_DEMO_PASSWORD ?? "PiNativeDemo!2026");
  await page.getByRole("button", { name: /登录|Entrar/ }).click();
  await page.waitForURL(/\/app\/ai\/workbench/, { timeout: 45_000 });

  await page.getByLabel("内置 Agent").selectOption({ label: "CRM 主管 Agent" });
  await page.locator("#run-mode").selectOption("inspect");
  await page
    .locator("textarea")
    .fill(
      "分别调用一次 crm_list_leads 和 crm_list_followups 获取概览，然后立即用两三句话总结一项有数据依据的运营风险。不要重复调用，不要修改 CRM。",
    );
  const runResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/ai/workbench/runs") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "运行 Agent" }).click();
  const runResponse = await runResponsePromise;
  expect(runResponse.ok()).toBeTruthy();
  const run = (await runResponse.json()).data as { run_id: string };
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/v1/ai/workbench/runs/${run.run_id}`);
        if (!response.ok()) return "unavailable";
        return ((await response.json()).data as { status: string }).status;
      },
      { timeout: 210_000 },
    )
    .toBe("completed");
  const detailResponse = await page.request.get(`/api/v1/ai/workbench/runs/${run.run_id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()).data as {
    final_text: string | null;
    proposals: Array<{ tool_name: string }>;
    events: Array<{ event_type: string; payload: Record<string, unknown> }>;
  };
  expect(detail.final_text?.trim().length ?? 0).toBeGreaterThan(0);
  expect(detail.proposals).toHaveLength(0);
  const calledTools = detail.events
    .filter((event) => event.event_type === "tool_completed")
    .map((event) => event.payload.tool);
  expect(calledTools).toEqual(expect.arrayContaining(["crm_list_leads", "crm_list_followups"]));
  expect(detail.events.map((event) => event.event_type)).toContain("usage_reported");
});
