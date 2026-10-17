import { expect, it } from "vitest";
import { canExposeInternalQuestionTools } from "./internal-question-contract";

it("exposes internal questioning only to an acting supervisor on a scoped Mission", () => {
  const allowed = { mode: "act", missionId: "mission-1",
    leadId: "lead-1", builtinKey: "crm_supervisor" };
  expect(canExposeInternalQuestionTools(allowed)).toBe(true);
  expect(canExposeInternalQuestionTools({ ...allowed, mode: "inspect" })).toBe(false);
  expect(canExposeInternalQuestionTools({ ...allowed, missionId: null })).toBe(false);
  expect(canExposeInternalQuestionTools({ ...allowed, leadId: null })).toBe(false);
  expect(canExposeInternalQuestionTools({ ...allowed, builtinKey: "crm_intelligence" })).toBe(false);
  expect(canExposeInternalQuestionTools({ ...allowed, builtinKey: null })).toBe(false);
});
