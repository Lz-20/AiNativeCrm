"use server";

import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/recovery-codes";

export type RegenerateRecoveryCodesResult =
  | { ok: true; recovery_codes: string[] }
  | { ok: false; error: string };

/**
 * Deletes existing user_recovery_codes for the current user and issues 10
 * fresh codes. Plaintext returned ONCE — never persisted.
 */
export async function regenerateRecoveryCodes(): Promise<RegenerateRecoveryCodesResult> {
  const supabase = await createClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "unauthenticated" };

  // Ter um fator cadastrado não prova a posse dele: a sessão do primeiro
  // fator também consegue listá-lo. A rotação privilegiada exige AAL2 atual.
  const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError || assurance?.currentLevel !== "aal2") {
    return { ok: false, error: "mfa_required" };
  }
  if (!isServiceRoleConfigured()) {
    return { ok: false, error: "service_unavailable" };
  }

  // Confirm user has a verified TOTP factor (regenerate is meaningless otherwise).
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const hasFactor = factors?.totp?.some((f) => f.status === "verified");
  if (!hasFactor) return { ok: false, error: "mfa_not_enrolled" };

  const codes = generateRecoveryCodes();
  const rows = codes.map((c) => ({ user_id: user.id, code_hash: hashRecoveryCode(c) }));

  // A tabela não aceita escrita direta da sessão, mesmo AAL2. O servidor
  // resolve user.id via getUser() e só chega aqui após provar o segundo fator.
  const admin = createAdminClient();
  const { error: delErr } = await admin.from("user_recovery_codes").delete().eq("user_id", user.id);
  let insErr: unknown = null;
  if (!delErr) {
    const ins = await admin.from("user_recovery_codes").insert(rows);
    insErr = ins.error;
  }
  if (delErr) {
    const msg = (delErr as { message?: string }).message ?? "delete_failed";
    return { ok: false, error: msg };
  }
  if (insErr) {
    const msg = (insErr as { message?: string }).message ?? "insert_failed";
    return { ok: false, error: msg };
  }

  await audit({
    action: "mfa.recovery_codes_regenerated",
    actorUserId: user.id,
    resourceType: "user",
    resourceId: user.id,
    requestId,
    ip,
    userAgent,
    metadata: { count: codes.length },
  });

  return { ok: true, recovery_codes: codes };
}
