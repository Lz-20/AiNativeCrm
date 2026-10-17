import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FeishuBinding } from "./_feishu-binding";

afterEach(() => vi.unstubAllGlobals());

describe("Feishu identity binding in the profile", () => {
  it("shows a one-time private-DM instruction and clears it after binding", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: {
        available: true, tenantBound: true, userBound: false, canClaimTenant: false,
      } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: {
        message: "CRM-BIND test-token", expiresAt: "2026-09-30T10:10:00Z",
      } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: {
        available: true, tenantBound: true, userBound: true, canClaimTenant: false,
      } }) });
    vi.stubGlobal("fetch", fetch);
    render(<FeishuBinding />);
    fireEvent.click(await screen.findByRole("button", { name: "绑定我的飞书账号" }));
    expect(await screen.findByText("CRM-BIND test-token")).toBeInTheDocument();
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ kind: "member" });
    fireEvent.click(screen.getByRole("button", { name: "刷新绑定状态" }));
    await waitFor(() => expect(screen.getByText("已绑定当前飞书账号")).toBeInTheDocument());
    expect(screen.queryByText("CRM-BIND test-token")).toBeNull();
  });
});
