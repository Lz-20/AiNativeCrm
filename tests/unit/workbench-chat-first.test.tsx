import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentCrmWorkbench } from "@/app/app/ai/workbench/_components/AgentCrmWorkbench";

const agents = [
  {
    id: "a1",
    name: "情报员",
    description: "读取真实 CRM",
    builtinKey: "crm_intelligence",
    scenarios: [{ title: "找出停滞商机", task: "请检查停滞商机", harnessFocus: "CRM 证据" }],
  },
  { id: "a2", name: "主管", description: "运营分析", builtinKey: "crm_supervisor", scenarios: [] },
];
const submissions: Record<string, unknown>[] = [];
const writes: string[] = [];
const records = new Map<string, ReturnType<typeof detail>>();
let status = "completed";
let failRun = false;
let failDecision = false;
let cancelConflict = false;
function detail(id: string, task: string, state = status) {
  return {
    id,
    task,
    agent_id: "a1",
    mode: "inspect",
    status: state,
    final_text: state === "completed" ? `真实接口结果：${task}` : null,
    created_at: "2026-10-01T00:00:00Z",
    error_code: null,
    events: [
      {
        id: `${id}-event`,
        sequence: 1,
        event_type: "run_completed",
        payload: {},
        created_at: "2026-10-01T00:00:00Z",
      },
    ],
    proposals: [] as Array<{
      id: string;
      sequence: number;
      tool_name: string;
      status: string;
      preview: Record<string, unknown>;
      can_undo?: boolean;
    }>,
    specialists: [],
  };
}
function json(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  submissions.length = 0;
  writes.length = 0;
  records.clear();
  status = "completed";
  failRun = false;
  failDecision = false;
  cancelConflict = false;
  window.history.replaceState(null, "", "/app/ai/workbench");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") writes.push(url);
      if (url === "/api/v1/ai/workbench/runs") {
        if (init?.method === "POST") {
          if (failRun)
            return new Response(JSON.stringify({ error: { message: "暂时无法启动，请重试" } }), {
              status: 503,
            });
          const body = JSON.parse(String(init.body));
          submissions.push(body);
          const id = `r${submissions.length}`;
          records.set(id, detail(id, body.task));
          return json({ run_id: id });
        }
        return json([...records.values()]);
      }
      if (url.startsWith("/api/v1/ai/workbench/objects?")) return json([]);
      if (url.endsWith("/evaluation")) return json(null);
      const match = /^\/api\/v1\/ai\/workbench\/runs\/([^/]+)(.*)$/.exec(url);
      if (match) {
        const record = records.get(match[1]!)!;
        if (match[2] === "/cancel") {
          if (cancelConflict)
            return new Response(JSON.stringify({ error: { message: "run 已进入终态" } }), {
              status: 409,
            });
          record.status = "cancelled";
          return json({ status: "cancelled" });
        }
        if (match[2] === "/proposals/p1/decision") {
          if (failDecision)
            return new Response(JSON.stringify({ error: { message: "审批版本已改变，请重试" } }), {
              status: 409,
            });
          record.proposals[0]!.status =
            JSON.parse(String(init?.body)).decision === "approve" ? "executed" : "rejected";
          record.proposals[0]!.can_undo = record.proposals[0]!.status === "executed";
          record.status = "completed";
          return json({ run_status: "completed" });
        }
        if (match[2] === "/proposals/p1/undo") {
          record.proposals[0]!.status = "undone";
          record.proposals[0]!.can_undo = false;
          return json({ status: "undone" });
        }
        if (match[2] === "") return json(record);
      }
      throw new Error(`Unexpected offline request: ${url}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});
function setup(configured = true) {
  render(<AgentCrmWorkbench agents={agents} modelConfigured={configured} canCopy />);
  return userEvent.setup();
}
async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText("给 Agent 的任务"), text);
  await user.click(screen.getByRole("button", { name: "运行 Agent" }));
  await waitFor(() => expect(screen.getByLabelText("给 Agent 的任务")).toHaveValue(""));
  await waitFor(() => expect(screen.getByLabelText("给 Agent 的任务")).toBeEnabled());
}
async function openDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^运行详情/ }));
}

describe("chat-first workbench with real API contracts, entirely offline fixtures", () => {
  it("opens with a contained message region and visible composer; setup is a dismissible modal", async () => {
    const user = setup();
    expect(screen.getByRole("region", { name: "Agent 对话" })).toHaveClass(
      "min-h-0",
      "overflow-y-auto",
    );
    expect(screen.getByRole("form", { name: "发送 Agent 任务" })).toHaveClass("shrink-0");
    expect(screen.queryByLabelText("CRM 对象类型")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "任务设置" }));
    expect(screen.getByRole("dialog", { name: "任务设置" })).toBeInTheDocument();
    expect(screen.getByLabelText("CRM 对象类型")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制并定制" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("给 Agent 的任务")).toHaveFocus();
  });
  it("keeps two real results in the session without sending fake conversation memory", async () => {
    const user = setup();
    await send(user, "第一件事");
    await send(user, "第二件事");
    expect(screen.getByText("真实接口结果：第一件事")).toBeInTheDocument();
    expect(screen.getByText("真实接口结果：第二件事")).toBeInTheDocument();
    expect(submissions).toEqual([
      { agentId: "a1", task: "第一件事", mode: "inspect" },
      { agentId: "a1", task: "第二件事", mode: "inspect" },
    ]);
    await user.click(screen.getByRole("button", { name: "新对话" }));
    expect(screen.queryByText("真实接口结果：第一件事")).not.toBeInTheDocument();
    expect(screen.getByLabelText("执行模式")).toHaveValue("inspect");
    await openDetails(user);
    await user.click(screen.getByRole("button", { name: /第一件事.*completed/ }));
    expect(await screen.findByText("真实接口结果：第一件事")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(submissions).toHaveLength(2);
  });
  it("supports suggestions and Enter but protects Shift+Enter, Chinese composition and duplicate sends", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /找出停滞商机/ }));
    const input = screen.getByLabelText("给 Agent 的任务");
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(submissions).toHaveLength(0);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(submissions).toHaveLength(1);
  });
  it("does not call a model when one is missing and lets a failed submission retry", async () => {
    const user = setup(false);
    await user.type(screen.getByLabelText("给 Agent 的任务"), "检查");
    fireEvent.keyDown(screen.getByLabelText("给 Agent 的任务"), { key: "Enter" });
    expect(screen.getByRole("button", { name: "运行 Agent" })).toBeDisabled();
    expect(writes).toHaveLength(0);
  });
  it("preserves a failed draft and reports the failure beside the composer", async () => {
    const user = setup();
    failRun = true;
    await user.type(screen.getByLabelText("给 Agent 的任务"), "重试检查");
    await user.click(screen.getByRole("button", { name: "运行 Agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法启动");
    expect(screen.getByLabelText("给 Agent 的任务")).toHaveValue("重试检查");
    failRun = false;
    await user.click(screen.getByRole("button", { name: "运行 Agent" }));
    await waitFor(() => expect(screen.getByLabelText("给 Agent 的任务")).toHaveValue(""));
    expect(submissions).toHaveLength(1);
  });
  it.each(["approve", "reject"])(
    "retains proposal %s and undo without customer-send simulation",
    async (decision) => {
      const record = detail("history", "审批任务", "awaiting_confirmation");
      record.proposals = [
        {
          id: "p1",
          sequence: 1,
          tool_name: "crm_update_lead",
          status: "pending",
          preview: { changedFields: ["title"] },
        },
      ];
      records.set(record.id, record);
      const user = setup();
      await openDetails(user);
      await user.click(
        await screen.findByRole("button", { name: /审批任务.*awaiting_confirmation/ }),
      );
      expect(
        await screen.findByRole("button", { name: "查看 1 项待确认动作" }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "查看 1 项待确认动作" }));
      await user.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: decision === "approve" ? "批准执行" : "拒绝",
        }),
      );
      await waitFor(() =>
        expect(record.proposals[0]!.status).toBe(decision === "approve" ? "executed" : "rejected"),
      );
      if (decision === "approve") {
        await user.click(await screen.findByRole("button", { name: /撤销/ }));
        await waitFor(() => expect(record.proposals[0]!.status).toBe("undone"));
      }
      expect(writes).toContain("/api/v1/ai/workbench/runs/history/proposals/p1/decision");
    },
  );
  it("keeps stop accessible and prevents changing agents or starting another run while active", async () => {
    const record = detail("running", "进行中的任务", "running");
    records.set(record.id, record);
    const user = setup();
    await openDetails(user);
    await user.click(await screen.findByRole("button", { name: /进行中的任务.*running/ }));
    expect(await screen.findByRole("button", { name: "取消运行" })).toBeEnabled();
    expect(screen.getByLabelText("内置 Agent")).toBeDisabled();
    expect(screen.getByRole("button", { name: "新对话" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "取消运行" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "新对话" })).toBeEnabled());
    expect(record.status).toBe("cancelled");
    expect(writes).toEqual(["/api/v1/ai/workbench/runs/running/cancel"]);
  });
  it("switches agents without carrying delegation or stale messages", async () => {
    const user = setup();
    await send(user, "旧任务");
    await user.selectOptions(screen.getByLabelText("执行模式"), "act");
    await user.selectOptions(screen.getByLabelText("内置 Agent"), "a2");
    expect(screen.queryByText("真实接口结果：旧任务")).not.toBeInTheDocument();
    expect(screen.getByLabelText("执行模式")).toHaveValue("inspect");
    await send(user, "新任务");
    expect(submissions[1]).toMatchObject({ agentId: "a2", mode: "inspect" });
  });
  it("refreshes an active history run to completion without trapping the operator", async () => {
    const record = detail("active-history", "历史任务", "running");
    records.set(record.id, record);
    const user = setup();
    await openDetails(user);
    await user.click(await screen.findByRole("button", { name: /历史任务.*running/ }));
    expect(await screen.findByRole("button", { name: "取消运行" })).toBeEnabled();
    record.status = "completed";
    record.final_text = "历史任务已经完成";
    expect(await screen.findByText("历史任务已经完成", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新对话" })).toBeEnabled();
  });
  it("ignores delayed deep-link results after a new conversation", async () => {
    records.set("old", detail("old", "迟到的旧任务"));
    window.history.replaceState(null, "", "/app/ai/workbench?run=old");
    const original = globalThis.fetch;
    let release: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/v1/ai/workbench/runs/old"
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : original(input, init),
      ),
    );
    const user = setup();
    await user.click(screen.getByRole("button", { name: "新对话" }));
    await act(async () => {
      release!(json(records.get("old")));
    });
    expect(screen.queryByText("真实接口结果：迟到的旧任务")).not.toBeInTheDocument();
    expect(screen.getByText("今天想推进哪件事？")).toBeInTheDocument();
  });
  it("shows failed approval inside the modal and returns focus to its opener during an active run", async () => {
    const record = detail("failed-approval", "待审批", "awaiting_confirmation");
    record.proposals = [
      { id: "p1", sequence: 1, tool_name: "crm_update_lead", status: "pending", preview: {} },
    ];
    records.set(record.id, record);
    failDecision = true;
    const user = setup();
    await openDetails(user);
    await user.click(await screen.findByRole("button", { name: /待审批.*awaiting_confirmation/ }));
    await user.click(await screen.findByRole("button", { name: "查看 1 项待确认动作" }));
    await user.click(screen.getByRole("button", { name: "批准执行" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(
      "审批版本已改变",
    );
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /^运行详情/ })).toHaveFocus();
    expect(record.proposals[0]!.status).toBe("pending");
  });
  it("reconciles cancellation conflicts when a run finishes before the click", async () => {
    const record = detail("cancel-conflict", "即将结束", "running");
    records.set(record.id, record);
    const user = setup();
    await openDetails(user);
    await user.click(await screen.findByRole("button", { name: /即将结束.*running/ }));
    await screen.findByRole("button", { name: "取消运行" });
    record.status = "completed";
    cancelConflict = true;
    await user.click(screen.getByRole("button", { name: "取消运行" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "新对话" })).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent("已进入终态");
  });
  it("observes approval resolved in another tab instead of keeping a stale confirmation lock", async () => {
    const record = detail("elsewhere", "跨标签审批", "awaiting_confirmation");
    record.proposals = [
      { id: "p1", sequence: 1, tool_name: "crm_update_lead", status: "pending", preview: {} },
    ];
    records.set(record.id, record);
    const user = setup();
    await openDetails(user);
    await user.click(
      await screen.findByRole("button", { name: /跨标签审批.*awaiting_confirmation/ }),
    );
    await screen.findByRole("button", { name: "查看 1 项待确认动作" });
    record.status = "completed";
    record.proposals[0]!.status = "rejected";
    await waitFor(() => expect(screen.getByRole("button", { name: "新对话" })).toBeEnabled(), {
      timeout: 4_000,
    });
    expect(screen.queryByRole("button", { name: "查看 1 项待确认动作" })).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });
  it("retains acknowledged run identity and recovers from a failed detail read without resubmitting", async () => {
    const original = globalThis.fetch;
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/v1/ai/workbench/runs/r1" && first) {
          first = false;
          return Promise.reject(new Error("详情读取暂时失败"));
        }
        return original(input, init);
      }),
    );
    const user = setup();
    await user.type(screen.getByLabelText("给 Agent 的任务"), "已提交的任务");
    await user.click(screen.getByRole("button", { name: "运行 Agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("详情读取暂时失败");
    expect(screen.getByLabelText("给 Agent 的任务")).toHaveValue("");
    expect(screen.getByRole("button", { name: "取消运行" })).toBeEnabled();
    expect(
      await screen.findByText("真实接口结果：已提交的任务", {}, { timeout: 4_000 }),
    ).toBeInTheDocument();
    expect(submissions).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "新对话" }));
    await openDetails(user);
    expect(screen.getByRole("button", { name: /已提交的任务.*completed/ })).toBeInTheDocument();
  });
});

describe("real runtime evidence and evaluation visibility", () => {
  it("renders observed snippets, exact source links, index staleness and computed finding reasons", async () => {
    const record = detail("evidence-run", "核对政策");
    Object.assign(record, { observed_evidence: [{ id: "chunk", namespace: "organization_wiki", title: "交期 Wiki",
      excerpt: "交期需要负责人核实", source_id: "source", revision: "observed-index", revision_kind: "index_version",
      index_status: "superseded", uri: "/api/v1/ai/knowledge/sources/source/trechos?version_id=observed-index&chunk_id=chunk", position: 1 }] });
    records.set(record.id, record);
    const priorFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith("/evaluation")
      ? Promise.resolve(json({ verdict: "needs_review", score: 70, profileKey: "actual-profile",
        dimensions: [{ key: "knowledge_grounding", label: "知识依据", verdict: "needs_review", score: 50,
          findings: [{ code: "knowledge_evidence_empty", message: "需要核对引用版本。" }] }],
        summary: { toolCalls: 2, toolErrors: 0, knowledgeSearches: 1, groundedEvidenceItems: 1, specialistRuns: 0, specialistFailures: 0, structuredClaims: 0 },
        semanticJudge: { status: "not_run" } })) : priorFetch(input, init)));
    window.history.replaceState(null, "", "/app/ai/workbench?run=evidence-run");
    const user = setup();
    await screen.findByText("真实接口结果：核对政策");
    await openDetails(user);
    expect(screen.getByRole("region", { name: "实际读取的知识证据" })).toHaveTextContent("交期需要负责人核实");
    expect(screen.getByText(/索引已有更新，请重查/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看来源", hidden: true })).toHaveAttribute("href", "/api/v1/ai/knowledge/sources/source/trechos?version_id=observed-index&chunk_id=chunk");
    await user.click(screen.getByText(/知识依据 · needs_review/));
    expect(screen.getByText("需要核对引用版本。")).toBeVisible();
    expect(screen.getByText("knowledge_evidence_empty")).toBeVisible();
  });
});
