import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({ header: "pt-BR", saved: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "accept-language": context.header }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: context.saved ? { user_metadata: { locale: context.saved } } : null },
      }),
    },
  }),
}));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "Internal", logoUrl: null }),
}));
vi.mock("@/lib/branding", () => ({ marcaEhADoProduto: () => false }));
import PublicLayout from "@/app/(public)/layout";
import { useT } from "@/lib/i18n/IdiomaProvider";
function Probe() {
  return createElement("button", null, useT()("Entrar"));
}
async function markup() {
  return renderToStaticMarkup(await PublicLayout({ children: createElement(Probe) }));
}
describe("public form locale uses the server page resolution", () => {
  beforeEach(() => {
    context.header = "pt-BR";
    context.saved = null;
  });
  it("uses anonymous browser Portuguese instead of mixing a Chinese form with a Portuguese heading", async () => {
    expect(await markup()).toContain("<button>Entrar</button>");
  });
  it("uses anonymous Chinese", async () => {
    context.header = "zh-CN";
    expect(await markup()).toContain("<button>登录</button>");
  });
  it("preserves saved preference over the browser header", async () => {
    context.saved = "zh-CN";
    expect(await markup()).toContain("<button>登录</button>");
  });
});
