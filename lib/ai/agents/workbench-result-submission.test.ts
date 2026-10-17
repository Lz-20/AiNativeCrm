import { describe, expect, it } from "vitest";
import {
  createWorkbenchResultChannel,
  resultDocument,
  SUBMIT_WORKBENCH_RESULT_TOOL,
  workbenchResultSchema,
  workbenchResultPartialReason,
  workbenchFinalText,
  WORKBENCH_RESULT_INSTRUCTION,
} from "@/lib/ai/agents/workbench-result-submission";

const candidate = {
  summary: "已核对商机；交期仍需确认。",
  evidence: [
    {
      sourceType: "lead" as const,
      sourceId: "67b72c24-741b-4c26-8a15-22580211bd7e",
      claim: "商机目前处于报价阶段",
      assertions: [{ field: "value_cents" as const, equals: 128000000 }],
    },
  ],
  missingInformation: ["交期依据"],
  nextStep: "请交付同事确认可承诺日期。",
  wakeCondition: "internal_response" as const,
};

describe("Workbench structured result channel", () => {
  it("documents task-local gaps and exact null/source evidence without weakening partial outcomes", () => {
    expect(WORKBENCH_RESULT_INSTRUCTION).toContain("只包含阻止完成当前用户任务");
    expect(WORKBENCH_RESULT_INSTRUCTION).toContain("JSON null 保持 null");
    expect(WORKBENCH_RESULT_INSTRUCTION).toContain("不用全零 UUID");
    expect(WORKBENCH_RESULT_INSTRUCTION).toContain("不能证明数据丢失");
    expect(
      workbenchResultSchema.safeParse({
        ...candidate,
        evidence: [
          {
            ...candidate.evidence[0],
            assertions: [{ field: "expected_close_date", equals: null }],
          },
        ],
      }).success,
    ).toBe(true);
  });
  it("accepts one bounded, schema-valid statement without executing CRM actions", async () => {
    const channel = createWorkbenchResultChannel();
    const submit = channel.tools[SUBMIT_WORKBENCH_RESULT_TOOL];
    expect(submit).toBeDefined();
    expect(await submit!.execute!(candidate, {} as never)).toEqual({ accepted: true });
    expect(channel.submitted()).toEqual(candidate);
    expect(resultDocument(channel.submitted()!)).toMatchObject({
      revision: 1,
      trust: "model_submitted",
      summary: candidate.summary,
    });
    expect(await submit!.execute!({ ...candidate, summary: "changed" }, {} as never)).toEqual({
      accepted: false,
      reason: "already_submitted",
    });
  });

  it("rejects unbounded, unreferenced, or unexpected fields", async () => {
    const channel = createWorkbenchResultChannel();
    const submit = channel.tools[SUBMIT_WORKBENCH_RESULT_TOOL]!;
    expect(workbenchResultSchema.safeParse({ ...candidate, secret: "never" }).success).toBe(false);
    expect(
      workbenchResultSchema.safeParse({
        ...candidate,
        evidence: [
          { ...candidate.evidence[0], assertions: [{ field: "phone", equals: "private" }] },
        ],
      }).success,
    ).toBe(false);
    expect(
      await submit.execute!(
        { ...candidate, evidence: [{ ...candidate.evidence[0], sourceId: "guess" }] },
        {} as never,
      ),
    ).toEqual({ accepted: false, reason: "invalid_schema" });
    expect(channel.submitted()).toBeNull();
  });

  it("distinguishes a complete run from a missing structured result, evidence gap and budget stop", () => {
    expect(
      workbenchResultPartialReason({
        finalText: candidate.summary,
        submission: candidate,
        budgetExhausted: false,
      }),
    ).toBe("missing_material");
    expect(
      workbenchResultPartialReason({
        finalText: candidate.summary,
        submission: null,
        budgetExhausted: false,
      }),
    ).toBe("structured_result_missing");
    expect(
      workbenchResultPartialReason({
        finalText: candidate.summary,
        submission: { ...candidate, missingInformation: [] },
        budgetExhausted: true,
      }),
    ).toBe("budget_exhausted");
    expect(
      workbenchResultPartialReason({
        finalText: candidate.summary,
        submission: { ...candidate, missingInformation: [] },
        budgetExhausted: false,
      }),
    ).toBeNull();
  });

  it("replaces a prior provisional summary after a resumed model submission", () => {
    expect(
      workbenchFinalText({
        submission: candidate,
        priorText: "尚未更新商机，准备提出修改",
        fallbackText: "stale provider text",
        candidateBodies: [],
      }),
    ).toBe(candidate.summary);
  });
});
