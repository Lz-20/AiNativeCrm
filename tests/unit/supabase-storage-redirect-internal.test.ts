import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:8000",
    SUPABASE_INTERNAL_URL: "http://api-gw:8000",
  },
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "fixture-user" }),
  resolveActiveOrg: async () => ({ orgId: "fixture-org" }),
}));
const signed =
  "http://api-gw:8000/storage/v1/object/sign/whatsapp-media/fixture-org/avatar.png?token=fixture%2Bsignature";
const eq = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const query = {
      select: () => query,
      eq: (key: string, value: string) => {
        eq(key, value);
        return query;
      },
      maybeSingle: async () => ({
        data: { avatar_storage_path: "fixture-org/avatar.png", is_anonymized: false },
        error: null,
      }),
    };
    return {
      from: () => query,
      storage: {
        from: () => ({
          createSignedUrl: async () => ({ data: { signedUrl: signed }, error: null }),
        }),
      },
    };
  },
}));

describe("avatar com Supabase em rede Docker", () => {
  it("o redirect preserva o escopo de tenant e entrega uma assinatura acessível pelo navegador", async () => {
    const { GET } = await import("@/app/api/v1/contacts/[id]/avatar/route");
    const response = await GET({} as never, { params: Promise.resolve({ id: "fixture-contact" }) });
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(
      signed.replace("http://api-gw:8000", "http://localhost:8000"),
    );
    expect(response.headers.get("Location")).not.toContain("api-gw");
    expect(eq).toHaveBeenCalledWith("organization_id", "fixture-org");
    expect(response.headers.get("Cache-Control")).toContain("private");
  });
});
