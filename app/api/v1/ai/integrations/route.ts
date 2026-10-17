import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { integrationBinding, integrationProviderSchema } from "@/lib/ai/integrations/config";

export const dynamic = "force-dynamic";
const schema = z
  .object({
    provider: integrationProviderSchema,
    enabled: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

/** Configuration readiness is local evidence, never a claim that credentials were tested. */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  try {
    const pool = getRequestPool();
    const { rows } = await pool.query<{ provider: string; enabled: boolean; revision: string }>(
      "select provider,enabled,revision from ai_integration_settings where organization_id=$1",
      [auth.org.orgId],
    );
    const { rows: delivery } = await pool.query<{ status: string; count: string }>(
      "select status,count(*) from event_log where organization_id=$1 and event_type='ai_integration.langfuse_export' group by status",
      [auth.org.orgId],
    );
    const { rows: cleanup } = await pool.query(
      "select id,sync_state,write_outcome,deleted_at,remote_deleted_at from ai_customer_memories where organization_id=$1 and contact_id is null and remote_deleted_at is null order by created_at limit 25",
      [auth.org.orgId],
    );
    return ok(
      {
        cleanup_receipts: cleanup,
        providers: integrationProviderSchema.options.map((provider) => {
          const setting = rows.find((row) => row.provider === provider);
          const binding = integrationBinding(auth.org.orgId, provider);
          return {
            provider,
            configured: Boolean(binding),
            destination: binding ? new URL(binding.base_url).origin : null,
            available_knowledge_bases: binding?.knowledge_base_ids ?? [],
            enabled: setting?.enabled === true,
            revision: Number(setting?.revision ?? 0),
            connectivity_verified: false,
          };
        }),
        trace_delivery: delivery,
      },
      { requestId },
    );
  } catch {
    return fail(
      "internal_error",
      "Integration readiness unavailable; verify the database migration.",
      503,
      { requestId },
    );
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const input = schema.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail("invalid_request", "Invalid integration settings.", 400, { requestId });
  const auth = await requireRole("admin", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  const { provider, enabled, revision } = input.data;
  if (enabled && !integrationBinding(auth.org.orgId, provider))
    return fail(
      "invalid_request",
      "A trusted server-side organization binding is required before activation.",
      409,
      { requestId },
    );
  try {
    const { rows } = await getRequestPool().query<{ revision: string }>(
      `insert into ai_integration_settings(organization_id,provider,enabled,revision)
       select $1,$2,$3,1 where $4=0
       on conflict(organization_id,provider) do update set enabled=$3,revision=ai_integration_settings.revision+1,updated_at=now()
       where ai_integration_settings.revision=$4 returning revision`,
      [auth.org.orgId, provider, enabled, revision],
    );
    // Existing rows require UPDATE, because INSERT SELECT with revision>0 intentionally emits none.
    const updated =
      rows[0] ??
      (revision > 0
        ? (
            await getRequestPool().query<{ revision: string }>(
              `update ai_integration_settings set enabled=$3,revision=revision+1,updated_at=now()
       where organization_id=$1 and provider=$2 and revision=$4 returning revision`,
              [auth.org.orgId, provider, enabled, revision],
            )
          ).rows[0]
        : undefined);
    if (!updated)
      return fail("invalid_request", "Settings changed. Refresh before saving.", 409, {
        requestId,
      });
    await audit({
      action: "ai.integration_configured",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "ai_integration_settings",
      resourceId: auth.org.orgId,
      requestId,
      metadata: { provider, enabled },
    });
    return ok({ provider, enabled, revision: Number(updated.revision) }, { requestId });
  } catch {
    return fail("internal_error", "Unable to save integration settings.", 500, { requestId });
  }
}

/** Retry delivery receipts, never rerun the Agent or reset an unknown Mem0 ADD. */
export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const input = z
    .object({ provider: integrationProviderSchema, action: z.literal("retry_delivery") })
    .strict()
    .safeParse(await req.json().catch(() => null));
  if (!input.success) return fail("invalid_request", "Invalid retry request.", 400, { requestId });
  const auth = await requireRole("admin", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  const type =
    input.data.provider === "langfuse"
      ? "ai_integration.langfuse_export"
      : input.data.provider === "mem0"
        ? "ai_integration.mem0_sync"
        : null;
  if (!type)
    return fail("invalid_request", "Wiki retrieval has no delivery queue.", 400, { requestId });
  try {
    const { rows } = await getRequestPool().query(
      "update event_log set status='pending',attempts=0,last_error=null,next_attempt_at=now() where organization_id=$1 and event_type=$2 and status='dead' returning id",
      [auth.org.orgId, type],
    );
    if (rows.length)
      await audit({
        action: "ai.integration_export_requested",
        actorUserId: auth.user.id,
        organizationId: auth.org.orgId,
        resourceType: "event_log",
        requestId,
        metadata: { provider: input.data.provider, count: rows.length },
      });
    return ok({ retried: rows.length }, { requestId });
  } catch {
    return fail("internal_error", "Unable to requeue delivery receipts.", 503, { requestId });
  }
}
