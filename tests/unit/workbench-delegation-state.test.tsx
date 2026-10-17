import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentCrmWorkbench } from "@/app/app/ai/workbench/_components/AgentCrmWorkbench";

const initialLead = { id: "lead-1", title: "商机一", pipelineId: "pipeline-1" };
const agents = [
  {
    id: "agent-1",
    name: "演示 Agent",
    description: null,
    builtinKey: "demo",
    scenarios: [],
  },
];
const task = "检查商机的下一步";
const taskPlaceholder = "例如：找出停滞商机并建议明天的跟进计划…";
const missionLabel = "建立商机业务任务";
const submissions: Record<string, unknown>[] = [];

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  submissions.length = 0;
  // All requests are handled in memory; an unexpected request fails the test.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/ai/workbench/runs") {
        if (init?.method === "POST") {
          submissions.push(JSON.parse(String(init.body)));
          return json({ run_id: "run-1" });
        }
        return json([]);
      }
      if (url === "/api/v1/ai/workbench/runs/run-1") {
        return json({
          id: "run-1",
          agent_id: "agent-1",
          task,
          mode: "inspect",
          status: "completed",
          final_text: "检查完成",
          error_code: null,
          created_at: "2026-10-01T00:00:00Z",
          events: [],
          proposals: [],
          specialists: [],
        });
      }
      if (url === "/api/v1/ai/workbench/runs/run-1/evaluation") return json(null);
      if (url.startsWith("/api/v1/ai/workbench/objects?")) {
        const kind = new URL(url, "http://localhost").searchParams.get("kind");
        return json(
          kind === "lead"
            ? [{ id: "lead-2", label: "商机二", pipelineId: "pipeline-1" }]
            : [{ id: "contact-1", label: "联系人一" }],
        );
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderWorkbench(withLead = true) {
  render(
    <AgentCrmWorkbench
      agents={agents}
      modelConfigured
      canCopy={false}
      initialLead={withLead ? initialLead : undefined}
    />,
  );
  return userEvent.setup();
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "任务设置" }));
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  if (screen.queryByRole("dialog")) await user.keyboard("{Escape}");
  await user.type(screen.getByPlaceholderText(taskPlaceholder), task);
  await user.click(screen.getByRole("button", { name: "运行 Agent" }));
  await waitFor(() => expect(submissions).toHaveLength(1));
  await waitFor(() => expect(screen.getByPlaceholderText(taskPlaceholder)).toHaveValue(""));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  return submissions[0]!;
}

describe("Workbench delegation follows the visible mode and CRM object", () => {
  it("runs the default read-only flow without a mission", async () => {
    const user = renderWorkbench(false);
    const body = await submit(user);
    expect(body).toMatchObject({ mode: "inspect", task });
    expect(body).not.toHaveProperty("mission");
    expect(body).not.toHaveProperty("scope");
  });

  it("runs read-only after leaving an initially delegated lead", async () => {
    const user = renderWorkbench();
    await user.selectOptions(screen.getByLabelText("执行模式"), "inspect");
    expect(screen.queryByLabelText(missionLabel)).not.toBeInTheDocument();
    const body = await submit(user);
    expect(body).toMatchObject({ mode: "inspect", scope: { leadId: "lead-1" } });
    expect(body).not.toHaveProperty("mission");
  });

  it("runs normally after clearing the delegated lead", async () => {
    const user = renderWorkbench();
    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "清除" }));
    expect(screen.queryByLabelText(missionLabel)).not.toBeInTheDocument();
    const body = await submit(user);
    expect(body.mode).toBe("act");
    expect(body).not.toHaveProperty("scope");
    expect(body).not.toHaveProperty("mission");
  });

  it("runs normally after changing from a lead to a contact", async () => {
    const user = renderWorkbench();
    await openSettings(user);
    await user.selectOptions(screen.getByLabelText("CRM 对象类型"), "contact");
    await user.click(await screen.findByRole("button", { name: "联系人一" }));
    const body = await submit(user);
    expect(body).toMatchObject({ mode: "act", scope: { contactId: "contact-1" } });
    expect(body).not.toHaveProperty("mission");
  });

  it("does not silently restore delegation when switching back to act", async () => {
    const user = renderWorkbench();
    await user.selectOptions(screen.getByLabelText("执行模式"), "inspect");
    await user.selectOptions(screen.getByLabelText("执行模式"), "act");
    await openSettings(user);
    expect(screen.getByLabelText(missionLabel)).not.toBeChecked();
    expect(screen.queryByLabelText("业务验收条件")).not.toBeInTheDocument();
    expect(await submit(user)).not.toHaveProperty("mission");
  });

  it("does not silently delegate another lead after clearing the original", async () => {
    const user = renderWorkbench();
    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "清除" }));
    await user.click(await screen.findByRole("button", { name: "商机二" }));
    expect(screen.getByLabelText(missionLabel)).not.toBeChecked();
    const body = await submit(user);
    expect(body).toMatchObject({ scope: { leadId: "lead-2" } });
    expect(body).not.toHaveProperty("mission");
  });

  it("still requires acceptance criteria for an explicitly delegated mission", async () => {
    const user = renderWorkbench();
    await openSettings(user);
    expect(screen.getByLabelText(missionLabel)).toBeChecked();
    await user.keyboard("{Escape}");
    await user.type(screen.getByPlaceholderText(taskPlaceholder), task);
    await user.click(screen.getByRole("button", { name: "运行 Agent" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("填写业务验收条件");
    expect(submissions).toHaveLength(0);
    await user.type(screen.getByLabelText("业务验收条件"), "客户确认下一步");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "运行 Agent" }));
    await waitFor(() => expect(submissions).toHaveLength(1));
    await waitFor(() => expect(screen.getByPlaceholderText(taskPlaceholder)).toHaveValue(""));
    expect(submissions[0]).toMatchObject({
      mode: "act",
      scope: { leadId: "lead-1" },
      mission: { goal: task, acceptanceCriteria: "客户确认下一步" },
    });
  });

  it("keeps ordinary lead execution available when delegation is unchecked", async () => {
    const user = renderWorkbench();
    await openSettings(user);
    await user.click(screen.getByLabelText(missionLabel));
    expect(await submit(user)).not.toHaveProperty("mission");
  });
});
