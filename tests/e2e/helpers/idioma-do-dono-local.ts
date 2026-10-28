import { createClient } from "@supabase/supabase-js";

import { destinoEhLocal, type CredenciaisSupabase } from "../../../scripts/lib/env-de-teste";

/** A preferência é da fixture, não do produto: /admin usa o perfil do dono,
 * enquanto /app também herda o idioma da organização. Nunca escreve fora do
 * Supabase local nem em uma identidade que não seja o dono sintético do seed.
 */
export async function criarFixtureIdiomaDoDonoLocal(
  credentials: Pick<CredenciaisSupabase, "url" | "dbUrl" | "serviceRole">,
  email: string,
): Promise<{ aplicar: () => Promise<void>; restaurar: () => Promise<void> }> {
  if (!credentials.url || !destinoEhLocal(credentials.url) || !destinoEhLocal(credentials.dbUrl)) {
    throw new Error("A fixture de idioma exige Supabase local nos dois canais.");
  }
  if (email !== "e2e-dono@pi-native.test") {
    throw new Error("A fixture de idioma exige o dono sintético dedicado.");
  }
  const client = createClient(credentials.url, credentials.serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.admin.listUsers({ perPage: 200 });
  if (error) throw new Error("Falha ao ler a fixture de idioma.");
  const owner = data.users.find((user) => user.email === email);
  if (!owner) throw new Error("Dono sintético ausente na fixture local.");
  const previousLocale: unknown = owner.user_metadata.locale;

  // Supabase mescla user_metadata; enviar só locale preserva os demais campos.
  // null remove a preferência ausente, como o teardown de i18n-espanhol-na-tela.
  const setLocale = async (locale: unknown, phase: string) => {
    const { error: updateError } = await client.auth.admin.updateUserById(owner.id, {
      user_metadata: { locale },
    });
    if (updateError) throw new Error(`Falha ao ${phase} o idioma da fixture local.`);
  };
  return {
    aplicar: () => setLocale("pt-BR", "configurar"),
    restaurar: () => setLocale(previousLocale ?? null, "restaurar"),
  };
}
