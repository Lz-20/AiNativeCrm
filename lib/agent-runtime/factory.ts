import type { AgentRuntime } from "./types";
import { PiAgentRuntime } from "./pi/runtime";

/** Composition-root factory; CRM code receives only the AgentRuntime contract. */
export function createAgentRuntime(): AgentRuntime {
  return new PiAgentRuntime();
}
