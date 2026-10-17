import { z } from "zod";
import type { Pool } from "pg";
import { tool, type ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  ASK_INTERNAL_COLLEAGUE_TOOL, LIST_INTERNAL_COLLEAGUES_TOOL,
  internalQuestionArgsSchema, type InternalQuestionArgs,
} from "@/lib/ai/agents/internal-question-contract";
export { ASK_INTERNAL_COLLEAGUE_TOOL, LIST_INTERNAL_COLLEAGUES_TOOL } from "@/lib/ai/agents/internal-question-contract";

/** Mission-only product tools. The proposal tool never sends to Feishu. */
export function createMissionQuestionTools(input: {
  pool: Pool;
  organizationId: string;
  leadId: string;
  recordProposal: (args: InternalQuestionArgs) => void;
}): ToolSet {
  return {
    [LIST_INTERNAL_COLLEAGUES_TOOL]: tool({
      description: "List active Feishu colleagues mapped to this CRM organization. Use only for the current opportunity Mission; the returned CRM user ID may be used in ask_internal_colleague. An empty list means there is no available internal channel.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const tenantKey = process.env.FEISHU_TENANT_KEY ?? "";
        if (!tenantKey || !process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET)
          return { available: false, recipients: [] };
        const { rows } = await input.pool.query<{ user_id: string; full_name: string | null }>(
          `select u.user_id,
                  nullif(left(a.raw_user_meta_data->>'full_name',120),'') as full_name
           from public.ai_internal_platform_tenants t
           join public.ai_internal_platform_users u
             on u.organization_id=t.organization_id and u.provider=t.provider
            and u.tenant_key=t.tenant_key
           join public.user_organizations member
             on member.organization_id=u.organization_id and member.user_id=u.user_id
           left join auth.users a on a.id=u.user_id
           where t.organization_id=$1 and t.provider='feishu' and t.tenant_key=$2
             and t.active and u.active and member.revoked_at is null
             and member.accepted_at is not null and member.role in ('agent','manager','admin')
           order by full_name nulls last,u.user_id limit 100`,
          [input.organizationId, tenantKey],
        );
        return { available: true, recipients: rows };
      },
    }),
    [ASK_INTERNAL_COLLEAGUE_TOOL]: tool({
      description: `For the current opportunity Mission on lead ${input.leadId}, propose one precise question to a mapped Feishu colleague. This only creates an external-action proposal for a manager to inspect. It does not send a message, approve a question, or complete the business goal. First call list_internal_colleagues and use one returned CRM user ID.`,
      inputSchema: internalQuestionArgsSchema,
      execute: async (candidate) => {
        const parsed = internalQuestionArgsSchema.safeParse(candidate);
        if (!parsed.success) return { staged: false, reason: "invalid_arguments" };
        input.recordProposal(parsed.data);
        return { staged: true, requiresHumanConfirmation: true, delivered: false };
      },
    }),
  };
}
