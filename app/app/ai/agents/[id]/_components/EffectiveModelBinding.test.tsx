import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { EffectiveModelBinding } from "./EffectiveModelBinding";
import { TestPanel } from "./TestPanel";

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("./RunTrace", () => ({ RunTrace: () => null }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function show(element: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {element}
    </QueryClientProvider>,
  );
}
const summary = {
  bindingMode: "organization_default",
  source: "organization_default",
  provider: "anthropic",
  model: "org-model",
  credentialStatus: "matched",
};

describe("the editor shows the server's effective binding", () => {
  it("shows organization provider/model and source, not a stale draft tuple", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: summary });
    show(<EffectiveModelBinding agentId="agent" versionId="version" />);
    expect(await screen.findByText(/anthropic \/ org-model/)).toBeTruthy();
    expect(screen.getByText(/Modo de vínculo.*organization_default/)).toBeTruthy();
    expect(screen.getByText(/Provedor da credencial corresponde/)).toBeTruthy();
    expect(screen.queryByText(/deepseek-flash/)).toBeNull();
    expect(apiClient.post).not.toHaveBeenCalled();
  });
  it.each(["mismatch", "ambiguous", "unavailable"])(
    "shows %s as a blocking credential state",
    async (credentialStatus) => {
      vi.mocked(apiClient.get).mockResolvedValue({ data: { ...summary, credentialStatus } });
      show(<EffectiveModelBinding agentId="agent" versionId="version" />);
      expect(await screen.findByRole("alert")).toHaveTextContent("execução bloqueada");
    },
  );
  it("a failed test exposes only the safe code and correlation ID", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: summary });
    vi.mocked(apiClient.post).mockRejectedValue(
      new ApiError(422, "model_http_401", undefined, "request-synthetic", "safe failure"),
    );
    show(
      <TestPanel
        agent={{ id: "agent" } as never}
        published={null}
        draft={
          {
            id: "version",
            status: "draft",
            version_number: 1,
            provider: "deepseek",
            model: "deepseek-flash",
          } as never
        }
      />,
    );
    await screen.findByText(/anthropic \/ org-model/);
    fireEvent.change(screen.getByLabelText("Mensagem do cliente (sample)"), {
      target: { value: "synthetic only" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Executar/ }));
    expect(await screen.findByText(/request-synthetic/)).toHaveTextContent("model_http_401");
    expect(screen.queryByText(/deepseek-flash/)).toBeNull();
  });
});
