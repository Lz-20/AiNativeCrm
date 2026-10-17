import { createAdminClient } from "../lib/supabase/admin";
import { ensureBuiltinAgents } from "../lib/ai/agents/ensure-builtins";

/** Idempotently backfill the four built-in Agents in every existing organization. */
async function main(): Promise<void> {
  const admin = createAdminClient();
  const { data: organizations, error } = await admin.from("organizations").select("id");
  if (error) throw new Error(`无法读取组织列表：${error.message}`);

  let created = 0;
  let existing = 0;
  for (const organization of organizations ?? []) {
    const result = await ensureBuiltinAgents(organization.id);
    created += result.created;
    existing += result.existing;
    console.info(
      `[builtin-agents] organization=${organization.id} created=${result.created} existing=${result.existing}`,
    );
  }

  console.info(
    `[builtin-agents] 完成：organizations=${organizations?.length ?? 0} created=${created} existing=${existing}`,
  );
}

main().catch((error: unknown) => {
  console.error("[builtin-agents] 补齐失败：", error);
  process.exitCode = 1;
});
