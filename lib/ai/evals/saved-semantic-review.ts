import { createHash } from "node:crypto";
import type { AgentEvalReport } from "./contracts";

export function matchingSavedSemanticReview(
  rows: Array<{ report: unknown; input_fingerprint: string }>,
  material: { runId: string; profileKey: string; profileRevision: number; baseFingerprint: string; rubricRevision: number },
): AgentEvalReport | null {
  for (const row of rows) {
    const report = row.report as AgentEvalReport | null;
    const judge = report?.semanticJudge;
    if (report?.runId !== material.runId || report?.profileKey !== material.profileKey ||
      report?.profileRevision !== material.profileRevision || judge?.status !== "completed" ||
      judge.rubricRevision !== material.rubricRevision || typeof judge.judgeId !== "string") continue;
    const prefix = `workbench_semantic_v${material.rubricRevision}:`;
    if (!judge.judgeId.startsWith(prefix)) continue;
    const evaluator = `semantic:v${material.rubricRevision}:${judge.judgeId.slice(prefix.length)}`;
    const fingerprint = createHash("sha256").update(`${material.baseFingerprint}:${evaluator}`).digest("hex");
    if (row.input_fingerprint === fingerprint) return report;
  }
  return null;
}
