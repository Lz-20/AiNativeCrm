import { expect, it } from "vitest";
import { aggregateWorkbenchLlmUsage } from "./workbench-usage";

it("preserves unknown pricing for a successful provider call", () => {
  expect(aggregateWorkbenchLlmUsage([
    { input_tokens: 100, output_tokens: 20, cost_cents: "1.25", status: "ok" },
    { input_tokens: 50, output_tokens: 10, cost_cents: null, status: "ok" },
  ])).toEqual({
    inputTokens: 150, outputTokens: 30, costCents: null, calls: 2, unknownCostCalls: 1,
  });
});

it("does not mistake a failed zero-usage call for unknown spending", () => {
  expect(aggregateWorkbenchLlmUsage([
    { input_tokens: 0, output_tokens: 0, cost_cents: null, status: "erro" },
    { input_tokens: 12, output_tokens: 3, cost_cents: 0.5, status: "ok" },
  ])).toEqual({
    inputTokens: 12, outputTokens: 3, costCents: 0.5, calls: 2, unknownCostCalls: 0,
  });
});

it("fails closed on an invalid successful price", () => {
  expect(aggregateWorkbenchLlmUsage([
    { input_tokens: 10, output_tokens: 2, cost_cents: "not-a-price", status: "ok" },
  ])).toMatchObject({ costCents: null, unknownCostCalls: 1 });
});
