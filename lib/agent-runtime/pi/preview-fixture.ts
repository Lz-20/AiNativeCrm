import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type * as FauxProviderModule from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";

import type { AgentRuntime } from "../types";
import { importNativeEsm, isTsxWorker } from "./native-import";
import { PiAgentRuntime } from "./runtime";

/**
 * Deterministic Pi-backed runtime for INTERNAL_AGENT_RUN_STUB.
 *
 * The fixture controls only model responses. CRM tools, retrieval, policies,
 * persistence, and finalization still run through the real harness.
 */
export function createPreviewAgentRuntime(internalQueryMarker: string): AgentRuntime {
  return new PiAgentRuntime(async (binding) => {
    // Pi packages expose ESM imports only. Keep this test-only provider out of
    // the worker's CommonJS-shaped startup graph; tsx rewrites static imports
    // to require() and would otherwise prevent even real-model jobs starting.
    const loadFaux = () => import("@earendil-works/pi-ai/providers/faux");
    const { fauxAssistantMessage, fauxProvider, fauxToolCall } = isTsxWorker()
      ? await importNativeEsm<typeof FauxProviderModule>("@earendil-works/pi-ai/providers/faux")
      : await loadFaux();
    const faux = fauxProvider({
      provider: "crm-preview-provider",
      models: [{ id: binding.model }],
    });

    const response: FauxResponseFactory = (context) => {
      const transcript = JSON.stringify(context.messages);
      const toolResults = context.messages.filter(
        (message): message is Extract<Message, { role: "toolResult" }> =>
          message.role === "toolResult",
      );
      const availableTools = context.messages
        .filter(
          (message): message is Extract<Message, { role: "system" }> => message.role === "system",
        )
        .flatMap((message) => message.toolsAdded ?? []);
      const saw = (name: string) => toolResults.some((message) => message.toolName === name);
      if (availableTools.length === 0) {
        const value = transcript.includes(internalQueryMarker)
          ? "Pelo que está registrado, o cliente pediu um desconto acima da política. A IA travou porque a política permite até 10%."
          : transcript.includes("Turno interno de memória")
            ? {
                notes: [
                  {
                    headline: "Preferência do cenário",
                    body: "Atendimento com confirmação humana.",
                  },
                ],
              }
            : transcript.includes("Compacte a conversa")
              ? {
                  commitments: [],
                  objections: [],
                  personal_data: [],
                  stage: null,
                  rolling_summary: "Cenário resumido para revisão.",
                }
              : {
                  commitments: [],
                  objections: [],
                  next_action: null,
                  rolling_summary: "Resposta proposta para revisão humana.",
                  declaracao: { promessas: [] },
                };
        return fauxAssistantMessage(typeof value === "string" ? value : JSON.stringify(value));
      }

      const has = (name: string) => availableTools.some((tool) => tool.name === name);
      const name =
        has("search_knowledge") && !saw("search_knowledge")
          ? "search_knowledge"
          : !saw("send_message")
            ? "send_message"
            : null;
      return name
        ? fauxAssistantMessage(
            fauxToolCall(
              name,
              name === "search_knowledge"
                ? { query: "informações de atendimento" }
                : {
                    body: "Olá! Posso ajudar com as informações do atendimento. O que você gostaria de saber?",
                  },
            ),
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage("Sugestão registrada.");
    };

    faux.setResponses(Array.from({ length: 32 }, () => response));

    return {
      model: faux.getModel() as never,
      streamFn: faux.provider.streamSimple.bind(faux.provider) as never,
    };
  });
}
