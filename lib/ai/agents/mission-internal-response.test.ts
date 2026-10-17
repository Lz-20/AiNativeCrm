import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  budget: vi.fn(),
}));
vi.mock("@/lib/agent-engine/queue/queue", () => ({ enqueueJob: mocks.enqueue }));
vi.mock("@/lib/ai/agents/mission-budget", () => ({
  loadMissionBudgetUsage: mocks.budget,
  missionBudgetBlockReason: (usage: { usedTokens: number; maxTotalTokens: number }) =>
    usage.usedTokens >= usage.maxTotalTokens ? "tokens" : null,
}));

import { MissionInternalResponseError, submitMissionInternalResponse,
  submitMissionManagerDirection } from "./mission-internal-response";

const input = {
  organizationId: "org-a",
  missionId: "mission-a",
  actorUserId: "manager-a",
  requestKey: "11111111-1111-4111-8111-111111111111",
  content: "交付团队确认最早下周二可发货",
};

function makePool(options: {
  missingMission?: boolean;
  status?: string;
  deadlineAt?: Date;
  existingDigest?: string;
  existingKind?: string;
  runCount?: number;
  priorStatus?: string;
  versionChanged?: boolean;
  agentPaused?: boolean;
  conversationId?: string;
  missingConversation?: boolean;
  activeSpecialist?: boolean;
  unauthorizedManager?: boolean;
  policyResult?: string;
  currentDirection?: string;
  directionRevision?: number;
  noPendingProposal?: boolean;
  approvalLockBusy?: boolean;
} = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("select exists(select 1 from public.user_organizations"))
        return { rows: [{ authorized: !options.unauthorizedManager }] };
      if (sql.includes("fn_set_ai_mission_send_policy"))
        return { rows: [{ result: { result: options.policyResult ?? "changed" } }] };
      if (sql.includes("for update of m")) return { rows: options.missingMission ? [] : [{
        id: "mission-a", lead_id: "lead-a", contact_id: "contact-a", pipeline_id: "pipeline-a",
        goal: "推进报价", acceptance_criteria: "客户确认价格和交期",
        current_direction: options.currentDirection ?? null,
        direction_revision: options.directionRevision ?? 0,
        customer_send_paused: false,
        status: options.status ?? "waiting_internal", deadline_at: options.deadlineAt ?? null, max_runs: 4,
      }] };
      if (sql.includes("from public.ai_mission_internal_inputs i")) return {
        rows: options.existingDigest ? [{
          run_id: "run-existing", run_status: "completed", content_digest: options.existingDigest,
          actor_user_id: "manager-a", kind: options.existingKind ?? "internal_fact",
        }] : [],
      };
      if (sql.includes("from public.ai_workbench_runs") && sql.includes("run_kind='root'") &&
          sql.includes("order by")) {
        if (options.approvalLockBusy)
          throw Object.assign(new Error("lock busy"), { code: "55P03" });
        return { rows: [{
          id: "run-prior", agent_id: "agent-a", status: options.priorStatus ?? "completed",
          budget: { maxSteps: 6 },
          scope: options.conversationId ? { conversationId: options.conversationId } : {},
          runtime_state: { versionId: "version-a" },
        }] };
      }
      if (sql.includes("count(*)::int")) return { rows: [{ count: options.runCount ?? 1 }] };
      if (sql.includes("select child.id")) return {
        rows: options.activeSpecialist ? [{ id: "specialist-active", parent_run_id: "run-prior" }] : [],
      };
      if (sql.includes("from public.ai_agents a")) return {
        rows: options.versionChanged || options.agentPaused ? [] : [{ operation_revision: 3 }],
      };
      if (sql.includes("from public.conversations")) return {
        rows: options.missingConversation ? [] : [{ reply_context_revision: 8 }],
      };
      if (sql.includes("update public.ai_agent_action_proposals")) return {
        rows: options.noPendingProposal ? [] : [{ id: "proposal-prior" }],
      };
      if (sql.includes("update public.ai_workbench_runs")) return {
        rows: [{ id: sql.includes("parent_run_id=$2") ? "specialist-active" : "run-prior" }],
      };
      if (sql.includes("'run_cancelled'")) return { rows: [{ sequence: 2 }] };
      return { rows: [] };
    }),
  };
  const pool = { connect: vi.fn(async () => client) };
  return { pool: pool as unknown as Pool, client, calls };
}

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue({ job: { id: "job-a" }, deduped: false });
  mocks.budget.mockReset().mockResolvedValue({
    missionId: "mission-a", usedTokens: 10, maxTotalTokens: 100,
  });
});

describe("internal Mission response", () => {
  it("atomically creates one run, a redacted input marker and a queue job", async () => {
    const { pool, client, calls } = makePool({ conversationId: "conversation-a" });
    const result = await submitMissionInternalResponse(pool, input);
    expect(result).toMatchObject({ missionId: "mission-a", missionStatus: "queued", replayed: false });
    const run = calls.find((call) => call.sql.includes("insert into public.ai_workbench_runs"));
    expect(run?.params?.[5]).toContain(input.content);
    expect(run?.params?.[5]).toContain("不等于报价、外发或其他外部动作的批准");
    expect(JSON.parse(String(run?.params?.[6]))).toMatchObject({ conversationId: "conversation-a" });
    expect(JSON.parse(String(run?.params?.[8]))).toMatchObject({ replyContextRevision: 8 });
    const marker = calls.find((call) => call.sql.includes("insert into public.ai_mission_internal_inputs"));
    const event = calls.find((call) => call.sql.includes("insert into public.ai_agent_run_events"));
    expect(JSON.stringify(marker?.params)).not.toContain(input.content);
    expect(JSON.stringify(event?.params)).not.toContain(input.content);
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledWith(client, "org-a", expect.objectContaining({
      kind: "workbench_start", sourceEventId: result.runId,
    }));
    expect(calls.at(-1)?.sql).toBe("commit");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("replays the same request key without a second run, even after the Mission moved on", async () => {
    const digest = createHash("sha256").update(input.content).digest("hex");
    const { pool, calls } = makePool({ status: "needs_review", existingDigest: digest });
    expect(await submitMissionInternalResponse(pool, input)).toMatchObject({
      runId: "run-existing", missionStatus: "needs_review", replayed: true,
    });
    expect(calls.some((call) => call.sql.includes("insert into public.ai_workbench_runs"))).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("rejects a changed payload under the same key", async () => {
    const { pool, calls } = makePool({ existingDigest: "0".repeat(64) });
    await expect(submitMissionInternalResponse(pool, input)).rejects.toMatchObject({ code: "source_conflict" });
    expect(calls.at(-1)?.sql).toBe("rollback");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    [{ missingMission: true }, "not_found"],
    [{ status: "completed" }, "state_conflict"],
    [{ deadlineAt: new Date("2020-01-01") }, "deadline_expired"],
    [{ priorStatus: "running" }, "continuation_unavailable"],
    [{ runCount: 4 }, "continuation_unavailable"],
    [{ activeSpecialist: true }, "continuation_unavailable"],
    [{ versionChanged: true }, "agent_unavailable"],
    [{ agentPaused: true }, "agent_unavailable"],
    [{ conversationId: "conversation-a", missingConversation: true }, "scope_conflict"],
  ] as const)("fails closed when continuation preconditions change: %j", async (options, code) => {
    const { pool } = makePool(options);
    await expect(submitMissionInternalResponse(pool, input)).rejects.toMatchObject({ code });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("uses the exact prior version for both locked built-ins and published user Agents", async () => {
    const { pool, calls } = makePool();
    await submitMissionInternalResponse(pool, input);
    const gate = calls.find((call) => call.sql.includes("from public.ai_agents a"));
    expect(gate?.params).toEqual(["org-a", "agent-a", "version-a"]);
    expect(gate?.sql).toContain("a.origin='builtin'");
    expect(gate?.sql).toContain("a.origin='user'");
    expect(gate?.sql).toContain("a.paused_at is null");
  });

  it("refuses exhausted budget and rolls back a failed enqueue", async () => {
    mocks.budget.mockResolvedValueOnce({ usedTokens: 100, maxTotalTokens: 100 });
    await expect(submitMissionInternalResponse(makePool().pool, input)).rejects.toMatchObject({
      code: "budget_exhausted",
    });
    mocks.enqueue.mockRejectedValueOnce(new Error("queue unavailable"));
    const { pool, calls } = makePool();
    await expect(submitMissionInternalResponse(pool, input)).rejects.toThrow("queue unavailable");
    expect(calls.at(-1)?.sql).toBe("rollback");
  });

  it("rejects invalid text before opening a transaction", async () => {
    const { pool } = makePool();
    await expect(submitMissionInternalResponse(pool, { ...input, content: "x" }))
      .rejects.toBeInstanceOf(MissionInternalResponseError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each(["needs_review", "waiting_customer"])(
    "accepts trusted manager direction at %s, pauses old sends, and queues one scoped Run", async (status) => {
      const { pool, calls } = makePool({ status, conversationId: "conversation-a" });
      const result = await submitMissionManagerDirection(pool, {
        ...input, content: "请改用新报价依据并核对客户诉求",
      });
      expect(result).toMatchObject({ missionStatus: "queued", replayed: false });
      const policyIndex = calls.findIndex((call) => call.sql.includes("fn_set_ai_mission_send_policy"));
      const directionLockIndex = calls.findIndex((call) =>
        call.sql.includes("pg_advisory_xact_lock(hashtextextended"));
      const missionIndex = calls.findIndex((call) => call.sql.includes("for update of m"));
      expect(policyIndex).toBeGreaterThan(-1);
      expect(directionLockIndex).toBeGreaterThan(-1);
      expect(directionLockIndex).toBeLessThan(policyIndex);
      expect(policyIndex).toBeLessThan(missionIndex);
      expect(calls[directionLockIndex]?.params).toEqual([
        "crm_mission_direction:org-a:mission-a",
      ]);
      expect(calls[policyIndex]?.params).toContain("pause_customer_send");
      const run = calls.find((call) => call.sql.includes("insert into public.ai_workbench_runs"));
      expect(run?.params?.[5]).toContain("负责人新方向");
      expect(run?.params?.[5]).toContain("旧客户发送已暂停");
      expect(run?.params?.[5]).toContain("请改用新报价依据");
      expect(JSON.parse(String(run?.params?.[6]))).toMatchObject({ conversationId: "conversation-a" });
      expect(JSON.parse(String(run?.params?.[8]))).toMatchObject({ directionRevision: 1 });
      const marker = calls.find((call) => call.sql.includes("insert into public.ai_mission_internal_inputs"));
      expect(marker?.params?.at(-1)).toBe("manager_direction");
      expect(JSON.stringify(marker?.params)).not.toContain("请改用新报价依据");
      const event = calls.find((call) => call.sql.includes("insert into public.ai_agent_run_events"));
      expect(JSON.stringify(event?.params)).not.toContain("请改用新报价依据");
      expect(mocks.enqueue).toHaveBeenCalledOnce();
      expect(calls.some((call) => call.sql.includes("set current_direction=$3") &&
        call.params?.[2] === "请改用新报价依据并核对客户诉求")).toBe(true);
      expect(calls.at(-1)?.sql).toBe("commit");
    },
  );

  it("does not overflow a manager direction revision", async () => {
    const { pool, calls } = makePool({ status: "needs_review",
      directionRevision: Number.MAX_SAFE_INTEGER });
    await expect(submitMissionManagerDirection(pool, input))
      .rejects.toMatchObject({ code: "state_conflict" });
    expect(calls.at(-1)?.sql).toBe("rollback");
    expect(calls.some((call) => call.sql.includes("insert into public.ai_workbench_runs"))).toBe(false);
  });

  it("replays manager direction without another Run, and conflicts on changed content or kind", async () => {
    const content = "请改用新报价依据并核对客户诉求";
    const digest = createHash("sha256").update(content).digest("hex");
    const { pool, calls } = makePool({ status: "running", existingDigest: digest,
      existingKind: "manager_direction" });
    expect(await submitMissionManagerDirection(pool, {
      ...input, content,
    })).toMatchObject({ runId: "run-existing", replayed: true });
    expect(calls.some((call) => call.sql.includes("insert into public.ai_workbench_runs"))).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    await expect(submitMissionManagerDirection(makePool({ status: "needs_review",
      existingDigest: digest, existingKind: "internal_fact" }).pool, {
      ...input, content,
    })).rejects.toMatchObject({ code: "source_conflict" });
  });

  it("replaces a pending approval atomically before starting a new direction Run", async () => {
    const { pool, calls } = makePool({ status: "waiting_approval",
      priorStatus: "awaiting_confirmation" });
    const result = await submitMissionManagerDirection(pool, input);
    expect(result).toMatchObject({ runStatus: "queued", missionStatus: "queued" });
    const prior = calls.find((call) => call.sql.includes("order by created_at desc,id desc"));
    expect(prior?.sql).toContain("for update nowait");
    const draftIndex = calls.findIndex((call) => call.sql.includes("update public.ai_reply_drafts"));
    const proposalIndex = calls.findIndex((call) => call.sql.includes("update public.ai_agent_action_proposals"));
    const cancelIndex = calls.findIndex((call) => call.sql.includes("update public.ai_workbench_runs"));
    const newRunIndex = calls.findIndex((call) => call.sql.includes("insert into public.ai_workbench_runs"));
    expect(draftIndex).toBeGreaterThan(-1);
    expect(proposalIndex).toBeGreaterThan(draftIndex);
    expect(cancelIndex).toBeGreaterThan(proposalIndex);
    expect(newRunIndex).toBeGreaterThan(cancelIndex);
    expect(calls.some((call) => call.sql.includes("'run_cancelled'") &&
      call.params?.[1] === "run-prior")).toBe(true);
    expect(calls[newRunIndex]?.params?.[5]).toContain("旧待审批动作已撤销");
    expect(calls.at(-1)?.sql).toBe("commit");
  });

  it.each(["queued", "running"])(
    "supersedes an active %s Run before queueing the new direction", async (status) => {
      const { pool, calls } = makePool({ status, priorStatus: status,
        activeSpecialist: status === "running", noPendingProposal: true });
      const result = await submitMissionManagerDirection(pool, input);
      expect(result).toMatchObject({ runStatus: "queued", missionStatus: "queued" });
      const oldRun = calls.find((call) => call.sql.includes("update public.ai_workbench_runs") &&
        call.sql.includes("id=$2 and status=$3"));
      expect(oldRun?.params).toEqual(["org-a", "run-prior", status]);
      expect(calls.find((call) => call.sql.includes("select child.id"))?.sql)
        .toContain("for update of child nowait");
      if (status === "running") {
        const child = calls.find((call) => call.sql.includes("execution_lease_expires_at=null"));
        expect(child?.params).toEqual(["org-a", "run-prior"]);
        expect(calls.filter((call) => call.sql.includes("'run_cancelled'"))).toHaveLength(2);
      }
      const newRun = calls.find((call) => call.sql.includes("insert into public.ai_workbench_runs"));
      expect(newRun?.params?.[5]).toContain("旧运行已停止");
      expect(calls.indexOf(oldRun!)).toBeLessThan(calls.indexOf(newRun!));
      expect(calls.at(-1)?.sql).toBe("commit");
    },
  );

  it("rolls back replacement when the old proposal disappeared or approval owns the Run", async () => {
    for (const options of [
      { status: "waiting_approval", priorStatus: "awaiting_confirmation", noPendingProposal: true },
      { status: "waiting_approval", priorStatus: "running" },
      { status: "waiting_approval", priorStatus: "awaiting_confirmation", approvalLockBusy: true },
    ]) {
      const { pool, calls } = makePool(options);
      await expect(submitMissionManagerDirection(pool, input)).rejects.toMatchObject({
        code: options.priorStatus === "running" ? "continuation_unavailable"
          : options.noPendingProposal ? "continuation_unavailable" : "state_conflict",
      });
      expect(calls.at(-1)?.sql).toBe("rollback");
      expect(calls.some((call) => call.sql.includes("insert into public.ai_workbench_runs"))).toBe(false);
    }
  });

  it.each([
    [{ status: "running", priorStatus: "completed" }, "continuation_unavailable"],
    [{ status: "waiting_internal" }, "state_conflict"],
    [{ unauthorizedManager: true }, "source_unauthorized"],
    [{ policyResult: "unexpected" }, "send_policy_unavailable"],
  ] as const)("rolls back unsafe manager direction: %j", async (options, code) => {
    const { pool, calls } = makePool(options);
    await expect(submitMissionManagerDirection(pool, {
      ...input,
    })).rejects.toMatchObject({ code });
    expect(calls.at(-1)?.sql).toBe("rollback");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("carries the latest manager direction into a later internal-fact continuation", async () => {
    const { pool, calls } = makePool({ currentDirection: "先核对新的报价依据",
      directionRevision: 4 });
    await submitMissionInternalResponse(pool, input);
    const run = calls.find((call) => call.sql.includes("insert into public.ai_workbench_runs"));
    expect(run?.params?.[5]).toContain("当前负责人方向");
    expect(run?.params?.[5]).toContain("先核对新的报价依据");
    expect(JSON.parse(String(run?.params?.[8]))).toMatchObject({ directionRevision: 4 });
  });
});
