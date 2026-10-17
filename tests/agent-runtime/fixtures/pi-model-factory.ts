import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";

import type { AgentRuntime } from "@/lib/agent-runtime";
import { PiAgentRuntime } from "@/lib/agent-runtime/pi/runtime";

type LegacyPromptMessage = { role: string; content: Array<Record<string, unknown>> };
type LegacyTool = { type: "function"; name: string; description?: string; parameters?: unknown };
type LegacyFactoryOptions = { prompt: LegacyPromptMessage[]; tools: LegacyTool[] };
type LegacyFactoryPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId?: string; toolName: string; input: string };

/**
 * Transitional test seam for DB/invariant fixtures. The fixtures already encode
 * useful scenario decisions in a Vercel-shaped callback; this adapter preserves
 * those decisions while the actual turn runs through Pi's model/tool lifecycle.
 * It is test-only and never imported by production code.
 */
export function runtimeFromModelFactory(
  factory: (options: LegacyFactoryOptions) => Promise<{ content?: LegacyFactoryPart[] }>,
): AgentRuntime {
  return new PiAgentRuntime((binding) => {
    const faux = fauxProvider({
      provider: "crm-invariant-provider",
      models: [{ id: binding.model }],
    });

    const response: FauxResponseFactory = async (context) => {
      const prompt: LegacyPromptMessage[] = context.messages.map((message) => {
        const item = message as unknown as {
          role: string;
          content?: unknown;
          toolCallId?: string;
          toolName?: string;
          isError?: boolean;
        };
        if (item.role !== "toolResult") {
          return {
            role: item.role,
            content:
              typeof item.content === "string"
                ? [{ type: "text", text: item.content }]
                : Array.isArray(item.content)
                  ? (item.content as Array<Record<string, unknown>>)
                  : [],
          };
        }
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              output: item.content,
              isError: item.isError,
            },
          ],
        };
      });
      const tools: LegacyTool[] = context.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => {
          const item = message as unknown as { toolsAdded?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
          return (item.toolsAdded ?? []).map((tool) => ({
            type: "function" as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          }));
        });

      const result = await factory({ prompt, tools });
      const parts: unknown[] = [];
      for (const part of result.content ?? []) {
        if (part.type === "text") {
          parts.push(part);
          continue;
        }
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(part.input) as Record<string, unknown>;
        } catch {
          // Pi's faux tool call still gives the fixture a deterministic error path.
        }
        parts.push(fauxToolCall(part.toolName, args as never));
      }
      const hasToolCall = (result.content ?? []).some((part) => part.type === "tool-call");
      return fauxAssistantMessage(parts as never, { stopReason: hasToolCall ? "toolUse" : "stop" });
    };

    faux.setResponses(Array.from({ length: 64 }, () => response));
    return {
      model: faux.getModel() as never,
      streamFn: faux.provider.streamSimple.bind(faux.provider) as never,
    };
  });
}
