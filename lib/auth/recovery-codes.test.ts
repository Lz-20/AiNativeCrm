import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { generateRecoveryCodes, hashRecoveryCode } from "./recovery-codes";

describe("hashes de recuperação atravessam o PostgREST como bytea", () => {
  it("INSERT e filtro eq transmitem o mesmo SHA-256 hexadecimal, sem Buffer JSON ou UTF-8", async () => {
    const wire: Array<{ url: URL; body: string | null }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      wire.push({ url: new URL(String(input)), body: typeof init?.body === "string" ? init.body : null });
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const db = createClient("https://recovery-fixture.invalid", "fixture-key", {
      global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
    });
    const expected = "\\x1635c8525afbae58c37bede3c9440844e9143727cc7c160bed665ec378d8a262";
    const hash = hashRecoveryCode("ABCD1234");
    await db.from("user_recovery_codes").insert({ user_id: "fixture-user", code_hash: hash });
    await db.from("user_recovery_codes").select("id").eq("code_hash", hash);
    expect(wire).toHaveLength(2);
    expect(JSON.parse(wire[0]!.body!)).toEqual({ user_id: "fixture-user", code_hash: expected });
    expect(wire[1]!.url.searchParams.get("code_hash")).toBe(`eq.${expected}`);
  });

  it("gera dez códigos e o hash não contém o código em claro", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      expect(hashRecoveryCode(code)).toMatch(/^\\x[0-9a-f]{64}$/);
    }
  });
});
