import { describe, expect, it } from "vitest";

import { evaluateAgentRun } from "@/lib/ai/evals/evaluate-run";
import { resolveAgentEvalProfile } from "@/lib/ai/evals/profiles";
import { WORKBENCH_EVAL_GOLDEN_CASES } from "@/tests/agent-runtime/fixtures/workbench-eval-golden";

describe("versioned Workbench Eval golden corpus", () => {
  for (const fixture of WORKBENCH_EVAL_GOLDEN_CASES) {
    it(`${fixture.id} preserves the reviewed verdict and findings`, () => {
      const report = evaluateAgentRun(fixture.input, resolveAgentEvalProfile(fixture.profileKey));
      const codes = report.dimensions.flatMap((dimension) =>
        dimension.findings.map((finding) => finding.code),
      );

      expect(report.profileRevision).toBe(8);
      expect(report.verdict).toBe(fixture.expected.verdict);
      expect(codes).toEqual(expect.arrayContaining(fixture.expected.findingCodes));
    });
  }

  it("contains enough reviewed cases and at least two real-provider regressions", () => {
    expect(WORKBENCH_EVAL_GOLDEN_CASES.length).toBeGreaterThanOrEqual(5);
    expect(
      WORKBENCH_EVAL_GOLDEN_CASES.filter((item) => item.provenance.kind === "real_run").length,
    ).toBeGreaterThanOrEqual(2);
  });
});
