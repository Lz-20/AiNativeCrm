import { integrationBinding } from "@/lib/ai/integrations/config";
import { projectLangfuseRun } from "@/lib/ai/integrations/langfuse";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import type { SupabaseClient } from "@supabase/supabase-js";

export type CrmAgentEventType =
  | "run_started"
  | "context_loaded"
  | "model_decision"
  | "tool_proposed"
  | "policy_checked"
  | "tool_started"
  | "tool_completed"
  | "crm_state_changed"
  | "human_confirmation_requested"
  | "human_confirmation_received"
  | "run_resumed"
  | "run_completed"
  | "run_partial"
  | "run_failed"
  | "run_cancelled"
  | "collaboration_started"
  | "specialist_started"
  | "specialist_completed"
  | "specialist_failed"
  | "collaboration_conflict"
  | "collaboration_completed"
  | "manager_direction_consumed"
  | "usage_reported";

const EVENT_FIELDS: Record<CrmAgentEventType, readonly string[]> = {
  run_started: ["agentId", "mode", "taskLength", "evalProfile", "knowledgeNamespaces"],
  context_loaded: [
    "contactId", "leadId", "conversationId", "pipelineId",
    "orgMemoryRevision", "orgMemoryVersionId", "orgMemoryVersionNumber", "orgMemoryEntriesCount", "memoryResolution",
  ],
  model_decision: [
    "toolResultCount",
    "proposedToolCount",
    "candidateReplyCount",
    "impedimentCount",
    "resultRecovery",
  ],
  tool_proposed: ["proposalId", "tool"],
  policy_checked: ["proposalId", "decision", "tool", "gate", "verdict", "code"],
  tool_started: ["proposalId", "tool", "toolCallId"],
  tool_completed: ["proposalId", "tool", "toolCallId", "status"],
  crm_state_changed: ["proposalId", "tool", "targetId", "changedFields"],
  human_confirmation_requested: ["proposalId", "tool"],
  human_confirmation_received: ["proposalId", "decision", "actorUserId"],
  run_resumed: ["proposalId"],
  run_completed: ["status", "hasAnswer", "proposalCount", "pendingProposals"],
  run_partial: ["status", "pendingProposals", "reason"],
  run_failed: ["code", "errorType"],
  run_cancelled: ["actorUserId"],
  collaboration_started: ["planKey", "planRevision", "specialistCount", "maxParallel"],
  specialist_started: ["childRunId", "specialistKey", "role"],
  specialist_completed: [
    "childRunId",
    "specialistKey",
    "status",
    "toolCalls",
    "evidenceCount",
    "claimCount",
    "missingMaterialCount",
  ],
  specialist_failed: ["childRunId", "specialistKey", "code", "errorType"],
  collaboration_conflict: ["code", "specialistKeys", "field"],
  collaboration_completed: [
    "planKey",
    "status",
    "completedSpecialists",
    "failedSpecialists",
    "toolCalls",
    "conflictCount",
  ],
  manager_direction_consumed: ["directionId", "directionRevision"],
  usage_reported: ["inputTokens", "outputTokens", "costCents", "calls"],
};

/** Persist one redacted product event with a strictly increasing run sequence. */
export async function appendWorkbenchEvent(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    runId: string;
    type: CrmAgentEventType;
    payload?: Record<string, unknown>;
  },
): Promise<number> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: last, error: readError } = await admin
      .from("ai_agent_run_events")
      .select("sequence")
      .eq("organization_id", input.organizationId)
      .eq("run_id", input.runId)
      .order("sequence", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (readError) throw new Error(`workbench_event_read_failed:${readError.message}`);
    const sequence = (last?.sequence ?? 0) + 1;
    const { error } = await admin.from("ai_agent_run_events").insert({
      organization_id: input.organizationId,
      run_id: input.runId,
      sequence,
      event_type: input.type,
      payload: redactEventPayload(input.type, input.payload ?? {}),
    });
    if (!error) {
      if (["run_completed", "run_partial", "run_failed", "run_cancelled"].includes(input.type) &&
          integrationBinding(input.organizationId, "langfuse")) {
        try { await projectLangfuseRun(getRequestPool(), input.organizationId, input.runId); } catch { /* local event remains canonical */ }
      }
      return sequence;
    }
    if (error.code !== "23505") throw new Error(`workbench_event_append_failed:${error.message}`);
  }
  throw new Error("workbench_event_sequence_race");
}

/** Events retain IDs and summaries, never credentials or raw message bodies. */
export function redactEventPayload(
  type: CrmAgentEventType,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const secretKey = /api.?key|secret|token|password|credential|authorization/i;
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([key, nested]) => [
          key,
          secretKey.test(key) && !(
            type === "usage_reported" &&
            (key === "inputTokens" || key === "outputTokens") &&
            typeof nested === "number" && Number.isFinite(nested) && nested >= 0
          ) ? "[REDACTED]" : visit(nested),
        ]),
      );
    }
    return item;
  };
  const allowed = new Set(EVENT_FIELDS[type]);
  return visit(
    Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key))),
  ) as Record<string, unknown>;
}
