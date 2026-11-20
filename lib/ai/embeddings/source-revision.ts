import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { hashText, EmbeddingWaitingError } from "./operation-contract";

/** Current storage VERSION and FAQ rows, not merely a mutable filename. Ordered
 * JSON arrays give the same identity in preview, authorization and every send.
 */
export async function sourceRevision(
  db: Queryable,
  org: string,
  sourceId: string,
): Promise<string> {
  const { rows } = await db.query<{ revision: unknown }>(
    `select jsonb_build_array(s.source_type,s.source_metadata,
    coalesce((select jsonb_agg(jsonb_build_array(o.id,o.version,o.updated_at) order by o.id) from storage.objects o
      where o.bucket_id='ai-policy' and o.name=s.source_metadata->>'blob_path'),'[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_array(i.position,i.question,i.answer) order by i.position,i.id) from public.ai_faq_items i
      where i.organization_id=s.organization_id and i.knowledge_source_id=s.id),'[]'::jsonb)) as revision
    from public.ai_knowledge_sources s where s.organization_id=$1 and s.id=$2 and s.is_active and s.status<>'archived'`,
    [org, sourceId],
  );
  if (!rows.length) throw new EmbeddingWaitingError("embedding_authorization_required");
  return hashText(JSON.stringify(rows[0]!.revision));
}
