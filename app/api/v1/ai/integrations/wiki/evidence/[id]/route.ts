import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { readCompanyWikiEvidence } from "@/lib/ai/integrations/weknora";
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "Invalid evidence ID.", 400, { requestId });
  const auth = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!auth.ok) return auth.response;
  try {
    const evidence = await readCompanyWikiEvidence(getRequestPool(), auth.org.orgId, id);
    return evidence
      ? ok(evidence, { requestId })
      : fail("not_found", "Evidence unavailable, withdrawn or superseded.", 404, { requestId });
  } catch {
    return fail("internal_error", "Unable to verify current Wiki sources.", 503, { requestId });
  }
}
