import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import {
  customerMemoryInput,
  saveCustomerMemory,
  deleteCustomerMemory,
  reconcileCustomerMemory,
} from "@/lib/ai/integrations/mem0";

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const input = customerMemoryInput.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail(
      "invalid_request",
      "Confirm a customer preference, fact or communication context. Company/product policy belongs in Wiki.",
      400,
      { requestId },
    );
  const auth = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  try {
    const data = await saveCustomerMemory(
      getRequestPool(),
      auth.org.orgId,
      auth.user.id,
      input.data,
    );
    await audit({
      action: "ai.customer_memory_confirmed",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "ai_customer_memories",
      resourceId: data.id,
      requestId,
    });
    return ok(data, { requestId });
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (
      ["customer_memory_contact_unavailable", "customer_memory_idempotency_conflict"].includes(code)
    )
      return fail("invalid_request", "Customer unavailable or request key conflicts.", 409, {
        requestId,
      });
    return fail(
      "internal_error",
      "The save outcome is unconfirmed. Retry the same content with the same request_key; do not create a new key.",
      503,
      { requestId },
    );
  }
}
export async function DELETE(req: NextRequest) {
  const requestId = randomUUID();
  const input = z
    .object({ id: z.string().uuid() })
    .strict()
    .safeParse(await req.json().catch(() => null));
  if (!input.success) return fail("invalid_request", "Invalid memory ID.", 400, { requestId });
  const auth = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  try {
    if (!(await deleteCustomerMemory(getRequestPool(), auth.org.orgId, input.data.id)))
      return fail("not_found", "Memory not found.", 404, { requestId });
    await audit({
      action: "ai.customer_memory_deleted",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "ai_customer_memories",
      resourceId: input.data.id,
      requestId,
    });
    return ok(
      { id: input.data.id, hidden: true, external_cleanup: "pending_verification" },
      { requestId },
    );
  } catch {
    return fail("internal_error", "Unable to retire memory.", 500, { requestId });
  }
}

export async function PATCH(req: NextRequest) {
  const requestId = randomUUID();
  const input = z
    .object({ id: z.string().uuid(), remote_request_settled: z.literal(true) })
    .strict()
    .safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail(
      "invalid_request",
      "Confirm in the Mem0 service that the earlier request has finished before reconciling.",
      400,
      { requestId },
    );
  const auth = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  const denied = await requireSupportWrite(auth.org.orgId);
  if (denied) return denied;
  try {
    const result = await reconcileCustomerMemory(getRequestPool(), auth.org.orgId, input.data.id);
    await audit({
      action: "ai.customer_memory_reconciled",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "ai_customer_memories",
      resourceId: input.data.id,
      requestId,
    });
    return ok(result, { requestId });
  } catch {
    return fail(
      "invalid_request",
      "Reconciliation is not yet safe, the service is unavailable, or duplicate remote receipts need operator review. No ADD was retried.",
      409,
      { requestId },
    );
  }
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const input = z
    .object({ contact_id: z.string().uuid() })
    .safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success)
    return fail("invalid_request", "A contact ID is required.", 400, { requestId });
  const auth = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return auth.response;
  try {
    const { rows } = await getRequestPool().query(
      "select id,category,body,sync_state,write_outcome,deleted_at,remote_deleted_at,created_at from ai_customer_memories where organization_id=$1 and contact_id=$2 order by created_at desc limit 100",
      [auth.org.orgId, input.data.contact_id],
    );
    return ok(rows, { requestId });
  } catch {
    return fail("internal_error", "Unable to read customer memory status.", 503, { requestId });
  }
}
