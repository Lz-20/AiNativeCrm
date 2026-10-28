import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api/wrappers";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const { GET } = await import("@/app/api/v1/metrics/atrito/route");
const ORG = "22222222-2222-4222-8222-222222222222";
const rpc = vi.fn();
const eq = vi.fn();

function session(idioma: AuthUser["idioma"], locale: AuthUser["locale"] = null) {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, name: "Organização sintética", role: "agent" },
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      email: "fixture@example.test",
      full_name: null, avatar_url: null, is_platform_admin: false,
      organizations: [], locale, idioma,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  eq.mockReturnValue({ maybeSingle: async () => ({ data: null, error: null }) });
  vi.mocked(createClient).mockResolvedValue({ rpc } as unknown as Awaited<ReturnType<typeof createClient>>);
  vi.mocked(createAdminClient).mockReturnValue({
    from: () => ({ select: () => ({ eq }) }),
  } as unknown as ReturnType<typeof createAdminClient>);
});

describe("rótulos do atrito seguem o idioma já resolvido da sessão", () => {
  it.each([
    ["pt-BR", "Conversão", "Negócios ganhos"],
    ["es", "Conversión", "Negocios ganados"],
    ["zh-CN", "转化", "赢单商机"],
  ] as const)("herda %s da organização sem preferência pessoal", async (idioma, titulo, rotulo) => {
    session(idioma);
    const response = await GET(new NextRequest("http://localhost/api/v1/metrics/atrito"));
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.pares[0].titulo).toBe(titulo);
    expect(data.pares[0].eficiencia.rotulo).toBe(rotulo);
    expect(eq).toHaveBeenCalledWith("id", ORG);
    expect(rpc).toHaveBeenCalledWith("fn_atrito_metrics", expect.objectContaining({ p_org: ORG }));
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "metrics" }));
  });

  it("mantém a preferência pessoal já resolvida", async () => {
    session("es", "es");
    const response = await GET(new NextRequest("http://localhost/api/v1/metrics/atrito"));
    expect((await response.json()).data.pares[0].titulo).toBe("Conversión");
  });

  it("recusa acesso sem consultar o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden_role", "Negado", 403) });
    const response = await GET(new NextRequest("http://localhost/api/v1/metrics/atrito"));
    expect(response.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
