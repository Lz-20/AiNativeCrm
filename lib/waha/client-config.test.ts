import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWahaClient, WahaClient } from "./client";
import { sendWAHA } from "./send";

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("canal ausente antes do primeiro envio", () => {
  it.each([undefined, "", "   "])(
    "configuração vazia (%s) não constrói cliente nem usa URL relativa",
    (valor) => {
      vi.stubEnv("WAHA_API_BASE_URL", valor);
      vi.stubEnv("WAHA_API_KEY", valor);
      expect(getWahaClient()).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["", "key"],
    ["http://messaging.example.invalid", ""],
    ["   ", "key"],
  ])("construção direta com configuração incompleta recusa antes da rede", (url, key) => {
    expect(() => new WahaClient(url, key)).toThrow("waha_not_configured");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("envio direto sem transporte devolve erro, nunca recibo vazio de sucesso", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "");
    vi.stubEnv("WAHA_API_KEY", "");
    await expect(
      sendWAHA({ sessionName: "fixture", chatId: "fixture", text: "fixture" }),
    ).rejects.toThrow("waha_not_configured");
    expect(fetch).not.toHaveBeenCalled();
  });
});
