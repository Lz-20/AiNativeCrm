/**
 * Installation-level model credential lookup.
 *
 * Provider construction belongs to the Pi adapter. This module only exposes
 * the installation credential used by publishing/configuration flows; tenant
 * credentials are resolved separately and never fall back to this helper when
 * a tenant binding is active.
 */
export function chaveDePlataforma(provider: string): string | null {
  const nome = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
  }[provider];
  if (!nome) return null;
  const value = (process.env[nome] ?? "").trim();
  return value === "" ? null : value;
}
