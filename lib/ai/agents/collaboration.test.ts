import { describe, expect, it } from "vitest";

import {
  collaborationPlanForMission,
  OPPORTUNITY_REVIEW_PLAN,
  selectCollaborationPlan,
  validateCollaborationPlan,
} from "@/lib/ai/agents/collaboration";
import { builtinAgent } from "@/lib/ai/agents/builtins";

describe("bounded opportunity-review collaboration", () => {
  it("keeps every specialist read-only and the parent as the only writer", () => {
    expect(validateCollaborationPlan(OPPORTUNITY_REVIEW_PLAN)).toEqual([]);
    expect(OPPORTUNITY_REVIEW_PLAN.writer).toBe("parent_only");
    expect(OPPORTUNITY_REVIEW_PLAN.specialists.every((item) => item.effect === "read")).toBe(true);
  });

  it("covers independent customer, opportunity and policy evidence domains", () => {
    expect(OPPORTUNITY_REVIEW_PLAN.specialists.map((item) => item.key)).toEqual([
      "customer_evidence",
      "opportunity_diagnosis",
      "policy_advisor",
    ]);
  });

  it("selects collaboration only for an opportunity-scoped eligible built-in", () => {
    expect(
      selectCollaborationPlan({ builtinKey: "crm_supervisor", leadId: "lead-1" })?.key,
    ).toBe("opportunity_review_v1");
    expect(selectCollaborationPlan({ builtinKey: "crm_supervisor" })).toBeNull();
    expect(
      selectCollaborationPlan({
        builtinKey: "sales_operations",
        leadId: "lead-1",
        disabled: true,
      }),
    ).toBeNull();
    expect(
      selectCollaborationPlan({ builtinKey: "crm_intelligence", leadId: "lead-1" }),
    ).toBeNull();
  });

  it("avoids specialist fan-out for a simple follow-up but keeps it for diagnosis", () => {
    expect(selectCollaborationPlan({
      builtinKey: "sales_operations",
      leadId: "lead-1",
      task: "为这个商机补一条明天的跟进任务",
    })).toBeNull();
    expect(selectCollaborationPlan({
      builtinKey: "sales_operations",
      leadId: "lead-1",
      task: "复盘这个商机停滞的原因，并核对政策依据",
    })?.key).toBe("opportunity_review_v1");
  });

  it("serializes Mission specialists without slowing standalone opportunity reviews", () => {
    expect(collaborationPlanForMission(OPPORTUNITY_REVIEW_PLAN, null)).toBe(OPPORTUNITY_REVIEW_PLAN);
    const missionPlan = collaborationPlanForMission(OPPORTUNITY_REVIEW_PLAN, "mission-1");
    expect(missionPlan.maxParallel).toBe(1);
    expect(missionPlan.specialists).toBe(OPPORTUNITY_REVIEW_PLAN.specialists);
    expect(OPPORTUNITY_REVIEW_PLAN.maxParallel).toBe(3);
    expect(validateCollaborationPlan(missionPlan)).toEqual([]);
  });

  it("declares every delegated specialist tool on each eligible built-in", () => {
    const delegated = new Set(
      OPPORTUNITY_REVIEW_PLAN.specialists.flatMap((specialist) => specialist.allowedToolIds),
    );
    for (const key of ["sales_operations", "crm_supervisor"] as const) {
      const agentTools = new Set(builtinAgent(key)?.toolIds ?? []);
      expect([...delegated].filter((toolId) => !agentTools.has(toolId)), key).toEqual([]);
    }
  });
});
