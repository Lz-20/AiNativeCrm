# Agent service adapters — verification, 2026-10-02

Base: `80fb88d1141abc77ace1c70276a5fdfcdd5ae751`, branch
`feat/chat-first-workbench-2026-10-01`. The prior current-system-memory resume fix and the existing
chat-first/bright-neutral UI are preserved. No PR, merge, deployment, real credential setup or
external model/vendor request is part of this verification.

## Measured

- Consolidated offline regression: **20 files, 194 passed, 1 deliberately skipped live-provider test**, exit 0
- Full TypeScript: `node --max-old-space-size=6144 node_modules/typescript/lib/tsc.js --noEmit --incremental false -p tsconfig.typecheck.json`, exit 0
- Full repository ESLint: exit 0, 0 errors and 473 warnings. Targeted ESLint on every changed/new TypeScript/TSX file also exited 0, with only the pre-existing unused `env` import warning in the PDF renderer
- `git diff --check`: clean
- New release fragment: parsed successfully by the repository's `parseFragmento`
- `lint:role-rank`: passed
- Dedicated scheduler-entrypoint shell test: passed
- Independent read-only review: no unresolved must-fix functional issue in the reviewed first-increment scope; its final focused run had 15 files / 157 passed and 1 live-provider skip. These cases overlap the consolidated run and must not be added to its count

The adapter tests use synthetic SQL/HTTP fixtures. One test launches a real localhost HTTP receiver
and verifies OTLP path, Basic header and payload. Pi tests run the actual installed Pi runtime with
its official faux provider, including actual model streams and executed tools. No vendor stack is
running: HTTP fixtures are not evidence of live Mem0/WeKnora/Langfuse compatibility.

## Covered cases

- Default-off/no network, malformed configuration, cross-org binding denial and canonical project isolation
- Root/child/attempt model/tool span linkage, real provider usage, privacy canaries, observer exceptions and a never-settling observer
- Current leading system prompt after resume, preserved private provider continuation, steering and existing organization-policy fail-closed behavior
- Durable sanitized payload creation, delivery disabled after enqueue, strict outbound schema, stable score event ID/name/timestamp over UTC midnight, rejected/incomplete HTTP 207 receipts
- Manager/admin role gates, support-write denial, forged organization input, stale setting revision, source registration after PostgreSQL JSONB key reordering
- Explicit deterministic score projection without a model; GET remains read-only; invalid operation cannot start a paid judge
- Mem0 `infer:false` writes, pinned server capability guard, exact ownership reconciliation, same receipt replay, ambiguous ADD refusal, delayed ADD versus deletion, tombstones and remote content unable to replace local confirmed facts
- Current source/KB checks, published-corpus restriction, absent provenance, stale/deleted/foreign Wiki sources and page revisions; safe evidence URLs ignore arbitrary supplied links
- Customer-memory and provider controls render actual API state; same-content UI retry preserves the idempotency key
- Existing LGPD export, business event drain/recovery, cron scheduling/audit, migration manifest and PostgreSQL-version static guards

## Reproduction

Use installed dependencies, avoiding automatic package reconciliation:

```sh
node --max-old-space-size=6144 node_modules/vitest/vitest.mjs run \
  lib/ai/integrations/integrations.test.ts \
  components/ai/AgentServicePanels.test.tsx \
  app/api/v1/ai/integrations/route.test.ts \
  lib/agent-runtime/pi/runtime.test.ts \
  lib/ai/agents/run-resumed-workbench-turn.test.ts \
  lib/ai/agents/workbench-start-job-memory.test.ts \
  lib/agent-engine/agent/customer-memory.test.ts \
  lib/mcp/tools/evolucao-evidence.test.ts \
  lib/ai/knowledge/evidence.test.ts \
  lib/ai/agents/workbench-observed-evidence.test.ts \
  lib/ai/evals/evaluate-run.test.ts \
  'app/api/v1/ai/workbench/runs/[id]/evaluation/route.test.ts' \
  tests/unit/lgpd-export-prospecting.test.ts \
  tests/unit/lgpd-exporta-o-que-redige.test.ts \
  tests/unit/manifest-x-migrations.test.ts \
  tests/unit/baseline-no-piso-do-postgres.test.ts \
  tests/unit/dreno-nao-perde-evento.test.ts \
  tests/unit/cron-routes-scheduled.test.ts \
  tests/unit/cron-audita-so-quando-ha-efeito.test.ts \
  app/app/ai/workbench/_components/MissionSendControl.test.tsx \
  --testNamePattern='^(?!.*OpenCode Zen)' --reporter=verbose
```

The default 2 GiB Node heap was insufficient for the full TypeScript graph; the 6 GiB invocation
above completed. The `pnpm exec` available in this executor attempted package reconciliation and
failed on its home path, so the checked-in package versions were invoked directly. `tsx` CLI IPC
was unavailable; `node --import tsx` ran the same static lint/release scripts without its CLI IPC.

## Existing failures and blocked/unmeasured stages

- Full shell chain stopped on `tests/shell/instalar-guias.test.sh`: the unchanged README did not match
  its `$pi-native-instalar` wording assertion. Remaining scripts were run separately
- The unchanged `tests/shell/extensao-nao-instala.test.sh` also failed its expected network-error
  wording: the invalid-origin fixture reached the script's “not a catalog” response instead. Its
  source file and test are unchanged. All other shell scripts in the repository command completed
- Channel lint flagged the **unchanged** signed-inbound witness SQL in
  `lib/ai/evals/mission-explicit-offer-evidence.ts` for a provider literal outside `lib/channels`
- Whole-repository release-fragment validation flagged the **unchanged**
  `mission-explicit-offer-review.md` and `mission-signed-channel-evidence-review.md` for missing opening
  front matter. The new `optional-agent-services.md` is valid
- `PATH="$PWD/node_modules/.bin:$PATH" bash scripts/test-db.sh` was attempted and stopped at
  `docker: command not found`. No real baseline install/reapply, PostgreSQL FK/trigger/RLS behavior
  or DB invariant execution is claimed. `tests/invariants/ai-service-integrations.test.ts` is added
  for the existing Docker-backed DB harness. Migrations 0405–0407 are also in the baseline and manifest
- No browser-driven fresh-install E2E, production build, complete unit suite, live credentials,
  vendor service ingestion, deployment, external model call or private-data export was performed
- Wiki receipts freeze observed page text and source metadata, not original source-document bytes
- Langfuse server-side erasure/retention is operator-managed in this increment. Do not treat telemetry
  delivery acknowledgment as verified ingestion or deletion

This is a tested **default-off adapter increment**, not a claim of production deployment or full
merge-readiness. Live acceptance requires authorized synthetic vendor round trips, real PostgreSQL
install/update/RLS tests, browser E2E, retention/deletion verification and remediation of existing
branch-wide gate failures. Operational contracts: `docs/integrations/agent-services.md`.
