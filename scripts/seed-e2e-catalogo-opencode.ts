/**
 * Seed the one OpenCode Zen model verified for real tool calling into the
 * loopback-only E2E catalog. This deliberately makes no capability claim for
 * other models returned by the provider's catalog.
 *
 * Run: npx tsx scripts/seed-e2e-catalogo-opencode.ts
 */
import { createClient } from "@supabase/supabase-js";

import { anunciarDestino, credenciaisSupabaseDeTeste, destinoEhLocal } from "./lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-catalogo-opencode", credenciais);
if (!destinoEhLocal(credenciais.url) || !destinoEhLocal(credenciais.dbUrl)) {
  throw new Error("OpenCode E2E catalog seed only permits loopback Supabase and Postgres URLs");
}

const admin = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});

async function main(): Promise<void> {
  const { error } = await admin.from("ai_models").upsert(
    {
      provider: "opencode",
      model_id: "space-bunny-free",
      display_name: "Space Bunny Free (OpenCode Zen)",
      supports_tools: true,
      input_price_per_million_cents: 0,
      output_price_per_million_cents: 0,
      metadata: { source: "sync", seed: "e2e", tool_calling_verified: true },
    },
    { onConflict: "provider,model_id", ignoreDuplicates: true },
  );
  if (error) {
    console.error("[seed-catalogo-opencode] failed:", error.message);
    process.exit(1);
  }

  const { data: model, error: readError } = await admin
    .from("ai_models")
    .select("supports_tools")
    .eq("provider", "opencode")
    .eq("model_id", "space-bunny-free")
    .maybeSingle();
  if (readError || !model?.supports_tools) {
    console.error(
      "[seed-catalogo-opencode] catalog entry already exists without verified tool support; refusing to overwrite it",
    );
    process.exit(1);
  }

  console.info("[seed-catalogo-opencode] opencode/space-bunny-free is available for local E2E");
}

void main();
