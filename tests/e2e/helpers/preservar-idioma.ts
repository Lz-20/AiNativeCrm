import type { SupabaseClient } from "@supabase/supabase-js";

type AuthAdmin = Pick<SupabaseClient["auth"]["admin"], "getUserById" | "updateUserById">;

/** O chamador já validou o Supabase local e escolheu a identidade da fixture.
 * Captura antes da jornada; o teardown restaura só locale, inclusive ausência,
 * sem sobrescrever outros metadados que tenham mudado durante a execução.
 */
export async function preservarIdiomaDoUsuario(admin: AuthAdmin, userId: string): Promise<() => Promise<void>> {
  const { data, error } = await admin.getUserById(userId);
  if (error || !data.user) throw new Error("Falha ao capturar o idioma da fixture.");
  const localeAnterior: unknown = data.user.user_metadata.locale;
  return async () => {
    const { error: updateError } = await admin.updateUserById(userId, {
      user_metadata: { locale: localeAnterior ?? null },
    });
    if (updateError) throw new Error("Falha ao restaurar o idioma da fixture.");
  };
}
