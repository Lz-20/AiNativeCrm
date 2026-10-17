# Migration log

## 2026-09-24

- Converged the event-log response, sentiment, and vision workers onto the
  canonical `runModelCall` seam. This removes the duplicate binding resolver
  and duplicate fire-and-forget `llm_calls` writes; Pi remains the only
  execution runtime and the model gateway now owns binding, BYOK, budget,
  pricing, usage, and failure audit for these workers too.
- Deleted the now-unreferenced `lib/ai/gateway-binding.ts` resolver and its
  obsolete call-site tests. Image content is adapted through the AI SDK
  `mediaType` shape before entering the Pi compatibility adapter.
- Made capability metadata explicit on every core CRM tool definition; Pi
  shadow/evaluation policy now receives declared `read`, `write`, `send`, or
  `handoff` semantics instead of depending on tool-name inference.
- Completed the provider-neutral hook/event forwarding seam: model calls can
  pass `transformContext`, `beforeToolCall`, `afterToolCall`, and event
  observers through the compatibility boundary, while normalized runtime
  events remain available to gateway callers.
- Revalidated the full unit suite: 1,238 files passed; 12,394 tests passed and
  1 repository-declared expected failure remained (12,395 total).
- Revalidated `pnpm lint`: 0 errors and 417 existing warnings; `pnpm typecheck`,
  `pnpm lint:channels`, and `pnpm test:shell` passed; `pnpm build` generated
  all application routes successfully.
- Re-ran `pnpm test:db`; it remains environment-blocked because Docker is not
  installed (`docker: command not found`). Re-ran `pnpm test:e2e`; its safety
  guard refused before startup because `.env.e2e` is absent and local Supabase
  is unavailable.

## 2026-09-25

- Extracted the resident human-case and transparency system blocks into
  `lib/agent-engine/agent/resident-system-blocks.ts`. Agenda remains sourced in
  `inbound-turn.ts` because the static agenda gate intentionally verifies the
  tool set at the turn assembly site.
- Fixed Pi turn usage accounting so token usage accumulates across every
  assistant model turn in one run; the regression test covers continuation.

- Updated source scanners to ignore only deleted files still present in a dirty
  worktree, removed the stale Vercel Gateway host declaration, and kept the
  media binding test on the real `runModelCall` seam with a fake local pool.
- Revalidated the full unit suite: 1,235 files passed; 12,371 tests passed and
  1 repository-declared expected failure remained (12,372 total).
- Converged persisted `ai_agent_runs` and the onboarding funnel suggestion onto
  `runModelCall`; the CRM version stop policy remains injected, while provider,
  credential, budget, pricing, cumulative multi-turn usage, and audit stay in
  the gateway.
- Added an architecture fence preventing production callers outside the Pi
  adapter and gateway from invoking `runPiAiSdkCall` directly.
- Removed the unused `lib/ai/runtime/cost.ts` helper so model pricing has one
  production owner in `lib/agent-engine/edge/llm/pricing.ts`.
- Fixed `PiAgentRuntime` usage accounting so multi-turn tool runs report the
  cumulative input/output/cache totals instead of only the final model response;
  added a regression test for the accumulation contract.
- Revalidated the full unit suite after this convergence: 1,235 files passed;
  12,374 tests passed and 1 repository-declared expected failure remained
  (12,375 total). Typecheck and focused runtime/parity tests also passed.

## 2026-09-23

- Made `AgentRuntime` an explicit dependency of the persisted `ai_agent_runs`
  composition. The internal agent route and the real-model proof script now
  construct the runtime at their composition roots and pass it into
  `runAgent`; CRM orchestration no longer constructs a runtime implicitly.
- Replaced the no-op `db:migrate` package script with the guarded baseline
  migration runner documented in `docs/SETUP.md`.
- Extracted the inbound turn's generic model-call seam into
  `lib/agent-engine/agent/pi-turn-execution.ts`. CRM policy remains in the
  turn (context, tools, guardrails, checkpoint, handoff, and persistence),
  while the injected `AgentRuntime` and model gateway own execution plumbing.
- Re-ran the complete unit suite after the extraction: 1,238 files passed,
  12,389 tests passed, and 1 repository-declared expected failure remained.
- Re-ran the production build successfully; all 55 pages/routes compiled and
  generated with only the existing optional-key, database-fallback, and Sentry
  deprecation warnings.
- Extracted the static CRM tool registry into `tool-definitions.ts` and the
  shared ritual/opening context assembly into `context-builder.ts`; the inbound
  orchestrator now imports and re-exports those stable seams for compatibility.
- Extracted the durable checkpoint schema, row contract, closing instruction,
  and parser into `checkpoint-contract.ts`; checkpoint persistence remains in
  the CRM turn harness while the contract is independently testable.

## 2026-09-22

- Removed the legacy/Vercel execution branch from `runModelCall`: every CRM
  model call now resolves through the Pi runtime, including auxiliary
  classifiers, compaction, and guardrails. Shadow/evaluation remains the only
  alternate policy mode.
- Added deterministic Pi-core coverage for pre-abort cancellation and retained
  coverage for tool continuation, CRM hooks, post-turn stop policy, and
  side-effect-free evaluation mode.
- Added an ESM loading seam for the long-running `tsx` worker: Pi packages use
  native dynamic import under CommonJS `tsx`, while Next/Vitest keep literal
  imports for bundling and test transforms.
- Removed the deprecated `lib/ai/runtime/agent.ts` path. Its persisted-run
  composition now lives under `lib/agent-engine/agent/ai-agent-run.ts`, while
  the reusable MCP/history/finalization helpers remain harness modules.
- Replaced the `INTERNAL_AGENT_RUN_STUB` Vercel fake registry with a
  deterministic Pi-backed preview runtime; the fixture now exercises the real
  runtime boundary and keeps CRM tools/policies/persistence real.
- Added deterministic parity fixtures under `tests/agent-runtime/fixtures/` and
  preserved structured tool-result errors/termination hints across the
  Vercel-message compatibility seam. The fixture matrix now names 13 frozen
  CRM business outcomes; the database-backed harness comparison remains open
  only for scenarios that require live database/provider fixtures.
- Renamed the product-facing guide ecosystem, extension publisher metadata,
  self-host entry docs, and active image fallback paths to `pi-native-*`;
  persisted cookies, webhook headers, calendar identifiers, and historical
  deployment fixtures remain explicitly documented compatibility references.
- Removed `AGENT_RUNTIME=legacy` from the app and worker production env schemas,
  and removed `legacy` from the runtime type contract. Remaining Vercel model
  factories are compatibility-only provider tests and installation/gateway
  probes; they are not agent execution paths. The database/invariant fixtures
  now inject a Pi-backed faux provider through a test-only message-shape
  adapter, so their callbacks no longer populate the production turn deps with
  a provider registry.
- Removed the last `legacy-model-adapter.ts` Vercel model factory. Provider
  routing, OpenRouter endpoint, and DeepSeek request-body probes now execute
  through Pi's provider adapter; the remaining Vercel factory is limited to
  non-agent gateway/installation compatibility.
- Completed the repository-wide product namespace migration to Pi Native CRM,
  including package, guides, deployment/governance identifiers, wire/storage
  identifiers, extension publisher metadata, and persisted integration
  prefixes. The legacy text/filename scan is now empty, with the new namespace
  protected by a regression test. Refreshed the extension catalog origin and
  package digests, and resealed translated white-label documentation.

## 2026-09-21

- Created branch `refactor/pi-native-runtime`.
- Added `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`.
- Added CRM-owned `AgentRuntime` types with no Pi or Vercel dependency.
- Added `PiAgentRuntime` with lifecycle events, context transform, tool hooks,
  abort propagation, stop conditions, and parallel/sequential execution.
- Added provider adapter coverage for Anthropic, OpenAI, Google, OpenRouter,
  and DeepSeek, including custom base URLs.
- Added a Vercel AI compatibility bridge for incremental harness migration.
- Made Pi the sole production runtime mode, with side-effect-free `shadow`
  evaluation policy.
- Added platform fallback fields for Google and DeepSeek while preserving BYOK.
- Added unit coverage for basic turns, tool continuation, before-tool blocks,
  compatibility conversion, and shadow-mode mutation blocking.
- Added explicit `AgentRuntime` injection at the worker composition root and a
  static architecture test that prevents Pi SDK imports from leaking into CRM
  domain/tools or the model gateway.
- Replaced the remaining deprecated internal-agent Vercel loop with the Pi
  runtime, preserving CRM-owned handoff and token/cost stop policy through the
  post-turn callback.
- Migrated the event-log response worker, sentiment classifier, media vision,
  and onboarding suggestion calls to Pi runtime bindings, preserving provider
  binding, tenant headers, usage, and existing persistence behavior.
- Moved installation-key lookup into `lib/agent-runtime/model-gateway.ts` and
  isolated the remaining Vercel provider factory as a compatibility-only test
  adapter; the deprecated runtime module no longer contains provider factories.

Remaining work is tracked in `04-final-audit.md`; this branch is not ready to
claim full legacy-loop deletion until the full harness parity matrix passes.
