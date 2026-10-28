import { beforeEach, describe, expect, it, vi } from "vitest";

import { confirmMfaEnroll } from "@/app/actions/auth/confirmMfaEnroll";
import { useRecoveryCode as consumirCodigo } from "@/app/actions/auth/useRecoveryCode";
import { regenerateRecoveryCodes } from "@/app/actions/settings/regenerateRecoveryCodes";

const h = vi.hoisted(() => ({
  client: vi.fn(), admin: vi.fn(), audit: vi.fn(), configured: vi.fn(),
  redirect: vi.fn((url: string): never => { throw new Error(`redirect:${url}`); }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: h.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.admin }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, isServiceRoleConfigured: h.configured }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));

const USER = "40900000-0000-4000-8000-000000000001";
const CODE_ID = "40900000-0000-4000-8000-000000000002";

function fixture(aal: "aal1" | "aal2" = "aal2") {
  const insert = vi.fn(async () => ({ error: null as null | { message: string } }));
  const remove = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));
  const verify = vi.fn(async () => ({ error: null as null | { message: string } }));
  const session = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: USER } }, error: null })),
      mfa: {
        listFactors: vi.fn(async () => ({ data: { totp: [{ id: "totp", status: "verified" }] }, error: null })),
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: { currentLevel: aal }, error: null as null | { message: string } })),
        challenge: vi.fn(async () => ({ data: { id: "challenge" }, error: null })),
        verify,
      },
    },
    from: vi.fn(() => ({ insert, delete: remove })),
  };
  const admin = { from: vi.fn(() => ({ insert, delete: remove })) };
  h.client.mockResolvedValue(session);
  h.admin.mockReturnValue(admin);
  return { session, admin, insert, remove, verify };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.configured.mockReturnValue(true);
  h.audit.mockResolvedValue(undefined);
});

describe("recuperação MFA usa autoridade do servidor depois da prova do segundo fator", () => {
  it("AAL1 com TOTP cadastrado não roda a rotação privilegiada", async () => {
    const f = fixture("aal1");
    expect(await regenerateRecoveryCodes()).toEqual({ ok: false, error: "mfa_required" });
    expect(h.admin).not.toHaveBeenCalled();
    expect(f.session.from).not.toHaveBeenCalled();
  });

  it("erro ao verificar AAL também fecha a rotação", async () => {
    const f = fixture();
    f.session.auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: "aal2" }, error: { message: "invalid token" } });
    expect(await regenerateRecoveryCodes()).toEqual({ ok: false, error: "mfa_required" });
    expect(h.admin).not.toHaveBeenCalled();
  });

  it("AAL2 renova dez códigos do próprio usuário pelo admin", async () => {
    const f = fixture();
    const result = await regenerateRecoveryCodes();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.recovery_codes).toHaveLength(10);
    expect(f.insert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ user_id: USER })]));
    expect(f.session.from).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "mfa.recovery_codes_regenerated", actorUserId: USER }));
  });

  it("enrollment recém-verificado não depende de reler cookies AAL1 antigos", async () => {
    const f = fixture("aal1");
    const result = await confirmMfaEnroll("123456", "totp");
    expect(result.ok).toBe(true);
    expect(f.verify).toHaveBeenCalled();
    expect(f.insert).toHaveBeenCalledOnce();
    expect(f.session.from).not.toHaveBeenCalled();
    expect(f.session.auth.mfa.getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
    expect(f.verify.mock.invocationCallOrder[0]).toBeLessThan(f.insert.mock.invocationCallOrder[0]!);
  });

  it("TOTP inválido não gera nem grava códigos", async () => {
    const f = fixture();
    f.verify.mockResolvedValue({ error: { message: "bad code" } });
    expect(await confirmMfaEnroll("123456", "totp")).toMatchObject({ ok: false, error: "verify_failed" });
    expect(f.insert).not.toHaveBeenCalled();
  });

  it("falha de persistência não devolve códigos que nunca existiram", async () => {
    const f = fixture();
    f.insert.mockResolvedValue({ error: { message: "storage failed" } });
    expect(await confirmMfaEnroll("123456", "totp")).toMatchObject({ ok: false, error: "recovery_codes_failed" });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("sem service key não usa INSERT do browser nem verifica enrollment sem persistência disponível", async () => {
    const f = fixture();
    h.configured.mockReturnValue(false);
    expect(await confirmMfaEnroll("123456", "totp")).toMatchObject({ ok: false, error: "service_unavailable" });
    expect(await regenerateRecoveryCodes()).toMatchObject({ ok: false, error: "service_unavailable" });
    expect(f.session.from).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  });
});

describe("consumo é compare-and-set antes de remover fatores", () => {
  function recoveryFixture(updateFails = false, factorError?: "list" | "delete" | "throw", reason = "transport failed") {
    let used = false;
    const filters: Array<Record<string, unknown>> = [];
    const deletes = vi.fn(async () => {
      if (factorError === "throw") throw new Error(reason);
      return { error: factorError === "delete" ? { message: "delete failed" } : null };
    });
    const from = vi.fn(() => ({
      select: () => {
        const read = {
          eq: () => read, is: () => read, limit: () => read,
          maybeSingle: async () => ({ data: { id: CODE_ID, used_at: null }, error: null }),
        };
        return read;
      },
      update: () => {
        const predicates: Record<string, unknown> = {};
        filters.push(predicates);
        const update = {
          eq: (key: string, value: unknown) => { predicates[key] = value; return update; },
          is: (key: string, value: unknown) => { predicates[key] = value; return update; },
          select: () => update,
          maybeSingle: async () => {
            if (updateFails) return { data: null, error: { message: "write failed" } };
            if (used) return { data: null, error: null };
            used = true;
            return { data: { id: CODE_ID }, error: null };
          },
        };
        return update;
      },
    }));
    h.admin.mockReturnValue({ from, auth: { admin: {
      listUsers: async () => ({ data: { users: [{ id: USER, email: "user@invariant.test" }] }, error: null }),
      mfa: {
        listFactors: async () => ({ data: { factors: [{ id: "totp" }] }, error: factorError === "list" ? { message: "list failed" } : null }),
        deleteFactor: deletes,
      },
    } } });
    return { deletes, filters };
  }

  it("duas requisições que leram o mesmo código removem o fator uma vez", async () => {
    const f = recoveryFixture();
    const call = () => consumirCodigo({ email: "user@invariant.test", code: "ABCD1234" });
    const results = await Promise.allSettled([call(), call()]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1); // redirect do vencedor
    expect(results).toContainEqual({ status: "fulfilled", value: { ok: false, error: "invalid_or_used" } });
    expect(f.deletes).toHaveBeenCalledOnce();
    for (const filter of f.filters) expect(filter).toEqual({ id: CODE_ID, user_id: USER, code_hash: expect.any(String), used_at: null });
    expect(h.audit).toHaveBeenCalledOnce();
  });

  it("erro ao consumir não remove fator nem audita sucesso", async () => {
    const f = recoveryFixture(true);
    expect(await consumirCodigo({ email: "user@invariant.test", code: "ABCD1234" })).toEqual({ ok: false, error: "invalid_or_used" });
    expect(f.deletes).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each(["list", "delete", "throw"] as const)("falha %s nos fatores não anuncia recuperação concluída", async (failure) => {
    recoveryFixture(false, failure);
    expect(await consumirCodigo({ email: "user@invariant.test", code: "ABCD1234" })).toEqual({ ok: false, error: "service_unavailable" });
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.mfa_failed", actorUserId: USER,
      metadata: { stage: "recovery_factor_removal", recovery_code_consumed: true },
    }));
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "auth.recovery_code_used" }));
  });

  it("erro externo com segredo não aparece no log da recuperação", async () => {
    const secret = "SYNTHETIC_RECOVERY_SECRET_do_not_log";
    recoveryFixture(false, "throw", secret);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await consumirCodigo({ email: "user@invariant.test", code: "ABCD1234" });
      expect(error).toHaveBeenCalledOnce();
      const logged = error.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
      expect(logged).not.toContain(secret);
      expect(JSON.parse(logged)).toMatchObject({
        level: "error", msg: "auth.recovery_factor_removal_failed",
        requestId: null, error_code: "mfa_factor_cleanup_failed",
      });
    } finally { error.mockRestore(); }
  });
});
