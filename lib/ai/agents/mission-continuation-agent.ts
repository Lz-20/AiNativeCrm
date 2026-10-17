import type { Queryable } from "@/lib/agent-engine/queue/queue";

/**
 * A Mission wake is an autonomous new Run, not a manager clicking Run again.
 * User Agents require the same published version; locked built-ins use their
 * exact CRM-owned draft version. Both must still be enabled and unpaused.
 */
export async function loadMissionContinuationAgent(
  db: Queryable,
  organizationId: string,
  agentId: string,
  versionId: string,
): Promise<{ operationRevision: number } | null> {
  const { rows } = await db.query<{ operation_revision: string | number }>(
    `select a.operation_revision
     from public.ai_agents a
     join public.ai_agent_versions v
       on v.organization_id=a.organization_id and v.agent_id=a.id
     where a.organization_id=$1 and a.id=$2 and v.id=$3
       and a.is_active and a.archived_at is null and a.paused_at is null
       and a.operation_mode='automatic'
       and (
         (a.origin='builtin' and a.model_binding_mode='organization_default'
           and a.builtin_key is not null and v.status='draft')
         or (a.origin='user' and a.published_version_id=v.id and v.status='published')
       )`,
    [organizationId, agentId, versionId],
  );
  if (!rows[0]) return null;
  const revision = Number(rows[0].operation_revision);
  return Number.isSafeInteger(revision) && revision > 0
    ? { operationRevision: revision } : null;
}
