import { expect, test } from "@playwright/test";

test("真实语义 Judge 可重试并按 evaluator fingerprint 命中缓存", async ({ page }) => {
  test.setTimeout(180_000);
  const runId = process.env.CRM_EVAL_RUN_ID;
  test.skip(!runId, "set CRM_EVAL_RUN_ID to a completed local Workbench run");

  await page.goto("/login?next=%2Fapp%2Fai%2Fworkbench");
  await page.locator("#email").fill(process.env.CRM_DEMO_EMAIL ?? "demo@example.invalid");
  await page.locator("#password").fill(process.env.CRM_DEMO_PASSWORD ?? "PiNativeDemo!2026");
  await page.getByRole("button", { name: /登录|Entrar/ }).click();
  await page.waitForURL(/\/app\/ai\/workbench/, { timeout: 45_000 });

  const firstResponse = await page.request.post(`/api/v1/ai/workbench/runs/${runId}/evaluation`);
  expect(firstResponse.ok()).toBeTruthy();
  const first = (await firstResponse.json()).data as {
    verdict: string;
    score: number;
    cached: boolean;
    summary: { structuredClaims: number; specialistRuns: number };
    semanticJudge: { status: string; verdict?: string; score?: number; rubricRevision?: number };
  };
  expect(first.semanticJudge.status).toBe("completed");
  expect(first.semanticJudge.rubricRevision).toBe(1);
  expect(first.summary.specialistRuns).toBe(3);
  expect(first.summary.structuredClaims).toBeGreaterThan(0);

  const cachedResponse = await page.request.post(`/api/v1/ai/workbench/runs/${runId}/evaluation`);
  expect(cachedResponse.ok()).toBeTruthy();
  const cached = (await cachedResponse.json()).data as typeof first;
  expect(cached.cached).toBe(true);
  expect(cached.semanticJudge).toEqual(first.semanticJudge);
  expect(cached.score).toBe(first.score);

  console.info(
    `REAL_SEMANTIC_JUDGE_RESULT=${JSON.stringify({
      runId,
      verdict: first.verdict,
      score: first.score,
      semanticJudge: first.semanticJudge,
      structuredClaims: first.summary.structuredClaims,
      cachedOnRepeat: cached.cached,
    })}`,
  );
});
