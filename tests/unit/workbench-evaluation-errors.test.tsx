import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCrmWorkbench } from "@/app/app/ai/workbench/_components/AgentCrmWorkbench";

const agents = [
  {
    id: "a1",
    name: "情报员",
    description: "读取 CRM",
    builtinKey: "crm_intelligence",
    scenarios: [],
  },
];
const runId = "a0000000-0000-4000-8000-000000000004";
const record = (id = runId) => ({
  id,
  agent_id: "a1",
  task: `核对 ${id}`,
  mode: "inspect",
  status: "completed",
  final_text: `已完成 ${id}`,
  created_at: "2026-10-03T00:00:00Z",
  error_code: null,
  events: [],
  proposals: [],
  specialists: [],
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const report = {
  verdict: "needs_review",
  score: 70,
  profileKey: "crm",
  dimensions: [],
  summary: {
    toolCalls: 1,
    toolErrors: 0,
    knowledgeSearches: 0,
    groundedEvidenceItems: 0,
    specialistRuns: 0,
    specialistFailures: 0,
    structuredClaims: 0,
  },
  semanticJudge: { status: "not_run" },
};
const failure = (status = 503) => json({ error: { message: "暂时无法读取评测材料" } }, status);
function setup(evaluation: (url: string) => Promise<Response>, currentRecord = record) {
  window.history.replaceState(null, "", `/app/ai/workbench?run=${runId}`);
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== "GET")
      throw new Error("No write is allowed during an evaluation read retry");
    if (url.endsWith("/evaluation")) return evaluation(url);
    if (url.endsWith("/runs")) return json({ data: [currentRecord(), currentRecord("other-run")] });
    if (url.includes("/objects?")) return json({ data: [] });
    return json({ data: currentRecord(url.split("/").at(-1)) });
  });
  vi.stubGlobal("fetch", fetch);
  render(<AgentCrmWorkbench agents={agents} modelConfigured canCopy={false} />);
  return fetch;
}
async function openFailure() {
  await screen.findByText(`已完成 ${runId}`);
  fireEvent.click(screen.getByRole("button", { name: "评测暂不可用，查看原因并重试" }));
  return screen.findByRole("alert");
}
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("workbench evaluation read failures", () => {
  it.each([409, 500, 503])("shows %s without losing the completed run result", async (status) => {
    setup(async () => failure(status));
    expect(await openFailure()).toHaveTextContent("暂时无法读取评测材料");
    expect(screen.getByRole("button", { name: "重试读取评测" })).toBeEnabled();
    expect(screen.queryByTestId("agent-run-evaluation")).not.toBeInTheDocument();
    expect(screen.getAllByText(`已完成 ${runId}`).length).toBeGreaterThan(0);
  });
  it.each(["network", "invalid JSON"])(
    "keeps run details when evaluation fails with %s",
    async (mode) => {
      setup(async () => {
        if (mode === "network") throw new Error("offline");
        return new Response("<html>proxy error</html>", { status: 502 });
      });
      expect(await openFailure()).toHaveTextContent("无法读取评测");
      expect(screen.getAllByText(`已完成 ${runId}`).length).toBeGreaterThan(0);
    },
  );
  it("retries only the read, clears the error and restores evaluation controls", async () => {
    let attempts = 0;
    const fetch = setup(async () => (++attempts === 1 ? failure() : json({ data: report })));
    await openFailure();
    fireEvent.click(screen.getByRole("button", { name: "重试读取评测" }));
    await screen.findByTestId("agent-run-evaluation");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并投递确定性 Eval" })).toBeEnabled();
    expect(attempts).toBe(2);
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
  it("keeps active-run polling independent and enables manual retry after completion", async () => {
    let status = "running";
    setup(
      async () => failure(),
      (id = runId) => ({
        ...record(id),
        status,
        final_text: status === "completed" ? `已完成 ${id}` : "",
      }),
    );
    await screen.findByText("运行状态：running");
    fireEvent.click(screen.getByRole("button", { name: "评测暂不可用，查看原因并重试" }));
    expect(screen.getByRole("button", { name: "重试读取评测" })).toBeDisabled();
    expect(screen.getByText("运行期间会自动刷新评测，结束后可手动重试。")).toBeInTheDocument();
    status = "completed";
    await waitFor(
      () => expect(screen.getByRole("button", { name: "重试读取评测" })).toBeEnabled(),
      { timeout: 4000 },
    );
    expect(screen.getByText("运行状态：completed")).toBeInTheDocument();
  });
  it("ignores a delayed retry after starting a new conversation", async () => {
    let resolve!: (response: Response) => void;
    const delayed = new Promise<Response>((done) => {
      resolve = done;
    });
    let attempts = 0;
    setup(async () => (++attempts === 1 ? failure() : delayed));
    await openFailure();
    fireEvent.click(screen.getByRole("button", { name: "重试读取评测" }));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await act(async () => {
      resolve(failure(409));
      await delayed;
    });
    expect(screen.queryByText(`已完成 ${runId}`)).not.toBeInTheDocument();
    expect(screen.queryByText("暂时无法读取评测材料")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^运行详情/ }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("does not apply the old retry to a newer history selection", async () => {
    let resolve!: (response: Response) => void;
    const delayed = new Promise<Response>((done) => {
      resolve = done;
    });
    let attempts = 0;
    setup(async (url) =>
      url.includes("other-run") ? json({ data: report }) : ++attempts === 1 ? failure() : delayed,
    );
    await openFailure();
    fireEvent.click(screen.getByRole("button", { name: "重试读取评测" }));
    fireEvent.click(screen.getByRole("button", { name: /核对 other-run.*completed/ }));
    await screen.findByText("已完成 other-run");
    await act(async () => {
      resolve(failure(409));
      await delayed;
    });
    fireEvent.click(screen.getByRole("button", { name: /^运行详情/ }));
    expect(screen.getByTestId("agent-run-evaluation")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
