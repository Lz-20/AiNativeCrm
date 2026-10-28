/**
 * Cerca contra publicar por engano uma credencial de backend.
 * Não autentica nem verifica assinatura: a validade da chave continua sendo
 * responsabilidade do Supabase. Formatos desconhecidos ficam com essa validação.
 * Puro e compartilhável entre env, render do servidor e bundle do navegador.
 */
export function isPrivilegedSupabaseKey(key: string): boolean {
  const value = key.trim();
  if (value.startsWith("sb_secret_")) return true;

  const parts = value.split(".");
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload: unknown = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return (
      typeof payload === "object" &&
      payload !== null &&
      "role" in payload &&
      payload.role === "service_role"
    );
  } catch {
    return false;
  }
}

export function assertPublicSupabaseKey(key: string): void {
  if (isPrivilegedSupabaseKey(key)) {
    throw new Error(
      "Configure uma chave pública do Supabase (publishable ou anon), nunca uma chave de backend.",
    );
  }
}
