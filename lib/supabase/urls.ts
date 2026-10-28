/** O endereço público pertence ao navegador; o interno é apenas transporte do servidor. */
type SupabaseUrlConfig = {
  NEXT_PUBLIC_SUPABASE_URL: string;
  SUPABASE_INTERNAL_URL?: string;
};

export function validSupabaseInternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function supabaseServerUrl(config: SupabaseUrlConfig): string {
  return config.SUPABASE_INTERNAL_URL?.trim() || config.NEXT_PUBLIC_SUPABASE_URL;
}

/** O SDK concatena a URL do transporte à assinatura. Só sua origem/prefixo Storage muda. */
export function publicStorageUrl(value: string, config: SupabaseUrlConfig): string {
  if (!config.SUPABASE_INTERNAL_URL?.trim()) return value;
  const internal = new URL(config.SUPABASE_INTERNAL_URL);
  const source = new URL(value);
  const internalPrefix = internal.pathname.replace(/\/+$/, "");
  if (
    source.origin !== internal.origin ||
    !source.pathname.startsWith(`${internalPrefix}/storage/v1/`)
  ) {
    return value;
  }
  const published = new URL(config.NEXT_PUBLIC_SUPABASE_URL);
  const publicPrefix = published.pathname.replace(/\/+$/, "");
  return `${published.origin}${publicPrefix}${source.pathname.slice(internalPrefix.length)}${source.search}${source.hash}`;
}
