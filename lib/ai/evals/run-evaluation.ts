import type {
  AgentEvalProfile,
  AgentEvalReport,
  AgentEvalRunInput,
  AgentEvalVerdict,
  AgentSemanticJudgePort,
} from "@/lib/ai/evals/contracts";
import { evaluateAgentRun } from "@/lib/ai/evals/evaluate-run";

const VERDICT_SEVERITY: Readonly<Record<AgentEvalVerdict, number>> = {
  not_run: 0,
  pass: 1,
  needs_review: 2,
  fail: 3,
};

function stricterVerdict(left: AgentEvalVerdict, right: AgentEvalVerdict): AgentEvalVerdict {
  return VERDICT_SEVERITY[left] >= VERDICT_SEVERITY[right] ? left : right;
}
/**
 * Adds an optional semantic review without weakening deterministic policy,
 * tool, lifecycle, grounding, or answer-boundary gates.
 */
export async function runAgentEvaluation(input: {
  run: AgentEvalRunInput;
  profile: AgentEvalProfile;
  judge?: AgentSemanticJudgePort | null;
  signal?: AbortSignal;
}): Promise<AgentEvalReport> {
  const deterministic = evaluateAgentRun(input.run, input.profile);
  if (!input.judge) return deterministic;
  if (deterministic.verdict === "not_run")
    return { ...deterministic, semanticJudge: { status: "not_run" } };

  const signal = input.signal ?? AbortSignal.timeout(60_000);
  try {
    const judged = await input.judge.judge({
      profile: input.profile,
      run: input.run,
      deterministicReport: deterministic,
      signal,
    });
    const semanticScore = Math.max(0, Math.min(100, Math.round(judged.score)));
    return {
      ...deterministic,
      verdict: stricterVerdict(deterministic.verdict, judged.verdict),
      score:
        deterministic.score === null
          ? semanticScore
          : Math.min(deterministic.score, semanticScore),
      semanticJudge: {
        status: "completed",
        judgeId: judged.judgeId,
        verdict: judged.verdict,
        score: semanticScore,
        findings: judged.findings,
        rubricRevision: judged.rubricRevision,
      },
    };
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "semantic_judge_error";
    return {
      ...deterministic,
      verdict:
        deterministic.verdict === "pass" ? "needs_review" : deterministic.verdict,
      semanticJudge: {
        status: "failed",
        findings: [
          {
            code: "semantic_judge_failed",
            message: "语义 Judge 未能完成；确定性门禁结果仍然有效。",
            evidence: { errorType },
          },
        ],
      },
    };
  }
}
