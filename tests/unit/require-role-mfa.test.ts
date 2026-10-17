/**
 * MFA como política de SESSÃO no `requireRole` (relatório de segurança da
 * comunidade).
 *
 * O gate de MFA vivia em `app/app/layout.tsx`, e layout não roda em rota de
 * API: uma sessão `aal1` de admin com TOTP cadastrado alcançava as rotas
 * gateadas por `requireRole("admin")` — token de API, convite de equipe, LGPD.
 *
 * Aqui o `@/lib/auth/server` é mockado só em `loadAuthUser`/`resolveActiveOrg`;
 * `mfaEmDivida`, `sessionAal`, `isMfaEnrolled` e `requiresMfa` são os REAIS,
 * sobre um cliente Supabase stub. Mockar `mfaEmDivida` aqui seria testar o
 * mock — é justamente essa função que precisa ser exercitada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import type { AuthUser, Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...real, loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

interface Cenario {
  role: Role;
  temFator: boolean;
  aal: "aal1" | "aal2";
  isPlatformAdmin?: boolean;
}

function montarStub({ role, temFator, aal }: Cenario) {
  return {
    rpc: vi.fn(async () => ({ data: role, error: null })),
    auth: {
      mfa: {
        listFactors: vi.fn(async () => ({
          data: { totp: temFator ? [{ id: "f1", status: "verified" }] : [] },
          error: null,
        })),
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: aal, nextLevel: temFator ? "aal2" : aal },
          error: null,
        })),
      },
    },
  };
}

function preparar(cenario: Cenario): void {
  const user: AuthUser = {
    id: USER_ID,
    email: "admin@teste.local",
    is_platform_admin: cenario.isPlatformAdmin ?? false,
    organizations: [],
  } as unknown as AuthUser;

  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: cenario.role });
  vi.mocked(createClient).mockResolvedValue(
    montarStub(cenario) as unknown as Awaited<ReturnType<typeof createClient>>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireRole — MFA é política de sessão, não de cadastro", () => {
  it("admin com fator cadastrado e sessão aal1 é BARRADO (o achado)", async () => {
    preparar({ role: "admin", temFator: true, aal: "aal1" });
    const r = await requireRole("admin", { requestId: "req-1" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      const corpo = (await r.response.json()) as { error: { code: string } };
      expect(corpo.error.code).toBe("mfa_required");
    }
  });

  it("CONTROLE POSITIVO: o MESMO admin com sessão aal2 PASSA", async () => {
    preparar({ role: "admin", temFator: true, aal: "aal2" });
    const r = await requireRole("admin", { requestId: "req-2" });
    expect(r.ok).toBe(true);
  });

  it("admin que ainda NÃO cadastrou fator passa — senão não conseguiria cadastrar", async () => {
    // Sem esta exceção o primeiro login de todo admin novo termina trancado do
    // lado de fora, inclusive das rotas necessárias para enrolar o TOTP.
    preparar({ role: "admin", temFator: false, aal: "aal1" });
    const r = await requireRole("admin", { requestId: "req-3" });
    expect(r.ok).toBe(true);
  });

  it("QUEM TEM FATOR PROVA — mesmo num papel que a política não obriga", async () => {
    // ⚠️ ESTE CASO INVERTEU, e a inversão APERTA a regra em vez de afrouxá-la.
    //
    // Antes, `mfaEmDivida` começava perguntando a política
    // (`requiresMfa(role, …)`), então um manager que cadastrou a verificação por
    // vontade própria tinha o fator IGNORADO na sessão — o mesmo que não ter.
    // Passava batido porque o cadastro era obrigatório justo para os papéis que
    // a política cobria; com o cadastro virando opcional, isso viraria o buraco
    // central: quem ligasse a proteção não estaria protegido.
    //
    // Cadastrar e provar são perguntas diferentes. Quem TEM fator prova, sempre.
    preparar({ role: "manager", temFator: true, aal: "aal1" });
    const r = await requireRole("manager", { requestId: "req-4" });
    expect(r.ok).toBe(false);
  });

  it("e quem NÃO tem fator não é cobrado, qualquer que seja o papel", async () => {
    // A outra metade da regra: a dívida é de quem tem o que provar.
    for (const role of ["admin", "manager", "viewer"] as const) {
      preparar({ role, temFator: false, aal: "aal1" });
      const r = await requireRole(role, { requestId: `req-4-${role}` });
      expect(r.ok, role).toBe(true);
    }
  });

  it("platform admin em aal1 com fator é BARRADO — agora por TER fator", async () => {
    // O desfecho é o mesmo de antes; o motivo mudou. Antes ele vinha de
    // `requiresMfa` cobrir platform admin; agora vem de ele ter um fator para
    // provar — e o desfecho seria o mesmo se ele fosse um viewer comum.
    preparar({ role: "viewer", temFator: true, aal: "aal1", isPlatformAdmin: true });
    const r = await requireRole("viewer", { requestId: "req-5" });
    expect(r.ok).toBe(false);
  });

  it("falta de PAPEL continua respondendo forbidden_role, não mfa_required", async () => {
    // A ordem importa: quem nem tem papel para chegar lá não deve descobrir,
    // pela resposta, o estado de MFA de ninguém.
    preparar({ role: "viewer", temFator: true, aal: "aal1" });
    const r = await requireRole("admin", { requestId: "req-6" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const corpo = (await r.response.json()) as { error: { code: string } };
      expect(corpo.error.code).toBe("forbidden_role");
    }
  });
});
