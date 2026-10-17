import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { matchingSavedSemanticReview } from "./saved-semantic-review";
const material = { runId: "run", profileKey: "crm", profileRevision: 8, baseFingerprint: "material", rubricRevision: 2 };
const report = { runId: "run", profileKey: "crm", profileRevision: 8,
  semanticJudge: { status: "completed", rubricRevision: 2, judgeId: "workbench_semantic_v2:opencode:model" } };
const row = { report, input_fingerprint: createHash("sha256").update("material:semantic:v2:opencode:model").digest("hex") };
describe("read-only saved semantic review selection", () => {
  it("restores only the exact material/profile/rubric/model fingerprint", () => {
    expect(matchingSavedSemanticReview([row], material)).toEqual(report);
  });
  it.each([{ baseFingerprint: "changed" }, { runId: "other" }, { profileRevision: 7 }, { rubricRevision: 1 }])(
    "rejects stale and cross-run reports", change => {
      expect(matchingSavedSemanticReview([row], { ...material, ...change })).toBeNull();
    });
  it("does not promote a failed or malformed review", () => {
    expect(matchingSavedSemanticReview([{ ...row, report: null }], material)).toBeNull();
    expect(matchingSavedSemanticReview([{ ...row, report: { ...report, semanticJudge: { ...report.semanticJudge, status: "failed" } } }], material)).toBeNull();
  });
});
