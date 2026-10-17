import { describe, expect, it } from "vitest";

import {
  OPPORTUNITY_REVIEW_PLAN,
  type AgentSpecialistResult,
  type AgentSpecialistTask,
} from "@/lib/ai/agents/collaboration";
import {
  BoundedAgentCollaborationRuntime,
  type AgentCollaborationStore,
  type AgentSpecialistExecutor,
  type DurableSpecialistRun,
} from "@/lib/ai/agents/collaboration-runtime";

function tasks(): AgentSpecialistTask[] {
  return OPPORTUNITY_REVIEW_PLAN.specialists.map((specialist) => ({
    parentRunId: "parent-1",
    organizationId: "org-1",
    task: "review opportunity",
    specialist,
    scope: { leadId: "lead-1" },
  }));
}

class FakeStore implements AgentCollaborationStore {
  readonly children = new Map<string, DurableSpecialistRun>();
  readonly events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  readonly cancelled: string[] = [];
  readonly attempts = new Map<string, string>();
  private attemptSequence = 0;

  async ensureChild(_plan: typeof OPPORTUNITY_REVIEW_PLAN, task: AgentSpecialistTask) {
    const found = this.children.get(task.specialist.key);
    if (found) return found;
    const child = { id: `child-${task.specialist.key}`, status: "queued" as const };
    this.children.set(task.specialist.key, child);
    return child;
  }
  async claimChild(childRunId: string, _leaseSeconds: number) {
    const key = childRunId.replace("child-", "");
    const attempt = `attempt-${++this.attemptSequence}`;
    this.attempts.set(childRunId, attempt);
    this.children.set(key, { id: childRunId, status: "running" });
    return attempt;
  }
  async completeChild(
    childRunId: string,
    executionAttemptId: string,
    result: AgentSpecialistResult,
  ) {
    if (this.attempts.get(childRunId) !== executionAttemptId)
      throw new Error("specialist_execution_attempt_stale");
    this.children.set(result.specialistKey, { id: childRunId, status: "completed", result });
  }
  async failChild(childRunId: string, executionAttemptId: string) {
    if (this.attempts.get(childRunId) !== executionAttemptId)
      throw new Error("specialist_execution_attempt_stale");
    const key = childRunId.replace("child-", "");
    this.children.set(key, { id: childRunId, status: "failed" });
  }
  async cancelChild(childRunId: string, executionAttemptId: string) {
    if (this.attempts.get(childRunId) !== executionAttemptId) return;
    this.cancelled.push(childRunId);
    const key = childRunId.replace("child-", "");
    this.children.set(key, { id: childRunId, status: "cancelled" });
  }
  async cancelPendingChildren() {
    for (const [key, child] of this.children) {
      if (child.status !== "queued" && child.status !== "running") continue;
      if (!this.cancelled.includes(child.id)) this.cancelled.push(child.id);
      this.children.set(key, { id: child.id, status: "cancelled" });
    }
  }
  async appendParentEvent(type: string, payload: Record<string, unknown>) {
    this.events.push({ type, payload });
  }
}

function completed(toolCalls = 2): Omit<AgentSpecialistResult, "childRunId" | "specialistKey"> {
  return {
    status: "complete",
    summary: "evidence summary",
    evidence: [],
    claims: [],
    missingMaterial: [],
    toolCalls,
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      costCents: 1,
      modelTurns: 2,
    },
  };
}

describe("bounded Agent collaboration runtime", () => {
  it("runs independent read specialists concurrently under one aggregate budget", async () => {
    const store = new FakeStore();
    let active = 0;
    let maxActive = 0;
    const executor: AgentSpecialistExecutor = {
      execute: async ({ claimToolCall }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        expect(claimToolCall()).toBe(true);
        expect(claimToolCall()).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return completed();
      },
    };
    const outcome = await new BoundedAgentCollaborationRuntime(
      store,
      executor,
    ).runReadOnlySpecialists(OPPORTUNITY_REVIEW_PLAN, tasks(), new AbortController().signal);

    expect(outcome.status).toBe("complete");
    expect(outcome.results).toHaveLength(3);
    expect(outcome.usage).toMatchObject({ toolCalls: 6, modelTurns: 6 });
    expect(maxActive).toBeGreaterThan(1);
    expect(store.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "collaboration_started",
        "specialist_started",
        "specialist_completed",
        "collaboration_completed",
      ]),
    );
  });

  it("reuses a completed durable child instead of repeating model/tool work", async () => {
    const store = new FakeStore();
    const recovered: AgentSpecialistResult = {
      childRunId: "child-customer_evidence",
      specialistKey: "customer_evidence",
      ...completed(1),
    };
    store.children.set("customer_evidence", {
      id: recovered.childRunId,
      status: "completed",
      result: recovered,
    });
    let calls = 0;
    const executor: AgentSpecialistExecutor = {
      execute: async () => {
        calls += 1;
        return completed();
      },
    };
    const outcome = await new BoundedAgentCollaborationRuntime(
      store,
      executor,
    ).runReadOnlySpecialists(
      OPPORTUNITY_REVIEW_PLAN,
      tasks().slice(0, 1),
      new AbortController().signal,
    );
    expect(calls).toBe(0);
    expect(outcome.results[0]).toEqual(recovered);
  });

  it("on restart reuses completed children and reruns only unfinished specialists", async () => {
    const store = new FakeStore();
    const completedCustomer: AgentSpecialistResult = {
      childRunId: "child-customer_evidence",
      specialistKey: "customer_evidence",
      ...completed(1),
    };
    store.children.set("customer_evidence", {
      id: completedCustomer.childRunId,
      status: "completed",
      result: completedCustomer,
    });
    store.children.set("opportunity_diagnosis", {
      id: "child-opportunity_diagnosis",
      status: "failed",
    });
    const executed: string[] = [];
    const executor: AgentSpecialistExecutor = {
      execute: async ({ task }) => {
        executed.push(task.specialist.key);
        return completed();
      },
    };

    const outcome = await new BoundedAgentCollaborationRuntime(
      store,
      executor,
    ).runReadOnlySpecialists(OPPORTUNITY_REVIEW_PLAN, tasks(), new AbortController().signal);

    expect(executed.sort()).toEqual(["opportunity_diagnosis", "policy_advisor"]);
    expect(outcome.status).toBe("complete");
  });

  it("rejects a late completion from a stale execution attempt", async () => {
    const store = new FakeStore();
    const child = await store.ensureChild(OPPORTUNITY_REVIEW_PLAN, tasks()[0]!);
    const staleAttempt = await store.claimChild(child.id, 120);
    const currentAttempt = await store.claimChild(child.id, 120);
    const result: AgentSpecialistResult = {
      childRunId: child.id,
      specialistKey: "customer_evidence",
      ...completed(),
    };

    await expect(store.completeChild(child.id, staleAttempt, result)).rejects.toThrow(
      "specialist_execution_attempt_stale",
    );
    await expect(store.completeChild(child.id, currentAttempt, result)).resolves.toBeUndefined();
  });

  it("propagates cancellation and persists child cancellation", async () => {
    const store = new FakeStore();
    const controller = new AbortController();
    const executor: AgentSpecialistExecutor = {
      execute: ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          setTimeout(() => resolve(completed()), 100);
        }),
    };
    const running = new BoundedAgentCollaborationRuntime(store, executor).runReadOnlySpecialists(
      { ...OPPORTUNITY_REVIEW_PLAN, timeoutMs: 500 },
      tasks().slice(0, 1),
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("user_cancelled")), 10);
    await expect(running).rejects.toThrow("user_cancelled");
    expect(store.cancelled).toEqual(["child-customer_evidence"]);
  });

  it("cancels queued future children when the parent is cancelled", async () => {
    const store = new FakeStore();
    store.children.set("opportunity_diagnosis", {
      id: "child-opportunity_diagnosis",
      status: "queued",
    });
    const controller = new AbortController();
    const executor: AgentSpecialistExecutor = {
      execute: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    };
    const running = new BoundedAgentCollaborationRuntime(store, executor).runReadOnlySpecialists(
      { ...OPPORTUNITY_REVIEW_PLAN, maxParallel: 1, timeoutMs: 500 },
      tasks().slice(0, 2),
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("user_cancelled")), 10);

    await expect(running).rejects.toThrow("user_cancelled");
    expect(store.cancelled.sort()).toEqual([
      "child-customer_evidence",
      "child-opportunity_diagnosis",
    ]);
  });

  it("surfaces a field conflict from privacy-preserving structured claims", async () => {
    const base = completed(1);
    const claims = (specialistKey: string, valueHash: string, revision: string) => [
      {
        id: `${specialistKey}-claim`,
        specialistKey,
        subject: { resource: "lead", id: "lead-1" },
        field: "stage_id",
        valueHash,
        valueType: "string" as const,
        locator: { provider: "crm_tool", sourceId: "lead:lead-1", revision },
      },
    ];
    const store = new FakeStore();
    const executor: AgentSpecialistExecutor = {
      execute: async ({ task }) => ({
        ...base,
        claims:
          task.specialist.key === "customer_evidence"
            ? claims(task.specialist.key, "hash-a", "1")
            : claims(task.specialist.key, "hash-b", "2"),
      }),
    };
    const outcome = await new BoundedAgentCollaborationRuntime(
      store,
      executor,
    ).runReadOnlySpecialists(
      { ...OPPORTUNITY_REVIEW_PLAN, maxParallel: 2 },
      tasks().slice(0, 2),
      new AbortController().signal,
    );

    expect(outcome.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "evidence_disagreement", field: "lead:lead-1:stage_id" }),
        expect.objectContaining({ code: "stale_state", field: "lead:lead-1" }),
      ]),
    );
  });
});

describe("Wiki fragment conflict identity", () => {
  const evidence = (id: string, excerpt: string, revision = "v1") => ({
    id, namespace: "organization_wiki" as const, kind: "wiki_page" as const,
    title: "Wiki", excerpt, locator: { provider: "local_pgvector", sourceId: "source", revision },
  });
  const results = (second: ReturnType<typeof evidence>): AgentSpecialistResult[] => [
    { ...completed(), childRunId: "a", specialistKey: "a", evidence: [evidence("chunk-1", "Price") ] },
    { ...completed(), childRunId: "b", specialistKey: "b", evidence: [second] },
  ];
  it("does not report complementary paragraphs as conflicting business facts", async () => {
    const { detectCollaborationConflicts } = await import("./collaboration-runtime");
    expect(detectCollaborationConflicts(results(evidence("chunk-2", "Delivery")))).toEqual([]);
  });
  it("flags changed excerpts of the same versioned chunk", async () => {
    const { detectCollaborationConflicts } = await import("./collaboration-runtime");
    expect(detectCollaborationConflicts(results(evidence("chunk-1", "Different price"))))
      .toEqual([expect.objectContaining({ code: "evidence_disagreement" })]);
  });
  it("still flags different source revisions even when reindexing created new chunk IDs", async () => {
    const { detectCollaborationConflicts } = await import("./collaboration-runtime");
    expect(detectCollaborationConflicts(results(evidence("chunk-new", "New price", "v2"))))
      .toEqual([expect.objectContaining({ code: "stale_state" })]);
  });
});
