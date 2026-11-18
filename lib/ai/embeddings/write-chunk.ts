import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/database.types";
import type { EmbeddingProfile } from "./profile";

/** Explicit table branches keep both ON CONFLICT targets independently auditable. */
export async function writeKnowledgeChunk(row: Database["public"]["Tables"]["ai_chunks"]["Insert"], profile?: EmbeddingProfile) {
  const admin = createAdminClient();
  if (profile) return admin.from("ai_embedding_chunks").upsert({ ...row,
    embedding_dims: profile.dimensions, embedding_fingerprint: profile.fingerprint,
  }, { onConflict: "knowledge_source_id,kb_version_id,position", ignoreDuplicates: true });
  return admin.from("ai_chunks").upsert(row,
    { onConflict: "knowledge_source_id,kb_version_id,position", ignoreDuplicates: true });
}
