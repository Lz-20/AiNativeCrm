import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireAuthMock, resolveActiveOrgMock, redirectMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActiveOrgMock: vi.fn(),
  redirectMock: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));
vi.mock("@/lib/auth/server", () => ({
  requireAuth: requireAuthMock,
  resolveActiveOrg: resolveActiveOrgMock,
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("./_components/PainelDeProvedores", () => ({
  PainelDeProvedores: () => <div>Provedores</div>,
}));
vi.mock("@/components/ai/AgentIntegrationsPanel", () => ({
  AgentIntegrationsPanel: ({
    canManageIntegrations,
    canReconcileCleanup,
  }: {
    canManageIntegrations: boolean;
    canReconcileCleanup: boolean;
  }) => (
    <div
      data-testid="integrations"
      data-manage={canManageIntegrations}
      data-cleanup={canReconcileCleanup}
    />
  ),
}));

import ProvedoresPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockResolvedValue({ id: "operator", support: null });
});

describe("providers page integration capabilities", () => {
  it.each([
    { role: "manager", canManage: "false" },
    { role: "admin", canManage: "true" },
  ])(
    "derives $role capabilities from the trusted active organization",
    async ({ role, canManage }) => {
      const user = { id: "operator", support: null };
      requireAuthMock.mockResolvedValue(user);
      resolveActiveOrgMock.mockResolvedValue({ role, orgId: "organization" });
      render(await ProvedoresPage());
      expect(resolveActiveOrgMock).toHaveBeenCalledWith(user);
      expect(screen.getByTestId("integrations")).toHaveAttribute("data-manage", canManage);
      expect(screen.getByTestId("integrations")).toHaveAttribute("data-cleanup", "true");
      expect(redirectMock).not.toHaveBeenCalled();
    },
  );

  it("keeps readonly support blocked at the page with its resolved viewer role", async () => {
    requireAuthMock.mockResolvedValue({
      support: { status: "active", access_mode: "support_readonly" },
    });
    resolveActiveOrgMock.mockResolvedValue({ role: "viewer", orgId: "organization" });
    await expect(ProvedoresPage()).rejects.toThrow("redirect:/403");
    expect(screen.queryByTestId("integrations")).not.toBeInTheDocument();
  });

  it("defensively disables all mutations for readonly support even if given an admin role", async () => {
    requireAuthMock.mockResolvedValue({
      support: { status: "active", access_mode: "support_readonly" },
    });
    resolveActiveOrgMock.mockResolvedValue({ role: "admin", orgId: "organization" });
    render(await ProvedoresPage());
    expect(screen.getByTestId("integrations")).toHaveAttribute("data-manage", "false");
    expect(screen.getByTestId("integrations")).toHaveAttribute("data-cleanup", "false");
  });

  it("preserves admin controls for active full support", async () => {
    requireAuthMock.mockResolvedValue({ support: { status: "active", access_mode: "full" } });
    resolveActiveOrgMock.mockResolvedValue({ role: "admin", orgId: "organization" });
    render(await ProvedoresPage());
    expect(screen.getByTestId("integrations")).toHaveAttribute("data-manage", "true");
    expect(screen.getByTestId("integrations")).toHaveAttribute("data-cleanup", "true");
  });
});
