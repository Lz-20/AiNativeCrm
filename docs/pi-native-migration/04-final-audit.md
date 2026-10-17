# Final audit checklist

This is the living audit for the Pi-native migration. Items are checked only
with repository evidence.

- [x] CRM-owned `AgentRuntime` boundary has no Pi dependency.
- [x] Pi Agent Core owns loop/tool lifecycle/context transform/event emission.
- [x] Provider adapter covers Anthropic/OpenAI/Google/OpenRouter/DeepSeek.
- [x] Existing budget, binding, usage, and audit seam remains around calls.
- [x] Shadow/evaluation mode is explicit and documented; the legacy runtime
      selector has been removed from the production seam and type contract.
- [x] Unit tests cover basic/tool/hook/shadow runtime behavior.
- [x] Production agent, response worker, sentiment classifier, media vision,
      onboarding suggestions, auxiliary classifiers, and compaction execute
      through Pi; the compatibility bridge remains only at the Vercel-message
      shape seam.
- [x] The inbound turn delegates model execution through
      `lib/agent-engine/agent/pi-turn-execution.ts`; CRM policy and durable
      outcomes remain in the harness, with no direct model-call invocation in
      the large turn module.
- [x] Static CRM tool definitions and shared opening-context assembly are
      extracted to `tool-definitions.ts` and `context-builder.ts`; the turn
      orchestrator retains only compatibility re-exports and runtime policy.
- [x] Core CRM tools declare explicit runtime capabilities; evaluation/shadow
      blocking no longer depends on tool-name inference for the static registry.
- [x] Provider-neutral context/tool lifecycle hooks and normalized runtime events
      are forwarded through the model gateway seam.
- [x] The deprecated internal-agent loop and file path were removed; persisted
      agent-run composition now lives in
      `lib/agent-engine/agent/ai-agent-run.ts` and delegates execution to Pi.
- [x] The unused legacy runtime pricing helper was removed; production pricing
      now has one owner in `lib/agent-engine/edge/llm/pricing.ts` through the
      Model Gateway.
- [x] Removed the compatibility-only Vercel model adapter after moving the
      provider-routing probes to the Pi provider adapter. `legacy` is no
      longer a runtime selector or a production/test input type; remaining
      Vercel factories cover non-agent gateway/installation compatibility.
- [x] Deterministic Pi parity fixtures cover simple QA, sales, RAG, lead context,
      follow-up, handoff, CRM update, skill, multi-tool, long context, tool
      error, provider error, and budget-exceeded business outcomes.
- [ ] Full CRM harness parity matrix passes in a database-backed environment:
      RAG, skills, router, handoff, follow-up, checkpoint, BYOK, budget
      rejection, and provider governance. The invariant harness now injects a
      Pi-backed faux provider; see the latest verification snapshot below.
- [x] `pnpm lint`, `pnpm lint:channels`, `pnpm test:shell`, and `pnpm build`
      pass in this environment.
- [x] `pnpm test:unit` passes in this environment: the full suite is green
      with the repository's one explicit expected failure. The test setup now
      provides an ordinary jsdom origin and in-memory storage fallback, uses
      realm-safe multipart fixtures, and keeps the DNS-dependent public-host
      adapter case deterministic.
- [ ] Full `pnpm test:db` matrix is not green yet; the latest run and its
      environment-specific limits are recorded below.
- [x] Repository branding and operational references have been audited and
      migrated; the removed namespace has zero text and filename matches, and
      the current protocol/infra identifiers are catalogued in
      `05-branding-audit.md`.
- [x] Final local commit created after verification; no push, merge, or pull
      request performed.

## Verification snapshot — 2026-09-26 (Pi Native CRM workbench)

- The Workbench now has explicit authenticated read-only grants for run
  metadata; direct authenticated writes are revoked. Run/event reads are
  manager-scoped by tenant RLS. Proposal arguments and saved Pi continuation
  state remain service-only.
- Added real two-organization RLS behavior coverage for manager-readable runs
  and events, plus privilege assertions for the service-only proposal/state
  tables. The automated RLS completeness inventory now accounts for all four
  durable Workbench tables.
- `pnpm test:db tests/invariants/rls-isolation.test.ts
tests/invariants/rls-completude-varredura.test.ts`: PASS — 2 files, 153 tests.
- `pnpm test:db tests/invariants/travas-de-suporte-cobrem-toda-tabela-na-instalacao.test.ts`:
  PASS — 1 file, 9 tests. Run metadata is read-only to authenticated, so it
  correctly stays outside the support write-policy set.
- Full `pnpm test:db` was attempted using the cached Supabase Postgres 15 image
  because `pgvector/pgvector:pg15` is not cached and Docker Hub DNS timed out.
  Baseline install and re-application both passed. The invariant run ended
  red (6 files, 34 tests failed): the cached Supabase image rejects custom test
  GUCs required by the agenda invariants; unrelated pre-existing calendar
  meeting concurrency assertions also failed. The official pgvector image
  remains unverified; the isolated test database was removed by the harness.
- A live-model browser E2E run remains unverified: `.env.e2e` and provider
  credentials are absent. No substitute/mock was reported as a real-model E2E.
- Live Pi runtime smoke (2026-09-26): PASS against OpenCode Zen
  `space-bunny-free`. The real model invoked the single synthetic read-only CRM
  lookup tool and returned the expected stage; Pi reported token usage. The key
  was passed only as a one-process environment variable and was not persisted.
  This validates provider/Pi/tool-loop compatibility, not the durable Workbench
  queue, authenticated API, or CRM database E2E.
- The user's existing local Supabase database was not migrated or modified.
- No push, merge, or pull request was performed.

## Verification snapshot — 2026-09-25 (gateway convergence)

- Persisted `ai_agent_runs` now execute through `runModelCall` with
  `purpose='agent_turn'`; provider, model, credential, BYOK/platform fallback,
  monthly budget, pricing, usage, and `llm_calls` audit are no longer resolved
  in `ai-agent-run.ts`.
- The gateway forwards the CRM-owned per-version stop policy while calculating
  cumulative multi-turn usage and cost in the canonical pricing path.
- The onboarding funnel suggestion now uses the same gateway and
  `prospecting_agent_setup_chat` purpose; no production caller outside the Pi
  adapter or model gateway calls `runPiAiSdkCall` directly.
- The unused `lib/ai/runtime/cost.ts` compatibility helper was deleted; a
  static architecture fence now rejects legacy pricing references.
- `PiAgentRuntime` now accumulates input/output/cache usage across every model
  turn in one tool run; the runtime test covers the multi-turn accounting path.
- Architecture fence and Pi parity tests: PASS — 2 files and 27 tests.
- `pnpm test:unit`: PASS — 1,235 files; 12,374 tests passed and 1 explicit
  expected failure (12,375 total).
- `pnpm typecheck`: PASS. `git diff --check`: PASS.
- Docker/Postgres and `.env.e2e` remain unavailable on this host; the
  database-backed parity and browser gates are still explicitly unverified.

## Verification snapshot — 2026-09-22

- `pnpm typecheck`: PASS.
- `pnpm lint`: PASS with the repository's existing warning backlog (0 errors,
  416 warnings).
- `pnpm lint:channels`: PASS.
- Focused Pi/runtime/provider/worker/branding/catalog tests: PASS (115 tests).
  The Pi runtime/compatibility
  suite covers pre-abort cancellation, parallel and sequential tool batches,
  context/tool-result hooks, conversion, shadow blocking, structured tool
  results, and post-turn stop policy. The static architecture and Pi-backed
  preview fixtures pass; the deterministic parity matrix contains 13 named
  business fixtures covering QA, sales, RAG, lead context, skills, CRM
  updates, handoff, follow-up, long context, multi-tool turns, tool/provider
  errors, and budget rejection. The Pi model adapter suite covers Anthropic,
  OpenAI, Google, OpenRouter, DeepSeek, custom endpoints, and unsupported
  provider rejection; seam/provider tests pass with Pi runtime injection,
  including auxiliary-runtime forwarding and the Pi-backed invariant fixture
  adapter.
- `drain-loop-carrega-deps-sob-tsx.test.ts`: PASS after adding the native ESM
  loading seam required by Pi's ESM-only package exports.
- `pnpm build`: PASS. Next compilation, TypeScript validation, page-data
  collection, and static generation completed successfully for all 55 pages.
- `pnpm test:unit` full snapshot: 1,238 test files passed; 12,388 tests
  passed and 1 explicit expected failure (12,389 total). The run completed
  after stabilizing jsdom storage/multipart realms and making the public DNS
  adapter fixture deterministic. The focused parity matrix contains 13 named
  business fixtures and passes alongside the Pi runtime suite.
- After extracting `pi-turn-execution.ts`, the full unit snapshot was
  revalidated: 1,238 files passed; 12,389 tests passed and 1 explicit expected
  failure remained (12,390 total). The production build also passed again,
  compiling and generating all 55 pages/routes.
- The turn boundary was split further: static tool definitions,
  checkpoint contract/parser, and shared context assembly are now separate
  modules; `inbound-turn.ts` retains CRM policy, guarded handlers, persistence,
  and queue outcomes.
- `pnpm test:shell`: PASS. The macOS Bash 3.2-compatible fixture and
  uninstaller path now pass, including all 128 `hooks-nao-acusam-a-main`
  cases and the isolated `owner-id-por-email` fixture.
- `pnpm test:db`: NOT RUNNABLE here because Docker is not installed (`docker:
command not found`); the harness reaches its container startup and tears down
  safely without running against another database.
- `pnpm test:e2e`: intentionally refused before starting because `.env.e2e` is
  absent. The Playwright guard requires a local Supabase environment and will
  not fall back to `.env.local` or any remote database; generating `.env.e2e`
  requires the unavailable local Supabase/Docker prerequisite.

## Resumed verification snapshot — 2026-09-23

- Repository state remained clean on branch `refactor/pi-native-runtime`.
- `pnpm vitest run tests/unit/pi-runtime-architecture.test.ts
tests/agent-runtime/fixtures/pi-parity.test.ts
lib/agent-runtime/pi/runtime.test.ts
lib/agent-runtime/pi/ai-sdk-compat.test.ts
lib/agent-runtime/pi/model-adapter.test.ts`: PASS, 5 files and 40 tests.
- Branding and filename scans for the removed product namespace: PASS, zero
  text matches and zero filename matches.
- `pnpm test:db`: BLOCKED by the environment at container startup;
  `docker: command not found`. The script still performed safe teardown and
  did not substitute another database.
- `pnpm test:e2e`: REFUSED before test/server startup because `.env.e2e` is
  absent. The guard correctly avoids using `.env.local`, which points to
  production; local Supabase/Docker is required to generate the E2E env.
- `pnpm db:migrate`: the former no-op TODO was replaced with the guarded
  `scripts/db-migrate.sh` baseline runner. Its local guard was exercised here;
  it refused before SQL because this host has no configured
  `SUPABASE_DB_URL`. A live application still requires a configured database
  and `psql`.
- After the migration-command change, `pnpm typecheck`, the focused Pi
  architecture/parity tests (20/20), `pnpm lint:channels`, `pnpm test:shell`,
  and `git diff --check` passed.
- After making runtime injection explicit at the persisted-run composition roots,
  `pnpm test:unit` passed again: 1,238 files; 12,388 tests passed and 1
  explicit expected failure (12,389 total).
- `pnpm build` passed again after the route/composition change: Next compiled,
  TypeScript completed, and all 55 pages/routes were generated. The build
  emitted only existing environment/dependency warnings (missing optional
  local AI keys, database fallback during static generation, and the Sentry
  import deprecation).

## Verification snapshot — 2026-09-24

- `pnpm typecheck`: PASS.
- `pnpm lint`: PASS with 0 errors and 417 warnings.
- `pnpm lint:channels`: PASS.
- `pnpm test:shell`: PASS.
- `pnpm test:unit`: PASS — 1,238 files; 12,394 tests passed and 1 explicit
  expected failure (12,395 total).
- `pnpm build`: PASS; all application routes compiled and generated.
- `pnpm test:db`: BLOCKED before database startup because Docker is not
  installed (`docker: command not found`), with safe teardown.
- `pnpm test:e2e`: REFUSED before startup because `.env.e2e` is absent; the
  guard correctly refuses to use `.env.local` or a remote database.

## Verification snapshot — 2026-09-24 (continued)

- Extracted the closure-bound CRM tool factory from `inbound-turn.ts` into
  `lib/agent-engine/agent/turn-tools.ts`. The turn orchestrator is now 2,929
  lines; the extracted factory preserves the existing tool handlers, MCP
  assembly, capability filtering, and cleanup contract.
- Revalidated the full unit suite after the extraction: 1,238 files passed;
  12,394 tests passed and 1 repository-declared expected failure remained.
  The focused tool-wiring migration tests passed (95/95).
- Made the runtime mode contract explicit: `pi` is canonical production and
  `shadow` is the only evaluation mode. The example environment and the
  architecture guard no longer describe a legacy rollback selector.
- Revalidated typecheck, focused Pi/runtime architecture tests (54/54 before
  the documentation guard, then 30/30 after it), lint, channels, shell tests,
  build, diff checks, the zero-match brand scan, and the zero-match executable
  legacy-loop scan.
- Local commits added during this continuation: `0ccced8` (tool factory),
  `0dbc422` (explicit shadow mode), and `a7dfafe` (configuration guard test).
- The DB-backed parity matrix is still not proven on this host: Docker,
  Supabase CLI, `psql`, and a local PostgreSQL server are unavailable. E2E is
  still intentionally refused because `.env.e2e` is absent.

## Verification snapshot — 2026-09-25

- Extracted the resident human-case and transparency system blocks into
  `lib/agent-engine/agent/resident-system-blocks.ts`; agenda source remains in
  `inbound-turn.ts` because the static agenda gate requires that source to be
  visible at the turn assembly site.
- `pnpm test:unit`: PASS — 1,235 files; 12,374 tests passed and 1 explicit
  expected failure (12,375 total).
- `pnpm typecheck`: PASS after the resident-block extraction.
- Focused agenda/runtime architecture tests: PASS — 4 files and 63 tests.

- Fallback model resolution now enters the canonical `runModelCall` seam; the
  obsolete `gateway-binding` resolver was removed. Response, sentiment, and
  vision workers now share binding, BYOK/platform fallback, budget, pricing,
  usage, and `llm_calls` audit before Pi execution.
- The Pi compatibility adapter accepts the AI SDK `mediaType` image-part shape,
  preserving multimodal vision through the governed seam.
- The full unit suite was rerun after the convergence fixes and scanner updates:
  1,235 files passed; 12,371 tests passed and 1 explicit expected failure
  remained (12,372 total).
- `pnpm typecheck`: PASS.
- `pnpm lint`: PASS with 0 errors and 459 existing warnings.
- `pnpm test:unit`: PASS — 1,235 files; 12,371 tests passed and 1 explicit
  expected failure (12,372 total).
- `pnpm build`: PASS; all application routes compiled and generated.
- Focused fallback/Pi/OpenRouter/architecture/media tests: PASS — 6 files and
  104 tests.
- Branding scan: PASS, zero matches for the removed namespace.
- `pnpm test:db`: BLOCKED before database startup because Docker is not
  installed. `pnpm test:e2e` remains refused because `.env.e2e` is absent.
- Local commit for this convergence: `3bc6127` (`refactor(runtime): converge
worker model calls`). No push, merge, or pull request was performed.
