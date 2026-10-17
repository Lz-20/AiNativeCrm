import { readConfirmedCustomerMemory } from "@/lib/ai/integrations/mem0";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { readServiceBoundarySupabase } from "@/lib/atendimento/origem";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";

const checkpointSchema = z.object({
  id: z.string(),
  seq: z.union([
    z.number().int().nonnegative().refine(Number.isSafeInteger),
    z.string().regex(/^\d+$/),
  ]),
  organization_id: z.string(),
  contact_id: z.string(),
  conversation_id: z.string(),
  service_revision: z.number().int(),
  demanda_id: z.string().nullable(),
  demanda_revision: z.number().int().nullable(),
  created_at: z.string(),
  commitments: z.array(z.string()),
  objections: z.array(z.string()),
  next_action: z.string().nullable(),
  rolling_summary: z.string(),
});

function sameBoundary(left: ServiceBoundary, right: ServiceBoundary): boolean {
  return (
    left.organization_id === right.organization_id &&
    left.contact_id === right.contact_id &&
    left.conversation_id === right.conversation_id &&
    left.service_revision === right.service_revision &&
    left.demanda_id === right.demanda_id &&
    left.demanda_revision === right.demanda_revision
  );
}

/** Checkpoints podem sobreviver à anonimização/fusão; a linha do contato decide. */
async function contactAllowsMemory(
  db: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("contacts")
    .select("id, organization_id, is_anonymized, is_merged_into")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (error) throw new Error("customer_memory_contact_read_failed", { cause: error });
  return (
    data?.id === contactId &&
    data.organization_id === organizationId &&
    data.is_anonymized === false &&
    data.is_merged_into === null
  );
}

function contactMemoryUnavailable() {
  return {
    schema_version: 1 as const,
    access: "read_only" as const,
    status: "unavailable" as const,
    reason: "contact_memory_unavailable",
    checkpoint: null,
    revision: null,
  };
}

/**
 * Leitura apenas: memória durável do atendimento atual da conversa autorizada.
 * Nunca recua para checkpoint de outro canal, demanda ou atendimento do contato.
 * seq é proveniência do checkpoint, não uma promessa de CAS/escrita pelo Workbench.
 */
export async function loadCustomerMemoryForConversation(
  db: SupabaseClient,
  organizationId: string,
  conversationId: string,
) {
  if (!organizationId || !conversationId) throw new Error("customer_memory_scope_missing");
  const boundary = await readServiceBoundarySupabase(db, organizationId, conversationId);
  if (!boundary)
    return {
      schema_version: 1 as const,
      access: "read_only" as const,
      status: "unavailable" as const,
      reason: "service_boundary_unavailable",
      checkpoint: null,
      revision: null,
    };
  if (!(await contactAllowsMemory(db, organizationId, boundary.contact_id)))
    return contactMemoryUnavailable();
  let query = db
    .from("lead_checkpoints")
    .select(
      "id, seq, organization_id, contact_id, conversation_id, service_revision, demanda_id, demanda_revision, created_at, commitments, objections, next_action, rolling_summary",
    )
    .eq("organization_id", organizationId)
    .eq("contact_id", boundary.contact_id)
    .eq("conversation_id", conversationId)
    .eq("service_revision", boundary.service_revision);
  query =
    boundary.demanda_id === null
      ? query.is("demanda_id", null)
      : query.eq("demanda_id", boundary.demanda_id);
  query =
    boundary.demanda_revision === null
      ? query.is("demanda_revision", null)
      : query.eq("demanda_revision", boundary.demanda_revision);
  const { data, error } = await query.order("seq", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error("customer_memory_read_failed", { cause: error });
  const externalMemory = await (async () => readConfirmedCustomerMemory(getRequestPool(), organizationId, boundary.contact_id))()
    .catch(() => ({ status: "unavailable", coverage: "unavailable", memories: [] }));
  const current = await readServiceBoundarySupabase(db, organizationId, conversationId);
  if (!current || !sameBoundary(boundary, current))
    return {
      schema_version: 1 as const,
      access: "read_only" as const,
      status: "unavailable" as const,
      reason: "service_boundary_changed",
      checkpoint: null,
      revision: null,
    };
  // Revalida depois de ler o checkpoint: uma anonimização/fusão concorrente
  // não pode transformar a memória residual em nova exposição pela ferramenta.
  if (!(await contactAllowsMemory(db, organizationId, boundary.contact_id)))
    return contactMemoryUnavailable();
  const scope: ServiceBoundary = {
    organization_id: organizationId,
    contact_id: boundary.contact_id,
    conversation_id: conversationId,
    service_revision: boundary.service_revision,
    demanda_id: boundary.demanda_id,
    demanda_revision: boundary.demanda_revision,
  };
  if (!data)
    return {
      schema_version: 1 as const,
      access: "read_only" as const,
      status: externalMemory?.memories.length ? "available" as const : "empty" as const,
      ...(externalMemory ? { confirmed_customer_memory: externalMemory } : {}),
      scope,
      checkpoint: null,
      revision: null,
    };
  const parsed = checkpointSchema.safeParse(data);
  if (!parsed.success || !sameBoundary(scope, parsed.data))
    throw new Error("customer_memory_checkpoint_invalid");
  const checkpoint = parsed.data;
  return {
    schema_version: 1 as const,
    access: "read_only" as const,
    status: "available" as const,
    ...(externalMemory ? { confirmed_customer_memory: externalMemory } : {}),
    scope,
    revision: String(checkpoint.seq),
    checkpoint: {
      id: checkpoint.id,
      seq: checkpoint.seq,
      created_at: checkpoint.created_at,
      commitments: checkpoint.commitments,
      objections: checkpoint.objections,
      next_action: checkpoint.next_action,
      rolling_summary: checkpoint.rolling_summary,
    },
  };
}
