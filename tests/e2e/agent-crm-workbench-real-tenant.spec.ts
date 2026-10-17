import { expect, test } from "@playwright/test";

// This opt-in spec may display real CRM data and submits login credentials.
// Never keep browser traces, screenshots, or video artifacts for it.
test.use({ trace: "off", screenshot: "off", video: "off" });

const email = process.env.CRM_REAL_E2E_EMAIL;
const password = process.env.CRM_REAL_E2E_PASSWORD;
const contactQuery = process.env.CRM_REAL_E2E_CONTACT_QUERY;

test("CRM 情报员只读消费真实租户客户数据并持久化运行轨迹", async ({ page }) => {
  test.skip(
    !email || !password || !contactQuery,
    "set CRM_REAL_E2E_EMAIL, CRM_REAL_E2E_PASSWORD and CRM_REAL_E2E_CONTACT_QUERY for the isolated local CRM copy",
  );
  test.setTimeout(210_000);

  await page.goto("/login?next=%2Fapp%2Fai%2Fworkbench");
  await page.locator("#email").fill(email!);
  await page.locator("#password").fill(password!);
  await page.getByRole("button", { name: /登录|Entrar/ }).click();
  await page.waitForURL(/\/app\/ai\/workbench/, { timeout: 45_000 });

  await expect(page.getByRole("heading", { name: "Agent–CRM 工作台" })).toBeVisible();
  await page.getByLabel("内置 Agent").selectOption({ label: "CRM 情报员" });
  await page.getByRole("button", { name: "任务设置" }).click();
  await page.getByLabel("CRM 对象类型").selectOption("contact");

  const objectResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/v1/ai/workbench/objects" &&
      url.searchParams.get("kind") === "contact" &&
      url.searchParams.get("q") === contactQuery
    );
  });
  await page.getByLabel("搜索 CRM 对象").fill(contactQuery!);
  const response = await objectResponse;
  expect(response.ok()).toBeTruthy();
  const contacts = (await response.json()).data as Array<{ id: string; label: string }>;
  expect(contacts.length).toBeGreaterThan(0);
  await page.getByRole("button").filter({ hasText: contacts[0]!.label }).first().click();

  await expect(page.getByText(`目标对象：${contacts[0]!.label}`, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("#run-mode").selectOption("inspect");
  await page
    .locator("textarea")
    .fill(
      "只读取当前选中的联系人及其关联信息。必须调用 crm_get_contact 获取这个精确联系人的 CRM 记录；如果关联商机有助于回答，再用只读工具核实。总结可验证事实及数据来源。只读，不要修改 CRM、创建任务、发送消息或转交人工。",
    );

  const runResponsePromise = page.waitForResponse(
    (runResponse) =>
      runResponse.url().endsWith("/api/v1/ai/workbench/runs") &&
      runResponse.request().method() === "POST",
  );
  await page.getByRole("button", { name: "运行 Agent" }).click();
  const runResponse = await runResponsePromise;
  expect(runResponse.ok()).toBeTruthy();
  const run = (await runResponse.json()).data as { run_id: string };

  await expect
    .poll(
      async () => {
        const detailResponse = await page.request.get(`/api/v1/ai/workbench/runs/${run.run_id}`);
        if (!detailResponse.ok()) return "unavailable";
        return ((await detailResponse.json()).data as { status: string }).status;
      },
      { timeout: 180_000 },
    )
    .toBe("completed");

  const detailResponse = await page.request.get(`/api/v1/ai/workbench/runs/${run.run_id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = (await detailResponse.json()).data as {
    final_text: string | null;
    proposals: unknown[];
    events: Array<{ event_type: string; payload: Record<string, unknown> }>;
  };
  expect(detail.final_text?.trim().length ?? 0).toBeGreaterThan(0);
  expect(detail.proposals).toHaveLength(0);
  const eventTypes = detail.events.map((event) => event.event_type);
  expect(eventTypes).toEqual(
    expect.arrayContaining([
      "run_started",
      "context_loaded",
      "model_decision",
      "tool_completed",
      "run_completed",
      "usage_reported",
    ]),
  );
  expect(eventTypes).not.toContain("crm_state_changed");
  const completedTools = detail.events
    .filter((event) => event.event_type === "tool_completed")
    .map((event) => event.payload.tool);
  expect(completedTools).toContain("crm_get_contact");
});
