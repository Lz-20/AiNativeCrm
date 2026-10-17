import { describe, expect, it } from "vitest";

import {
  extractProductFinalAnswer,
  inspectProductFinalAnswer,
  UNSAFE_FINAL_ANSWER_PLACEHOLDER,
} from "@/lib/ai/agents/final-answer";

describe("workbench final answer boundary", () => {
  it("keeps raw drafting in private state but exposes only the delimited product answer", () => {
    const extracted = extractProductFinalAnswer(
      "Let me analyze the records. Write it in Chinese.\n\n# 商机审查报告\n\n结论完整。",
    );
    expect(extracted).toMatchObject({
      sanitized: true,
      text: "# 商机审查报告\n\n结论完整。",
      inspection: { internalDraftCodes: [], likelyTruncated: false },
    });
  });

  it("removes provider working notes even when they avoid explicit final-answer wording", () => {
    const extracted = extractProductFinalAnswer(
      "Now I have real data. Key findings:\nFacts.\n\nPriorities:\nP0.\n\nI should keep this honest.\n\n## 商机审查报告\n\n正式结论。",
    );
    expect(extracted).toMatchObject({
      sanitized: true,
      text: "## 商机审查报告\n\n正式结论。",
      inspection: { internalDraftCodes: [], likelyTruncated: false },
    });
  });

  it("uses the draft-preamble and Markdown boundary when provider wording changes", () => {
    const extracted = extractProductFinalAnswer(
      "Now synthesize. Key evidence follows.\n\nStructure the answer in Chinese.\n\nLet me write.\n\n## 商机审查报告\n\n正式结论。",
    );
    expect(extracted).toMatchObject({
      sanitized: true,
      text: "## 商机审查报告\n\n正式结论。",
      inspection: { internalDraftCodes: [], likelyTruncated: false },
    });
  });

  it("flags an answer that ends in an unfinished connector", () => {
    expect(inspectProductFinalAnswer("结论如下：负责人为")).toMatchObject({
      likelyTruncated: true,
      truncationReasons: expect.arrayContaining(["unfinished_connector"]),
    });
  });

  it("flags an answer cut immediately after a numbered-list marker", () => {
    expect(inspectProductFinalAnswer("## 建议\n\n1. 已完成\n2")).toMatchObject({
      likelyTruncated: true,
      truncationReasons: expect.arrayContaining(["unfinished_list_item"]),
    });
  });

  it("does not pretend to sanitize when no reliable answer boundary exists", () => {
    const extracted = extractProductFinalAnswer("Now produce the final answer in Chinese");
    expect(extracted.sanitized).toBe(false);
    expect(extracted.text).toBe(UNSAFE_FINAL_ANSWER_PLACEHOLDER);
    expect(extracted.inspection.internalDraftCodes).toContain("internal_final_answer_instruction");
  });
});
