# Agent–CRM Workbench

## Product boundary

The workbench treats the CRM as the tenant-scoped source of business truth and Pi Agent Core as
the agent-loop execution kernel. Agents read CRM objects only through the existing CRM tools and
policies; they do not receive database access. This surface is intended to make context assembly,
tool decisions, CRM observations, confirmation, and usage inspectable without turning the CRM into
a visual workflow builder.

## Built-in Agents

`lib/ai/agents/builtins.ts` is the stable registry for four organization-owned definitions:

- CRM Intelligence (`crm_intelligence`): CRM context, conversations, knowledge, and memory reads.
- Sales Operations (`sales_operations`): pipeline and follow-up operations.
- Customer Communications (`customer_communications`): conversation and knowledge context, reply
  drafts, and a persisted human-handoff proposal executed through the CRM handoff orchestrator.
- CRM Supervisor (`crm_supervisor`): cross-pipeline and follow-up inspection.

`ensureBuiltinAgents(orgId)` provisions records idempotently. Built-in source records are locked in
the API and user-facing RLS policies; customization starts by copying one into a regular Agent.
Built-ins bind to the organization's current default model. Runs fail before calling a provider if
the selected model is absent, deprecated, or not declared tool-capable.

## Pi and provider adapter mapping

The workbench binding is translated by `lib/agent-runtime/pi/model-adapter.ts` into Pi's
`Model<Api>` plus `StreamFn`; `PiAgentRuntime` owns the loop and normalizes SDK lifecycle events into
CRM runtime events. OpenAI-compatible providers use Pi's OpenRouter chat-completions transport
implementation behind the CRM-owned provider id. OpenCode Zen fixes the canonical endpoint at
`https://opencode.ai/zen/v1`, API `openai-completions`, and forwards the organization credential;
the model id is selected from the catalog. The adapter's allowlisted fetch constrains egress to
that endpoint. A real model/tool-loop smoke was run against Zen with a read-only CRM-shaped tool
fixture; it proves protocol and tool-call compatibility, not the durable Workbench path or a real
tenant database.

## Knowledge and evidence boundary

`lib/ai/knowledge/contracts.ts` is the product contract shared by local RAG and future knowledge
providers. It distinguishes namespaces (CRM records, conversations, organization memory, wiki,
Skills, run history, and external systems) from physical providers and normalizes every result to
an evidence item with a stable locator. Provider or Pi response types do not cross this boundary.

Wiki / Playbook is a real organization knowledge-source type, not a placeholder card. Markdown,
text, CSV, and PDF input follows the existing private-storage → extraction → chunking → embedding
→ active-version path. Built-in Agents that declare `organization_wiki` receive the current active
organization source ids in their locked runtime version. The `crm_search_knowledge` result retains
its compatibility fields and now also returns normalized `evidence` plus retrieval status. Empty
or unavailable corpora are represented explicitly and never converted into invented evidence.

Each built-in definition owns a `knowledgePolicy`: permitted namespaces, retrieval expectation,
citation rule, minimum evidence, and behavior when material is missing. This is configuration for
the Harness, not prompt-only prose.

## Run evaluation boundary

`lib/ai/evals/contracts.ts` defines evaluation profiles, deterministic findings, an optional
semantic-judge port, and an optional report store. The first implementation is deliberately
deterministic: it evaluates terminal outcome, grounded knowledge observations, tool failures,
policy/confirmation ordering, and tool-call efficiency from the durable run state.

`GET /api/v1/ai/workbench/runs/:id/evaluation` returns the profile-specific report without exposing
raw CRM messages or tool results. `POST` on the same resource explicitly runs the cost-bearing
semantic Judge with the exact persisted provider/model binding. The Judge submits a complete
versioned rubric through one schema-validated, in-memory tool; it has no CRM tools or external side
effects. Its verdict may lower but never raise the deterministic verdict. Successful results are
cached by run material, profile revision, rubric revision, provider and model. The existing
Flywheel judge remains a live-learning loop over production turns and is not the acceptance suite
for a specific Workbench run.

Specialists also return structured claims (`subject`, `predicate`, typed value, confidence and
evidence locators) alongside bounded evidence summaries. The evaluator counts those claims and
can distinguish a specialist that merely produced prose from one that submitted auditable facts.
The versioned golden corpus covers safe read synthesis, unsupported claims, external-action
confirmation, rejected proposals, provider failure, budget exhaustion and specialist conflict.

## Bounded Multi-Agent runtime

Opportunity-scoped runs of Sales Operations and CRM Supervisor can execute the versioned
`opportunity_review_v1` collaboration plan. It launches three independent read-only specialists in
parallel: customer/conversation evidence, opportunity/follow-up diagnosis, and policy/organization
knowledge. Each specialist is a durable `ai_workbench_runs` child with its own private Pi state,
ordered events, model-call attribution, terminal status, and shared parent budget. The parent owns
the synthesis and remains the only writer.

`BoundedAgentCollaborationRuntime` enforces concurrency, aggregate tool calls, token allocation,
timeout and parent cancellation. Completed child results are reused after a worker retry. Every
unfinished child must first acquire an atomic PostgreSQL execution lease and a unique attempt
token. A lease-expired child may be reclaimed, but the stale worker's token can no longer complete,
fail or cancel it. Parent cancellation propagates to active calls and marks not-yet-started children
cancelled. Parent events expose start, completion, failure and conflict summaries without exposing
CRM bodies. The database enforces inspect-only child runs, same-organization parent links, one
child per specialist and parent, root/child lease shape, and service-role-only claim access.

This is deliberately not a generic agent graph. Bulk lead screening stays a deterministic database
query followed by Agent analysis of a shortlist; it never creates one Agent per row. Writes,
external effects and human confirmation continue through the existing parent proposal policy.

## Run and event contract

The stable product API lives under `/api/v1/ai/workbench`. Run rows, ordered product events, and
private action proposals are tenant-scoped. Initial runs are enqueued as `workbench_start`; after a
human decision, the saved Pi state resumes through `workbench_resume`. Both use the existing worker
lease/reaper and persist only run identifiers in queue payloads. The client follows the run with
resumable SSE (`Last-Event-ID` or `after`),
so reloads can replay committed events. Event payloads use a field allowlist and exclude CRM message
bodies, raw tool arguments, and credentials. Proposal arguments are readable only by the server
service role and are not returned by run-detail endpoints. Pi conversation snapshots live in a
separate service-role-only state table, apart from manager-readable run metadata.

CRM scope is resolved and checked against the active organization before a run is created. During a
run, cancellation is observed by the executor and propagated to the Pi model call using
`AbortSignal`. The run records model/tool lifecycle summaries and usage in CRM-owned tables.

## Current autonomy boundary

`inspect` mode blocks CRM mutation tools at the preview policy boundary. In `act` mode only the
explicitly compensated subset of `crm_update_lead` (title, description, contact, value, currency,
and expected close date) executes automatically. The harness snapshots through CRM tools, uses
optimistic concurrency, persists a business inverse, and resumes Pi with the result. Other CRM
writes remain durable proposals requiring a human decision; external effects are never executed
directly by the model.
The catalog classifies every registered CRM tool; unknown tools fail closed. Human-approved actions
are executed through the CRM tool port, appended as observations to the persisted Pi message state,
and resumed without replaying the original task. A manager can undo eligible lead-field updates;
the inverse uses the post-write `updated_at` as a compare-and-set guard, so a later human change is
never silently overwritten. The sandbox may mount the native handoff action only to capture a
proposal; production MCP turns continue to block it and use the canonical runtime handoff path.
External messaging is staged as an `ai_reply_drafts` record tied to the exact workbench run and
proposal. Approval goes through the existing `fn_reply_action` boundary, which atomically creates
an `approved_reply` queue job; the normal delivery worker rechecks conversation/agent revisions,
service boundary, opt-out and the live send-guard chain, then uses the send ledger for idempotency.
The workbench approval route never calls a channel adapter directly. Handoff proposals are enabled
only for the built-in communications Agent and execute through the CRM handoff orchestrator after
an explicit human decision.

Migration 0384 adds durable child identity, model-call attribution and versioned evaluation reports.
Migration 0385 adds specialist execution fencing (`execution_attempt_id`, lease expiry, atomic claim
RPC and stale-writer rejection). The disposable PostgreSQL gate verifies clean install, idempotent
update, parent/child constraints, evaluation fingerprint uniqueness, and manager-only
tenant-isolated report reads; the local live database additionally exercises claim, lease expiry,
reclaim and stale completion in one rolled-back transaction.

## Real-data E2E boundary

`tests/e2e/agent-crm-workbench-real-model.spec.ts` runs mutations and external-action proposals
only against the synthetic `pi-native-demo` organization. The opt-in
`agent-crm-workbench-real-tenant.spec.ts` signs in as a manager of a locally restored tenant,
selects one contact by `CRM_REAL_E2E_CONTACT_QUERY`, and runs the Intelligence Agent in read-only
mode. Configure `CRM_REAL_E2E_EMAIL`, `CRM_REAL_E2E_PASSWORD`, and the query only in the local
`.env.e2e`; Playwright already rejects non-loopback Supabase URLs. The real-data spec disables
trace, screenshots, and video. The organization must have its actual model credential configured
through the CRM credential UI. No real-tenant mutation scenario is enabled.

## Verification snapshot — 2026-09-26

- `pnpm typecheck`: PASS.
- `pnpm exec vitest run --maxWorkers=4`: PASS — 1,243 files; 12,401 passed and
  one repository-declared expected failure (12,402 total).
- `pnpm lint`: PASS — 0 errors; existing repository warning backlog remains.
- `pnpm lint:channels`, `pnpm lint:role-rank`, `pnpm test:shell`, and
  `git diff --check`: PASS.
- `pnpm build`: PASS; workbench pages and API routes compile and are emitted.
- Durable start/resume queue wiring: `pnpm typecheck`, focused lint, and the four
  queue/migration invariant test files PASS (12 tests). The local database used
  for inspection is still missing these migrations, so the queue was not exercised
  against PostgreSQL in this environment.
- Postgres-backed migration/invariant tests and real-model browser scenarios are
  not verified in this environment; do not treat the slice as production-proven
  until those gates run against a disposable local database with model credentials.

## Knowledge and eval increment — 2026-09-27

- `pnpm typecheck`: PASS.
- Focused ESLint over the knowledge, built-in Agent, Eval, Workbench API/UI, MCP, and indexer
  changes: PASS.
- Focused Vitest: 7 files / 43 tests PASS for deterministic evaluation, built-in capability
  declarations, event redaction, MCP mount policy, knowledge retrieval, Wiki registration UI, and
  indexer extraction failures.
- Collaboration contract Vitest: 2 tests PASS for read-only specialists and parent-only writing.
- `git diff --check`: PASS.
- A real-model run over newly indexed Wiki content and a semantic LLM judge are not part of this
  increment. The UI reports the semantic judge as unconfigured instead of presenting a false pass.

## Bounded collaboration verification — 2026-09-27

- Production build, full TypeScript check, focused ESLint and collaboration/final-answer/Eval
  Vitest suites: PASS.
- Disposable PostgreSQL 15 baseline install + idempotent update + DuoAgent invariant suite: PASS.
- Real `opencode / space-bunny-free` browser run `437ba48c-b565-4ea4-8aef-c70c09db461b`: PASS.
  Three durable specialists ran concurrently, the parent synthesized afterward, nine tool calls
  completed with zero errors, and the persisted Eval profile revision 3 scored 87/100.
- Product `final_text` begins at the formal Markdown report boundary. Provider drafting prose stays
  only in the service-role run state; an output without a reliable boundary fails partial with a
  safe placeholder.
- The remaining `needs_review` is real: the demo organization has no published Wiki evidence, and
  the policy specialist therefore reports a partial result. Semantic Judge remains explicitly
  `not_configured`; deterministic safety gates do not pretend to grade semantic correctness.

## Mature runtime and Eval verification — 2026-09-28

- Real parent run `b030b8d5-ba15-4168-8407-1ad886ce1743` completed through
  `opencode / space-bunny-free`: three durable specialists, eight successful CRM tool calls, zero
  tool errors and 56 structured claims. The policy specialist correctly ended `partial` because no
  published Wiki source exists.
- Eval profile revision 5 returned deterministic `needs_review`, 87/100. The explicit semantic
  Judge returned `pass`, 88/100, but composition retained the stricter 87/100 result. Repeating the
  Judge request hit the persisted cache.
- A real-provider Judge initially exposed output-truncation behavior in a reasoning model. Moving
  result submission to the internal schema tool removed reliance on prose/JSON placement while
  retaining the typed fail-closed text fallback.
- Specialist execution fencing was proven against the local PostgreSQL database: live leases are
  not reclaimed, expired leases are reclaimed, stale attempts update zero rows and the current
  attempt closes exactly one row.
- Full details and sanitized Agent input/output/tool traces are in
  `docs/testing/multi-agent-eval-real-run-2026-09-28.md`.

## Chat-first workbench surface — 2026-10-01

The `/app/ai/workbench` route now owns the available viewport inside the existing AppShell.
It preserves all application navigation, the current tenant/role guards, the shared voice-footer
reservation and the organization model binding. Only this route replaces outer page scrolling
with a bounded message area and a non-shrinking composer. `visualViewport` resize/scroll events
update available height; banners above the shell are measured without a second hardcoded header
height. Physical mobile-keyboard and browser geometry verification remain outstanding.

- The compact agent picker and execution mode stay visible. Enter submits, Shift+Enter inserts a
  newline, and composition events/keyCode 229 do not submit Chinese text prematurely.
- Task settings contain CRM-object search, explicit lead-mission delegation/acceptance, knowledge
  policy, evaluation profile and copy/customize. Inspect mode and scope changes still clear
  delegation; missing acceptance opens settings instead of silently blocking behind a closed panel.
- Run details contain proposals and approve/reject/undo, mission state, reply drafts, usage,
  specialists, evaluation/Judge and the complete expandable event trace. Pending proposals also
  surface an action in the conversation. Run termination and business acceptance remain distinct.
- New Conversation clears local presentation/draft/mission options and returns to inspect mode;
  it does not delete durable runs. History loads the real persisted record. Active historical or
  deep-linked runs refresh until terminal; stale history/deep-link responses cannot overwrite a
  newer selection. Cancellation remains available while a run is active.
- Multiple completed task/result pairs remain visible during this mounted session. This is a
  presentation grouping, **not a new durable conversation or implicit model memory**. Every submit
  retains the existing independent `POST /api/v1/ai/workbench/runs` contract, scoped CRM context
  and server-side runtime. No fixture replies are mounted in the production app.
- Radix Sheet supplies modal focus trapping, Escape and close controls. Errors are visible inside
  the open panel. Focus returns to the composer or an enabled panel opener during active runs.

### Living-system checklist and destination

Destination: **core UI**, because the already-distributed workbench must remain useful with zero
extensions. No new database, permission, tool or worker contract is introduced.

1. Input: built-in agents and tenant-scoped run/detail/object/evaluation APIs.
2. Output: existing run creation, cancel, proposal decision/undo and evaluation endpoints.
3. Records: existing durable `ai_workbench_runs`, ordered events and server audit boundaries.
4. Visibility: conversation results plus the Run Details panel in `AgentCrmWorkbench`.
5. Entry: existing navigation destination `/app/ai/workbench`; no menu removed or new route added.
6. Continuation: visible pending approvals, durable history, active-run refresh and stop.
7. Configuration: Task Settings plus `/app/ai/providers`; missing model disables execution.
8. Human/AI continuity: existing persisted proposal decisions and resumed runs.
9. Feedback: visible in-panel errors, retryable drafts, deterministic/optional semantic evaluation;
   no automatic learning or new memory writes are claimed.
10. Map: this section records the unchanged UI → workbench API → durable runtime edges; no new
    architecture node is needed for the layout change.

### Verification boundary

Focused offline React/DOM tests cover conversation grouping, API payloads, keyboard/IME,
settings dismissal/focus, mission reset, history/cancellation/approval/undo and viewport reservation
contracts. Fetch is fully stubbed in those tests. They prove behavior and containment classes,
not physical browser layout, live model behavior or a fresh-Supabase E2E journey.
The existing opt-in real-model/real-tenant E2E selectors follow the new controls, but were not run
for this port. Full unit/CI execution is intentionally not claimed because the existing full
suite includes live external-model paths; required live/browser checks remain a maintainer gate.

## Real-runtime parity wiring (2026-10-01)

The versioned organization-memory assembly in `lib/agent-engine/agent/org-memory.ts` is shared by
inbound, the MCP read and both initial/resumed Workbench model calls. Specialists inherit that
system context. Resumption resolves the current published policy and records its content-free
revision in `context_loaded`; it does not claim an old frozen policy snapshot.

`crm_get_conversation_history` adds read-only customer memory through `customer-memory.ts` only
for the current organization/contact/conversation/service/demanda boundary. It rechecks that
boundary after reading, and never falls back to a different conversation or a contact-wide record.

RAG reads immutable chunk provenance after vector retrieval. The common evidence parser preserves
nested locators into specialist state. Source revisions and chunk excerpt identity are checked
separately to avoid reporting complementary paragraphs as contradictions. The observed-evidence
projection re-authorizes current runnable Agent source IDs (including built-in drafts), source
activation and memory visibility before rendering snippets; raw runtime messages remain private.
The precise source endpoint supports version/chunk locators and labels noncurrent indexes.

MissionSendControl calls the existing atomic send-policy command with a reason and replay key.
It controls customer sending only, never claims to suspend all execution or recall in-flight
messages. Eval refuses incomplete material reads and the UI exposes deterministic finding reasons.
See [the capability/setup matrix](../design/crm-real-api-parity-2026-10-01.md) for tested boundaries
and the deliberately separate local demonstration semantics.
