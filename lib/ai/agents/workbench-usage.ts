export interface WorkbenchLlmCallUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | string | null;
  status: string;
}

export interface WorkbenchUsageSummary {
  inputTokens: number;
  outputTokens: number;
  costCents: number | null;
  calls: number;
  unknownCostCalls: number;
}

/** Never present an unpriced successful model call as a free call. */
export function aggregateWorkbenchLlmUsage(
  rows: readonly WorkbenchLlmCallUsage[],
): WorkbenchUsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let knownCostCents = 0;
  let unknownCostCalls = 0;
  for (const row of rows) {
    inputTokens += row.input_tokens ?? 0;
    outputTokens += row.output_tokens ?? 0;
    const cost = row.cost_cents == null ? null : Number(row.cost_cents);
    if (cost == null || !Number.isFinite(cost) || cost < 0) {
      if (row.status === "ok") unknownCostCalls += 1;
    } else {
      knownCostCents += cost;
    }
  }
  return {
    inputTokens,
    outputTokens,
    costCents: unknownCostCalls > 0 ? null : knownCostCents,
    calls: rows.length,
    unknownCostCalls,
  };
}
