import type { AgentRuntime, RuntimeModelBinding } from "@/lib/agent-runtime";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { PiAgentRuntime } from "@/lib/agent-runtime/pi/runtime";

const TEST_MODEL = {
  provider: "crm-test-provider",
  model: "crm-test-model",
  apiKey: "test-key",
};

export function runtimeWithText(text = "ok", onResolve?: (binding: RuntimeModelBinding) => void): AgentRuntime {
  const provider = fauxProvider({
    provider: TEST_MODEL.provider,
    models: [{ id: TEST_MODEL.model }],
  });
  provider.setResponses([fauxAssistantMessage(text)]);
  return new PiAgentRuntime((binding) => {
    onResolve?.(binding);
    return {
      model: provider.getModel() as never,
      streamFn: provider.provider.streamSimple.bind(provider.provider) as never,
    };
  });
}

export function runtimeThatFails(error: Error, onResolve?: (binding: RuntimeModelBinding) => void): AgentRuntime {
  return new PiAgentRuntime((binding) => {
    onResolve?.(binding);
    return Promise.reject(error);
  });
}
