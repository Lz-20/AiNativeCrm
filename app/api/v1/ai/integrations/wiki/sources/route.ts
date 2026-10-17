import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { integrationBinding } from "@/lib/ai/integrations/config";
import { audit } from "@/lib/audit";
const schema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(2).max(120),
    knowledge_base_id: z.string().min(1).max(200),
    whole_organization_visibility_confirmed: z.literal(true),
  })
  .strict();
export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail(
      "invalid_request",
      "Confirm that the entire Wiki KB has one organization-wide visibility boundary.",
      400,
      { requestId },
    );
  const auth = await requireRole("admin", { requestId, resource: "ai_knowledge" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  const binding = integrationBinding(auth.org.orgId, "weknora");
  if (!binding?.knowledge_base_ids?.includes(parsed.data.knowledge_base_id))
    return fail("forbidden", "KB is outside this organization's trusted binding.", 403, {
      requestId,
    });
  const metadata = {
    provider: "weknora",
    knowledge_base_id: parsed.data.knowledge_base_id,
    visibility: "organization",
  };
  try {
    const pool = getRequestPool();
    await pool.query(
      `insert into ai_knowledge_sources(id,organization_id,source_type,name,status,is_active,source_metadata)
      values($1,$2,'wiki',$3,'ready',true,$4::jsonb) on conflict(id) do nothing`,
      [parsed.data.id, auth.org.orgId, parsed.data.name, JSON.stringify(metadata)],
    );
    const { rows } = await pool.query(
      "select id,source_metadata,name from ai_knowledge_sources where organization_id=$1 and id=$2",
      [auth.org.orgId, parsed.data.id],
    );
    if (
      !rows[0] ||
      rows[0].source_metadata?.provider !== metadata.provider ||
      rows[0].source_metadata?.knowledge_base_id !== metadata.knowledge_base_id ||
      rows[0].source_metadata?.visibility !== metadata.visibility ||
      rows[0].name !== parsed.data.name
    )
      return fail("invalid_request", "Source ID conflicts; use a new ID.", 409, { requestId });
    await audit({
      action: "ai.wiki_source_connected",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "ai_knowledge_sources",
      resourceId: parsed.data.id,
      requestId,
    });
    return ok(
      {
        id: parsed.data.id,
        next_step: "Select this source in the agent's knowledge corpus and publish its version.",
      },
      { requestId },
    );
  } catch {
    return fail("internal_error", "Unable to connect Wiki source.", 500, { requestId });
  }
}
