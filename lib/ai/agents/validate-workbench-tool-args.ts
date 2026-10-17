import { z } from "zod";
import { getToolByName } from "@/lib/mcp/tools";
import { ASK_INTERNAL_COLLEAGUE_TOOL, internalQuestionArgsSchema } from "@/lib/ai/agents/internal-question-contract";

/** Re-run the CRM tool's own schema at the human-approval boundary. */
export function validateWorkbenchToolArgs(
  toolName: string,
  raw: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false } {
  if (toolName === "send_message") {
    const parsed = z.object({ body: z.string().trim().min(1).max(12000) }).strict().safeParse(raw);
    return parsed.success ? { ok: true, args: parsed.data } : { ok: false };
  }
  if (toolName === ASK_INTERNAL_COLLEAGUE_TOOL) {
    const parsed = internalQuestionArgsSchema.safeParse(raw);
    return parsed.success ? { ok: true, args: parsed.data } : { ok: false };
  }
  const definition = getToolByName(toolName);
  if (!definition || !raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const parsed = z.object(definition.inputSchema as z.ZodRawShape).safeParse(raw);
  if (!parsed.success) return { ok: false };
  return { ok: true, args: parsed.data as Record<string, unknown> };
}
