import { describe, expect, it } from "vitest";
import { VALID_TOOL_IDS } from "@/lib/mcp/tools/catalog";
import { BUILTIN_AGENTS, builtinAgent } from "./builtins";

describe("built-in CRM agents", () => {
  it("registers four stable keys with three runnable scenarios each", () => {
    expect(BUILTIN_AGENTS.map((agent) => agent.key)).toEqual([
      "crm_intelligence",
      "sales_operations",
      "customer_communications",
      "crm_supervisor",
    ]);
    for (const agent of BUILTIN_AGENTS) {
      expect(agent.revision).toBeGreaterThan(0);
      expect(agent.systemPrompt.length).toBeGreaterThan(80);
      expect(agent.scenarios).toHaveLength(3);
      expect(agent.scenarios.every((scenario) => scenario.task && scenario.harnessFocus)).toBe(
        true,
      );
      expect(agent.knowledgePolicy.namespaces.length).toBeGreaterThan(0);
      expect(agent.evalProfile).toMatch(/_v1$/);
      for (const toolId of agent.toolIds) {
        expect(
          VALID_TOOL_IDS,
          `${agent.key}: ${toolId} must exist in the CRM tool catalog`,
        ).toContain(toolId);
      }
    }
  });

  it("does not resolve unknown keys", () => {
    expect(builtinAgent("made_up")).toBeUndefined();
  });

  it("grants human handoff only to the communications Agent", () => {
    expect(builtinAgent("customer_communications")?.toolIds).toContain("crm_request_human_handoff");
    expect(builtinAgent("crm_intelligence")?.toolIds).not.toContain("crm_request_human_handoff");
  });

  it("gives every Agent that declares wiki access a real knowledge tool", () => {
    for (const agent of BUILTIN_AGENTS) {
      if (agent.knowledgePolicy.namespaces.includes("organization_wiki"))
        expect(agent.toolIds, agent.key).toContain("crm_search_knowledge");
    }
  });
});
