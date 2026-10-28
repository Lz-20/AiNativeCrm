import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ session: vi.fn(), admin: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: h.session }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.admin }));
vi.mock("@sentry/nextjs", () => ({ captureException: h.capture }));
vi.mock("@/lib/env", () => ({ env: { SUPABASE_SERVICE_ROLE_KEY: "" } }));

import { env } from "@/lib/env";
import { audit, auditForOrganizations } from "./index";

beforeEach(() => { vi.clearAllMocks(); });

describe("auditoria aceita só o escritor do servidor", () => {
  it("ausência da chave reporta falha sem tentar INSERT com a sessão", async () => {
    env.SUPABASE_SERVICE_ROLE_KEY = "";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await audit({ action: "auth.mfa_enrolled" });
      await auditForOrganizations({ action: "auth.mfa_enrolled" }, ["org-a"]);
      expect(h.session).not.toHaveBeenCalled();
      expect(h.admin).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(2);
      expect(error.mock.calls[0]).toContain("service role not configured");
    } finally { error.mockRestore(); }
  });

  it("service writer preserva ator e organização enviados pela ação autenticada", async () => {
    env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-key";
    const insert = vi.fn(async () => ({ error: null }));
    h.admin.mockReturnValue({ from: vi.fn(() => ({ insert })) });
    // A leitura de suporte pode falhar fora de uma request (worker), sem
    // afetar a escrita principal e sem escolher a sessão como escritor.
    h.session.mockRejectedValue(new Error("no request context"));
    await audit({ action: "auth.mfa_enrolled", actorUserId: "user-a", organizationId: "org-a" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ actor_user_id: "user-a", organization_id: "org-a", acting_as_platform_admin: false }));
    await auditForOrganizations({ action: "auth.mfa_enrolled", actorUserId: "user-a" }, ["org-a", "org-b"]);
    expect(insert).toHaveBeenLastCalledWith([
      expect.objectContaining({ organization_id: "org-a", actor_user_id: "user-a" }),
      expect.objectContaining({ organization_id: "org-b", actor_user_id: "user-a" }),
    ]);
  });
});
