import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AgentIntegrationsPanel } from "./AgentIntegrationsPanel";
import { CustomerMemoryPanel } from "./CustomerMemoryPanel";

const j = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const readiness = {
  providers: [
    { provider: "mem0", configured: true, enabled: true, revision: 2 },
    {
      provider: "weknora",
      configured: true,
      enabled: true,
      revision: 1,
      available_knowledge_bases: ["products"],
    },
    { provider: "langfuse", configured: true, enabled: false, revision: 0 },
  ],
  trace_delivery: [{ status: "dead", count: "2" }],
  cleanup_receipts: [{ id: "a0000000-0000-4000-8000-000000000002", write_outcome: "unknown" }],
};
function mockIntegrations() {
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    j({ data: init?.method ? {} : readiness }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function providerControls(provider: string) {
  return within(screen.getByText(provider).parentElement!.parentElement!);
}

afterEach(() => vi.unstubAllGlobals());
describe("real integration controls", () => {
  it("shows default-off readiness and does not offer activation without a trusted binding", async () => {
    const fetch = vi.fn(async () =>
      j({
        data: {
          providers: ["mem0", "weknora", "langfuse"].map((provider) => ({
            provider,
            configured: false,
            enabled: false,
            revision: 0,
          })),
          trace_delivery: [],
          cleanup_receipts: [],
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    render(<AgentIntegrationsPanel canManageIntegrations canReconcileCleanup />);
    expect(await screen.findByText("mem0")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button", { name: "启用" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("lets managers inspect readiness but disables every admin-only control without sending mutations", async () => {
    const fetch = mockIntegrations();
    render(<AgentIntegrationsPanel canManageIntegrations={false} canReconcileCleanup />);
    await screen.findByText("mem0");
    expect(screen.getByText(/仅限管理员/)).toBeInTheDocument();
    expect(screen.getByText("Trace 投递：dead: 2")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: /^(启用|暂停|重试失败投递)$/ })) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    const wikiName = screen.getByRole("textbox", { name: "Wiki 来源名称" });
    expect(wikiName).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "公司产品知识库" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /确认整个知识库/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "加入 Agent 知识来源" })).toBeDisabled();
    // Submission must also be guarded if it is triggered without clicking the disabled button.
    fireEvent.submit(wikiName.closest("form")!);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    { provider: "mem0", button: "暂停", enabled: false, revision: 2 },
    { provider: "langfuse", button: "启用", enabled: true, revision: 0 },
  ])(
    "lets admins $button $provider with the observed revision",
    async ({ provider, button, enabled, revision }) => {
      const fetch = mockIntegrations();
      render(<AgentIntegrationsPanel canManageIntegrations canReconcileCleanup />);
      await screen.findByText(provider);
      const toggle = providerControls(provider).getByRole("button", { name: button });
      expect(toggle).toBeEnabled();
      fireEvent.click(toggle);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
      expect(fetch).toHaveBeenNthCalledWith(2, "/api/v1/ai/integrations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, enabled, revision }),
      });
    },
  );

  it("lets admins retry failed deliveries", async () => {
    const fetch = mockIntegrations();
    render(<AgentIntegrationsPanel canManageIntegrations canReconcileCleanup />);
    await screen.findByText("mem0");
    const retry = providerControls("mem0").getByRole("button", { name: "重试失败投递" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/v1/ai/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "mem0", action: "retry_delivery" }),
    });
  });

  it("lets admins register an authorized Wiki source after confirming visibility", async () => {
    const fetch = mockIntegrations();
    render(<AgentIntegrationsPanel canManageIntegrations canReconcileCleanup />);
    await screen.findByText("weknora");
    const register = screen.getByRole("button", { name: "加入 Agent 知识来源" });
    expect(register).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Wiki 来源名称" }), {
      target: { value: "产品 Wiki" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "公司产品知识库" }), {
      target: { value: "products" },
    });
    expect(register).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /确认整个知识库/ }));
    expect(register).toBeEnabled();
    fireEvent.click(register);
    await screen.findByText(/Wiki 已加入知识来源/);
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/v1/ai/integrations/wiki/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: expect.any(String),
    });
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({
      id: expect.any(String),
      name: "产品 Wiki",
      knowledge_base_id: "products",
      whole_organization_visibility_confirmed: true,
    });
  });

  it.each([
    { role: "manager", canManageIntegrations: false },
    { role: "admin", canManageIntegrations: true },
  ])(
    "preserves customer-memory cleanup reconciliation for $role",
    async ({ canManageIntegrations }) => {
      const fetch = mockIntegrations();
      render(
        <AgentIntegrationsPanel
          canManageIntegrations={canManageIntegrations}
          canReconcileCleanup
        />,
      );
      const confirm = await screen.findByRole("checkbox", { name: "已在 Mem0 确认原请求结束" });
      const reconcile = screen.getByRole("button", { name: "核对清理结果" });
      expect(reconcile).toBeDisabled();
      expect(confirm).toBeEnabled();
      fireEvent.click(confirm);
      expect(reconcile).toBeEnabled();
      fireEvent.click(reconcile);
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
      expect(fetch).toHaveBeenNthCalledWith(2, "/api/v1/ai/customer-memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: readiness.cleanup_receipts[0]!.id,
          remote_request_settled: true,
        }),
      });
    },
  );

  it("does not offer cleanup or integration mutations to readonly sessions", async () => {
    const fetch = mockIntegrations();
    render(<AgentIntegrationsPanel canManageIntegrations={false} canReconcileCleanup={false} />);
    await screen.findByText("mem0");
    expect(screen.getByText(/当前为只读访问/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "已在 Mem0 确认原请求结束" })).toBeDisabled();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("same-content retry preserves the customer fact key after an ambiguous result", async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        if (init?.method === "POST") {
          posts.push(JSON.parse(init.body));
          return j({ error: { message: "保存结果未确认，请按相同键重试" } }, 503);
        }
        return j({ data: [] });
      }),
    );
    render(<CustomerMemoryPanel contactId="a0000000-0000-4000-8000-000000000001" />);
    const input = screen.getByRole("textbox", { name: "已确认的记忆内容" });
    fireEvent.change(input, { target: { value: "Prefers email" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认并保存" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认并保存" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]!.request_key).toBe(posts[1]!.request_key);
    expect(posts[0]).toMatchObject({
      confirmed: true,
      category: "preference",
      body: "Prefers email",
    });
  });
});
