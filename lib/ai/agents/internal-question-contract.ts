import { z } from "zod";

export const LIST_INTERNAL_COLLEAGUES_TOOL = "list_internal_colleagues";
export const ASK_INTERNAL_COLLEAGUE_TOOL = "ask_internal_colleague";

export const internalQuestionArgsSchema = z.object({
  recipientUserId: z.string().uuid(),
  question: z.string().trim().min(5).max(1000),
}).strict();

export type InternalQuestionArgs = z.infer<typeof internalQuestionArgsSchema>;

/** This native capability never attaches to read-only Agents or unscoped runs. */
export function canExposeInternalQuestionTools(input: {
  mode: string;
  missionId: string | null;
  leadId: string | null;
  builtinKey: string | null | undefined;
}): boolean {
  return input.mode === "act" && Boolean(input.missionId && input.leadId) &&
    input.builtinKey === "crm_supervisor";
}
