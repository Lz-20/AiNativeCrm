import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const route = vi.hoisted(() => ({ path: "/app/ai/workbench" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path }));
vi.mock("@/components/shell/Sidebar", () => ({ Sidebar: () => <aside>全部 CRM 菜单</aside> }));
vi.mock("@/components/shell/TopBar", () => ({
  TopBar: () => (
    <header data-testid="topbar" className="sticky top-0">
      导航
    </header>
  ),
}));
vi.mock("@/components/shell/BarraDeProgressoNavegacao", () => ({
  BarraDeProgressoNavegacao: () => null,
}));
vi.mock("@/hooks/atendimento/useSinalDePresenca", () => ({ useSinalDePresenca: () => {} }));
vi.mock("@/hooks/notifications/useInboundMessageAlerts", () => ({
  useInboundMessageAlerts: () => {},
}));
vi.mock("@/hooks/notifications/useCrmAlerts", () => ({ useCrmAlerts: () => {} }));
vi.mock("@/hooks/calls/useInboundCallAlerts", () => ({ useInboundCallAlerts: () => {} }));
vi.mock("@/lib/notifications/notify_open", () => ({ useNotifyOpenFromServiceWorker: () => {} }));
import { ProvedorDaOcupacaoDoRodape } from "@/lib/ui/rodape-ocupado";
import { AppShell } from "@/app/app/_components/AppShell";

const observed: Element[] = [];
let disconnected = false;
let shellTop = 40;
let onResize: () => void;
class Observer {
  constructor(callback: () => void) {
    onResize = callback;
  }
  observe(el: Element) {
    observed.push(el);
  }
  disconnect() {
    disconnected = true;
  }
}
let viewport: EventTarget & { height: number; offsetTop: number };
beforeEach(() => {
  route.path = "/app/ai/workbench";
  observed.length = 0;
  disconnected = false;
  shellTop = 40;
  viewport = Object.assign(new EventTarget(), { height: 780, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("ResizeObserver", Observer);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return { top: this.hasAttribute("data-chat-first") ? shellTop : 0 } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function tree() {
  return (
    <ProvedorDaOcupacaoDoRodape>
      <div style={{ display: "contents" }}>
        <div data-testid="banner">连接提醒</div>
        <AppShell sidebarCollapsed={false} podeAtender={false}>
          <div>工作台</div>
        </AppShell>
      </div>
    </ProvedorDaOcupacaoDoRodape>
  );
}

describe("chat viewport shell containment (DOM contract, not browser geometry)", () => {
  it("uses available keyboard viewport, retains navigation, observes banner boxes and cleans up", () => {
    const { container, unmount } = render(tree());
    const shell = container.querySelector<HTMLElement>("[data-chat-first]")!;
    expect(shell.style.getPropertyValue("--workbench-viewport-height")).toBe("740px");
    expect(screen.getByRole("main")).toHaveClass("min-h-0", "overflow-hidden");
    expect(screen.getByText("全部 CRM 菜单")).toBeInTheDocument();
    expect(observed).toContain(screen.getByTestId("banner"));
    act(() => {
      viewport.height = 400;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(shell.style.getPropertyValue("--workbench-viewport-height")).toBe("360px");
    const anotherBanner = document.createElement("div");
    shell.parentElement!.insertBefore(anotherBanner, shell);
    shellTop = 80;
    act(() => {
      onResize();
    });
    expect(shell.style.getPropertyValue("--workbench-viewport-height")).toBe("320px");
    anotherBanner.remove();
    shellTop = 40;
    act(() => {
      onResize();
    });
    expect(shell.style.getPropertyValue("--workbench-viewport-height")).toBe("360px");
    unmount();
    expect(disconnected).toBe(true);
    expect(shell.style.getPropertyValue("--workbench-viewport-height")).toBe("");
  });
  it("keeps normal page scroll and the original sticky-header parent on other routes", () => {
    route.path = "/app/inbox";
    const { container } = render(tree());
    expect(container.querySelector("[data-chat-first]")).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("overflow-auto", "p-6");
    expect(screen.getByTestId("topbar").parentElement).toHaveClass("min-h-screen", "flex-col");
    expect(observed).toHaveLength(0);
  });
});
