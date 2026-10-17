import type pg from "pg";
import { loadAgentVersionConfig } from "./agent-config";
import { runAgentPreview, type InboundTurnDeps } from "./inbound-turn";
import { newPreviewResult, scenarioContext } from "./preview";
import type { AgentRuntimeEvent } from "@/lib/agent-runtime";
import type { RuntimeMessage } from "@/lib/agent-runtime";
export async function testAgentVersion(
  pool: pg.Pool,
  deps: InboundTurnDeps,
  input: {
    organizationId: string;
    agentId: string;
    versionId: string;
    runId: string;
    mode?: "inspect" | "act";
    abortSignal?: AbortSignal;
    budget?: { tokenBudget?: number | null; costBudgetCents?: number | null };
    resumeMessages?: RuntimeMessage[];
    onRuntimeMessages?: (messages: RuntimeMessage[]) => void | Promise<void>;
    sampleMessage: string;
    sampleContact?: { name?: string; phone?: string };
    contactId?: string | null;
    conversationId?: string | null;
    pipelineIds?: string[];
    onRuntimeEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
    channelId: string | null;
  },
) {
  const agent = await loadAgentVersionConfig(
    pool,
    input.organizationId,
    input.agentId,
    input.versionId,
  );
  if (!agent) throw new Error("preview_version_unavailable");
  const scopedAgent = input.pipelineIds ? { ...agent, pipelineIds: input.pipelineIds } : agent;
  const result = newPreviewResult();
  const context = scenarioContext(
    [
      {
        direction: "inbound",
        body: input.sampleMessage,
        sent_at: (deps.clock?.() ?? new Date()).toISOString(),
      },
    ],
    input.sampleContact,
    { contactId: input.contactId ?? null, conversationId: input.conversationId ?? null },
  );
  await runAgentPreview(deps, pool, {
    kind: "sandbox",
    mode: input.mode,
    abortSignal: input.abortSignal,
    budget: input.budget,
    resumeMessages: input.resumeMessages,
    onRuntimeMessages: input.onRuntimeMessages,
    organizationId: input.organizationId,
    runId: input.runId,
    agent: scopedAgent,
    context,
    contactId: input.contactId ?? null,
    channelId: input.channelId,
    ...(input.onRuntimeEvent ? { onRuntimeEvent: input.onRuntimeEvent } : {}),
    result,
  });
  return result;
}
