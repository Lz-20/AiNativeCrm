import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({ header: "pt-BR", user: null as null | { idioma: "pt-BR" | "zh-CN" } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "accept-language": context.header }) }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => context.user }));
import ForbiddenPage from "@/app/403/page";
describe("forbidden page locale", () => {
  beforeEach(() => { context.header = "pt-BR"; context.user = null; });
  it("uses the anonymous browser language", async () => {
    expect(renderToStaticMarkup(await ForbiddenPage())).toContain("403 — Sem permissão");
  });
  it("uses the resolved organization language instead of the installation default", async () => {
    context.header = "zh-CN"; context.user = { idioma: "pt-BR" };
    expect(renderToStaticMarkup(await ForbiddenPage())).toContain("403 — Sem permissão");
  });
  it("preserves a resolved Chinese user preference", async () => {
    context.user = { idioma: "zh-CN" };
    expect(renderToStaticMarkup(await ForbiddenPage())).toContain("403 — 无权限");
  });
});
