import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EmbeddingConfigurationPanel } from "./EmbeddingConfigurationPanel";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: { configuration: null, credential: null } });
  api.put.mockResolvedValue({}); api.post.mockResolvedValue({});
});
afterEach(cleanup);
function panel(canWrite = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><EmbeddingConfigurationPanel canWrite={canWrite}
    onConfigured={vi.fn()} onRefresh={vi.fn()} /></QueryClientProvider>);
}
describe("embedding configuration has no automatic paid side effects", () => {
  it("loads metadata only and defaults to SiliconFlow BGE-M3/1024", async () => {
    panel();
    await screen.findByText("Embedding：尚未单独配置");
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://api.siliconflow.cn/v1");
    expect(screen.getByLabelText("Model")).toHaveValue("BAAI/bge-m3");
    expect(screen.getByLabelText("Dimensions")).toHaveValue("1024");
    expect(api.put).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  });
  it("saving a key does not validate or start indexing and clears the field", async () => {
    panel(); await screen.findByText("Embedding：尚未单独配置");
    const field = screen.getByLabelText("API Key（仅新建或更换时填写）");
    expect(field).toHaveAttribute("type", "password");
    fireEvent.change(field, { target: { value: "synthetic-ui-credential" } });
    fireEvent.click(screen.getByText("保存配置（不调用API）"));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put.mock.calls[0]?.[1]).toMatchObject({ enabled: false, provider: "siliconflow", dimensions: 1024 });
    expect(field).toHaveValue(""); expect(api.post).not.toHaveBeenCalled();
  });
  it("read-only users have no credential mutation controls", async () => {
    panel(false); await screen.findByText("Embedding：尚未单独配置");
    expect(screen.queryByLabelText("API Key（仅新建或更换时填写）")).toBeNull();
    expect(api.put).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  });
  it("only an explicit validation click confirms cost on a staged configuration", async () => {
    api.get.mockResolvedValue({ data: { configuration: { provider: "bailian", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "text-embedding-v4", dimensions: 1536, model_revision: "1", version: "v1", enabled: false }, credential: null } });
    panel(); await screen.findByText("Embedding：bailian / text-embedding-v4 / 1536");
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("验证Embedding（调用供应商，可能计费）"));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0]?.[1]).toEqual({ confirm_cost: true });
    expect(api.put).not.toHaveBeenCalled();
  });
  it("requires saving edits before a paid validation can target them", async () => {
    api.get.mockResolvedValue({ data: { configuration: { provider: "siliconflow", base_url: "https://api.siliconflow.cn/v1",
      model: "BAAI/bge-m3", dimensions: 1024, model_revision: "1", version: "v1", enabled: false }, credential: null } });
    panel(); await screen.findByText("Embedding：siliconflow / BAAI/bge-m3 / 1024");
    fireEvent.change(screen.getByLabelText("Model revision"), { target: { value: "2" } });
    expect(screen.getByText("验证Embedding（调用供应商，可能计费）")).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });
});
