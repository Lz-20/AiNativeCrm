import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "supabase/migrations/20260926020000_0382_workbench_confirmed_reply.sql";
const migration = readFileSync(migrationPath, "utf8");

describe("workbench-confirmed reply database boundary", () => {
  it("stages an org-scoped reply only for a pending send proposal and unchanged context", () => {
    expect(migration).toContain("fn_reply_workbench_stage");
    expect(migration).toContain("p.tool_name='send_message' and p.status='pending'");
    expect(migration).toContain("c.reply_context_revision<>p_context_revision");
    expect(migration).toContain("a.operation_revision<>p_operation_revision");
    expect(migration).toContain("not is_blocked and not is_anonymized");
  });

  it("keeps delivery on the existing approved_reply policy and binds it to the exact proposal", () => {
    expect(migration).toContain("proposal.tool_args->>'body'=d.original_body");
    expect(migration).toContain("proposal.status='executed'");
    expect(migration).toContain("grant execute on function public.fn_reply_workbench_stage");
    expect(migration).toContain("trg_reply_workbench_decision_bridge");
  });
});
