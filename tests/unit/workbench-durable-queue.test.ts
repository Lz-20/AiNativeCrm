import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync("app/api/v1/ai/workbench/runs/route.ts", "utf8");
const decision = readFileSync(
  "app/api/v1/ai/workbench/runs/[id]/proposals/[proposalId]/decision/route.ts",
  "utf8",
);
const approvedAction = readFileSync("lib/ai/agents/workbench-approved-action.ts", "utf8");
const sendDecision = readFileSync("lib/ai/agents/workbench-send-decision-recovery.ts", "utf8");
const worker = readFileSync("workers/agent-worker/main.ts", "utf8");
const startJob = readFileSync("lib/ai/agents/workbench-start-job.ts", "utf8");
const resumeJob = readFileSync("lib/ai/agents/workbench-resume-job.ts", "utf8");
const workbenchUi = readFileSync("app/app/ai/workbench/_components/AgentCrmWorkbench.tsx", "utf8");
const migration = readFileSync(
  "supabase/migrations/20260926030000_0383_workbench_durable_queue.sql",
  "utf8",
);

describe("Workbench durable worker wiring", () => {
  it("persists a queued start before returning and does not use Next after()", () => {
    expect(route).not.toMatch(/\bafter\s*\(/);
    expect(route).toContain('kind: "workbench_start"');
    expect(route).toContain('status: "queued"');
    expect(workbenchUi).toContain('status === "running" || status === "queued"');
    expect(workbenchUi).toContain('["queued", "running", "awaiting_confirmation"].includes(detail.status)');
  });

  it("enqueues human-approved continuation using the persisted proposal as a dedup key", () => {
    expect(decision).toContain("finishWorkbenchApprovedAction(getRequestPool()");
    expect(decision).toContain("finalizeWorkbenchSendDecision(getRequestPool()");
    for (const transactionalWriter of [approvedAction, sendDecision]) {
      expect(transactionalWriter).toContain("(organization_id,kind,source_event_id,payload,max_attempts)");
      expect(transactionalWriter).toContain("values ($1,'workbench_resume',$2,jsonb_build_object('runId',$3::uuid),3)");
      expect(transactionalWriter).toContain("[input.organizationId, input.proposalId, input.runId]");
    }
    expect(sendDecision).toContain("on conflict (organization_id,source_event_id)");
    expect(resumeJob).toContain('.eq("organization_id", job.organization_id)');
    expect(resumeJob).toContain("parseRuntimeMessages(state?.messages)");
  });

  it("registers both durable job handlers outside the contact service-boundary wrapper", () => {
    expect(worker).toContain('handlers.set("workbench_start"');
    expect(worker).toContain('handlers.set("workbench_resume"');
    expect(worker).toContain('job.kind === "workbench_resume" || job.kind === "workbench_start"');
    expect(startJob).toContain("resumeMessages");
  });

  it("allows both tenant-scoped job kinds without requiring a contact id", () => {
    expect(migration).toContain("'workbench_start','workbench_resume'");
    expect(migration).not.toMatch(
      /kind in \([^)]*'workbench_start'[^)]*\)\s*=\s*\(contact_id is not null\)/s,
    );
  });
});
