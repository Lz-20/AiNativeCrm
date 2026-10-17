import { env } from "@/lib/env";

export const DEMO_EMAIL = env.CRM_DEMO_EMAIL;
export const DEMO_PASSWORD = env.CRM_DEMO_PASSWORD;
export const DEMO_ORG_SLUG = "pi-native-demo";

/**
 * O modo demo é uma conveniência de desenvolvimento, não um bypass de
 * autenticação. Ele só pode acender quando o Supabase também está em loopback
 * e nunca acende em produção, mesmo que alguém deixe a variável esquecida.
 */
export function isDemoModeEnabled(): boolean {
  if (env.NODE_ENV === "production" || env.CRM_DEMO_MODE !== "true") return false;
  try {
    const hostname = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
