/**
 * O diálogo pedia "Provider / Label / API key" e nada mais. Quem nunca abriu
 * conta num provedor não sabia qual escolher nem onde a chave mora.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddCredentialDialog } from "./AddCredentialDialog";
import { apiClient } from "@/lib/api/client";
import { credentialsListQueryKey, type CredentialRow } from "@/hooks/ai/useCredentials";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../_actions", () => ({ refreshCredentialsView: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn() } }));

function montar() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AddCredentialDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("AddCredentialDialog — ajuda ao escolher", () => {
  it("mostra quando usar o provedor selecionado (Anthropic por padrão)", () => {
    montar();
    expect(screen.getByText(/padrão recomendado para conversar com o cliente/)).toBeInTheDocument();
  });

  it("linka para onde pegar a chave do provedor selecionado", () => {
    montar();
    expect(screen.getByRole("link", { name: /Pegar chave em/ })).toHaveAttribute(
      "href",
      "https://console.anthropic.com/settings/keys",
    );
  });

  it("placeholder da chave é o prefixo do provedor, não 'sk-...' genérico", () => {
    montar();
    expect(screen.getByLabelText(/API key/)).toHaveAttribute("placeholder", "sk-ant-…");
  });

  it("shows the server-confirmed safe row before the list refetch completes", async () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    const row: CredentialRow = {
      id: "server-created-id", organization_id: "org", provider: "anthropic",
      label: "Synthetic credential", api_key_last4: "test", validated_at: null,
      validation_error: null, models_available: null, is_active: true,
      created_by: "admin", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    client.setQueryData(credentialsListQueryKey, [{ ...row, id: "existing-id" }]);
    vi.mocked(apiClient.post).mockResolvedValue({ data: row });
    // A slow/refetching network must not hold back the acknowledged new card.
    vi.spyOn(client, "invalidateQueries").mockImplementation(() => new Promise(() => {}));
    const cancel = vi.spyOn(client, "cancelQueries");
    try {
      render(<QueryClientProvider client={client}><AddCredentialDialog open onOpenChange={() => {}} /></QueryClientProvider>);
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Nome"), { target: { value: row.label } });
        fireEvent.change(screen.getByLabelText("API key"), { target: { value: "synthetic-key-not-a-secret" } });
      });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar e validar" })); });
      expect(cancel).toHaveBeenCalledWith({ queryKey: credentialsListQueryKey });
      expect(client.getQueryData<CredentialRow[]>(credentialsListQueryKey)?.map((c) => c.id))
        .toEqual(["server-created-id", "existing-id"]);
      expect(JSON.stringify(client.getQueryData(credentialsListQueryKey))).not.toContain("synthetic-key-not-a-secret");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      client.clear();
    }
  });
});
