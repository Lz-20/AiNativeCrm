import type {
  AgentCollaborationConflict,
  AgentCollaborationOutcome,
  AgentCollaborationPlan,
  AgentSpecialistResult,
  AgentSpecialistTask,
} from "@/lib/ai/agents/collaboration";

export interface DurableSpecialistRun {
  id: string;
  status: "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
  result?: AgentSpecialistResult;
}

export interface AgentCollaborationStore {
  ensureChild(
    plan: AgentCollaborationPlan,
    task: AgentSpecialistTask,
  ): Promise<DurableSpecialistRun>;
  claimChild(childRunId: string, leaseSeconds: number): Promise<string>;
  completeChild(
    childRunId: string,
    executionAttemptId: string,
    result: AgentSpecialistResult,
  ): Promise<void>;
  failChild(
    childRunId: string,
    executionAttemptId: string,
    code: string,
    errorType: string,
  ): Promise<void>;
  cancelChild(childRunId: string, executionAttemptId: string): Promise<void>;
  cancelPendingChildren(): Promise<void>;
  appendParentEvent(type: string, payload: Record<string, unknown>): Promise<void>;
}

export interface AgentSpecialistExecutor {
  execute(input: {
    childRunId: string;
    plan: AgentCollaborationPlan;
    task: AgentSpecialistTask;
    signal: AbortSignal;
    claimToolCall: () => boolean;
  }): Promise<Omit<AgentSpecialistResult, "childRunId" | "specialistKey">>;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error("collaboration_cancelled");
}

function combineCost(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === values.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

export function detectCollaborationConflicts(
  results: readonly AgentSpecialistResult[],
): AgentCollaborationConflict[] {
  const conflicts: AgentCollaborationConflict[] = [];
  const conflictKeys = new Set<string>();
  const appendConflict = (conflict: AgentCollaborationConflict) => {
    const key = `${conflict.code}:${conflict.field ?? ""}:${[...conflict.specialistKeys].sort().join(",")}`;
    if (conflictKeys.has(key)) return;
    conflictKeys.add(key);
    conflicts.push(conflict);
  };
  for (const result of results) {
    if (result.status === "failed")
      appendConflict({
        code: "specialist_failure",
        specialistKeys: [result.specialistKey],
        message: `${result.specialistKey} 未能形成可用结论。`,
      });
  }
  const claimsByField = new Map<
    string,
    { valueHash: string; specialistKey: string; revision?: string }
  >();
  for (const result of results) {
    for (const claim of result.claims) {
      const key = `${claim.subject.resource}:${claim.subject.id}:${claim.field}`;
      const current = claimsByField.get(key);
      if (current && current.specialistKey !== result.specialistKey) {
        if (current.valueHash !== claim.valueHash)
          appendConflict({
            code: "evidence_disagreement",
            specialistKeys: [current.specialistKey, result.specialistKey],
            field: key,
            message: "两个 specialist 对同一 CRM 字段观察到不同值，父 Agent 必须显式核对。",
          });
        if (
          current.revision &&
          claim.locator.revision &&
          current.revision !== claim.locator.revision
        )
          appendConflict({
            code: "stale_state",
            specialistKeys: [current.specialistKey, result.specialistKey],
            field: `${claim.subject.resource}:${claim.subject.id}`,
            message: "两个 specialist 读取了同一 CRM 对象的不同 revision，写入前必须重新读取。",
          });
      }
      if (!current)
        claimsByField.set(key, {
          valueHash: claim.valueHash,
          specialistKey: result.specialistKey,
          revision: claim.locator.revision,
        });
    }
  }
  const sources = new Map<string, { specialistKey: string; revision?: string }>();
  const excerpts = new Map<string, { excerpt: string; specialistKey: string }>();
  for (const result of results) {
    for (const evidence of result.evidence) {
      const sourceKey = `${evidence.locator.provider}:${evidence.locator.sourceId}`;
      const source = sources.get(sourceKey);
      // Reindexing creates new chunk IDs. Compare source revisions separately
      // so differing chunks cannot hide that specialists observed different indexes.
      if (
        source &&
        source.specialistKey !== result.specialistKey &&
        source.revision &&
        evidence.locator.revision &&
        source.revision !== evidence.locator.revision
      )
        appendConflict({
          code: "stale_state",
          specialistKeys: [source.specialistKey, result.specialistKey],
          field: sourceKey,
          message: "两个 specialist 读取了同一来源的不同 revision，写入前必须重新读取。",
        });
      if (!source)
        sources.set(sourceKey, {
          specialistKey: result.specialistKey,
          revision: evidence.locator.revision,
        });
      // Different paragraphs from one document are complementary evidence, not
      // contradictory claims. Only compare excerpts of the same immutable item.
      const key = `${sourceKey}:${evidence.locator.revision ?? ""}:${evidence.id}`;
      const current = excerpts.get(key);
      if (
        current &&
        current.specialistKey !== result.specialistKey &&
        current.excerpt.trim() !== evidence.excerpt.trim()
      )
        appendConflict({
          code: "evidence_disagreement",
          specialistKeys: [current.specialistKey, result.specialistKey],
          field: key,
          message: "两个 specialist 对同一版本的同一证据片段给出了不同摘录，需要核对原文。",
        });
      if (!current)
        excerpts.set(key, { excerpt: evidence.excerpt, specialistKey: result.specialistKey });
    }
  }
  return conflicts;
}

/**
 * Durable bounded collaboration. The runtime owns concurrency, aggregate tool
 * budget, timeout/cancellation and child lifecycle; specialists only execute a
 * read-only Agent loop supplied through the executor port.
 */
export class BoundedAgentCollaborationRuntime {
  constructor(
    private readonly store: AgentCollaborationStore,
    private readonly executor: AgentSpecialistExecutor,
  ) {}

  async runReadOnlySpecialists(
    plan: AgentCollaborationPlan,
    tasks: AgentSpecialistTask[],
    callerSignal: AbortSignal,
  ): Promise<AgentCollaborationOutcome> {
    if (tasks.length === 0)
      return {
        planKey: plan.key,
        status: "failed",
        results: [],
        conflicts: [],
        usage: { toolCalls: 0, inputTokens: 0, outputTokens: 0, costCents: 0, modelTurns: 0 },
      };
    const timeout = AbortSignal.timeout(plan.timeoutMs);
    const runtimeAbort = new AbortController();
    const signal = AbortSignal.any([callerSignal, timeout, runtimeAbort.signal]);
    signal.throwIfAborted();
    let toolCalls = 0;
    const claimToolCall = () => {
      if (toolCalls >= plan.maxTotalToolCalls) return false;
      toolCalls += 1;
      return true;
    };
    let parentEvents = Promise.resolve();
    const appendParent = (type: string, payload: Record<string, unknown>) => {
      parentEvents = parentEvents.then(() => this.store.appendParentEvent(type, payload));
      return parentEvents;
    };
    await appendParent("collaboration_started", {
      planKey: plan.key,
      planRevision: plan.revision,
      specialistCount: tasks.length,
      maxParallel: plan.maxParallel,
    });

    const results: AgentSpecialistResult[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < tasks.length) {
        if (signal.aborted) throw abortError(signal);
        const task = tasks[cursor++]!;
        const child = await this.store.ensureChild(plan, task);
        if ((child.status === "completed" || child.status === "partial") && child.result) {
          results.push(child.result);
          await appendParent("specialist_completed", {
            childRunId: child.id,
            specialistKey: child.result.specialistKey,
            status: child.result.status,
            toolCalls: child.result.toolCalls,
            evidenceCount: child.result.evidence.length,
            claimCount: child.result.claims.length,
            missingMaterialCount: child.result.missingMaterial.length,
          });
          continue;
        }
        const executionAttemptId = await this.store.claimChild(
          child.id,
          Math.max(30, Math.min(1_800, Math.ceil(plan.timeoutMs / 1_000) + 30)),
        );
        await appendParent("specialist_started", {
          childRunId: child.id,
          specialistKey: task.specialist.key,
          role: task.specialist.role,
        });
        let executed: Omit<AgentSpecialistResult, "childRunId" | "specialistKey">;
        try {
          executed = await this.executor.execute({
            childRunId: child.id,
            plan,
            task,
            signal,
            claimToolCall,
          });
        } catch (error) {
          const errorType = error instanceof Error ? error.name : "runtime_error";
          if (signal.aborted) {
            await this.store.cancelChild(child.id, executionAttemptId);
            await appendParent("specialist_failed", {
              childRunId: child.id,
              specialistKey: task.specialist.key,
              code: "cancelled_or_timeout",
              errorType,
            });
            throw abortError(signal);
          }
          await this.store.failChild(
            child.id,
            executionAttemptId,
            "specialist_runtime_failed",
            errorType,
          );
          const failed: AgentSpecialistResult = {
            childRunId: child.id,
            specialistKey: task.specialist.key,
            status: "failed",
            summary: "",
            evidence: [],
            claims: [],
            missingMaterial: ["specialist_result"],
            toolCalls: 0,
            usage: { inputTokens: 0, outputTokens: 0, costCents: null, modelTurns: 0 },
          };
          results.push(failed);
          await appendParent("specialist_failed", {
            childRunId: child.id,
            specialistKey: task.specialist.key,
            code: "specialist_runtime_failed",
            errorType,
          });
          continue;
        }
        const result: AgentSpecialistResult = {
          childRunId: child.id,
          specialistKey: task.specialist.key,
          ...executed,
        };
        await this.store.completeChild(child.id, executionAttemptId, result);
        results.push(result);
        await appendParent("specialist_completed", {
          childRunId: child.id,
          specialistKey: result.specialistKey,
          status: result.status,
          toolCalls: result.toolCalls,
          evidenceCount: result.evidence.length,
          claimCount: result.claims.length,
          missingMaterialCount: result.missingMaterial.length,
        });
      }
    };

    let firstWorkerFailure: unknown;
    const guardedWorker = async () => {
      try {
        await worker();
      } catch (error) {
        firstWorkerFailure ??= error;
        if (!signal.aborted) runtimeAbort.abort(error);
        throw error;
      }
    };
    await Promise.allSettled(
      Array.from({ length: Math.min(plan.maxParallel, tasks.length) }, () => guardedWorker()),
    );
    if (callerSignal.aborted || timeout.aborted) {
      await this.store.cancelPendingChildren();
      throw abortError(callerSignal.aborted ? callerSignal : timeout);
    }
    if (firstWorkerFailure) throw firstWorkerFailure;
    signal.throwIfAborted();
    await parentEvents;
    const ordered = tasks.map((task) =>
      results.find((result) => result.specialistKey === task.specialist.key)!,
    );
    const conflicts = detectCollaborationConflicts(ordered);
    for (const conflict of conflicts)
      await appendParent("collaboration_conflict", {
        code: conflict.code,
        specialistKeys: conflict.specialistKeys,
        field: conflict.field,
      });
    const completed = ordered.filter((result) => result.status === "complete").length;
    const failed = ordered.filter((result) => result.status === "failed").length;
    const status =
      completed === 0
        ? "failed"
        : failed > 0 || completed < ordered.length
          ? "partial"
          : "complete";
    const outcome: AgentCollaborationOutcome = {
      planKey: plan.key,
      status,
      results: ordered,
      conflicts,
      usage: {
        toolCalls,
        inputTokens: ordered.reduce((sum, result) => sum + result.usage.inputTokens, 0),
        outputTokens: ordered.reduce((sum, result) => sum + result.usage.outputTokens, 0),
        costCents: combineCost(ordered.map((result) => result.usage.costCents)),
        modelTurns: ordered.reduce((sum, result) => sum + result.usage.modelTurns, 0),
      },
    };
    await appendParent("collaboration_completed", {
      planKey: plan.key,
      status,
      completedSpecialists: completed,
      failedSpecialists: failed,
      toolCalls,
      conflictCount: conflicts.length,
    });
    return outcome;
  }
}

export function formatCollaborationContext(outcome: AgentCollaborationOutcome): string {
  const maxSummaryCharacters = 2_400;
  const sections = outcome.results.map((result) => {
    const missing = result.missingMaterial.length
      ? `缺失材料：${result.missingMaterial.join(", ")}`
      : "缺失材料：无";
    const rawSummary = result.summary || "该 specialist 未形成摘要。";
    const summary =
      rawSummary.length > maxSummaryCharacters
        ? `${rawSummary.slice(0, maxSummaryCharacters).trimEnd()}\n\n[摘要已截断；完整结果保存在 child run ${result.childRunId}]`
        : rawSummary;
    return [
      `### ${result.specialistKey} (${result.status})`,
      `child_run_id: ${result.childRunId}`,
      summary,
      missing,
      `证据条目：${result.evidence.length}；工具调用：${result.toolCalls}`,
      `结构化 Claims：${result.claims.length}`,
      `可引用证据 ID（最多 12 条）：${
        result.evidence
          .slice(0, 12)
          .map((evidence) => evidence.id)
          .join(", ") || "无"
      }`,
    ].join("\n");
  });
  const conflicts = outcome.conflicts.length
    ? outcome.conflicts.map((item) => `- ${item.code}: ${item.message}`).join("\n")
    : "- 无结构化冲突。";
  return [
    "\n\n以下是独立、只读 specialist 的持久化审查结果。它们不是已执行的 CRM 动作；请综合它们，显式保留缺失材料与冲突，不要重复调用已经充分覆盖的工具。",
    ...sections,
    "### 协作冲突",
    conflicts,
  ].join("\n\n");
}
