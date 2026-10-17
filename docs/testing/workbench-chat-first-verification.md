# Chat-first Workbench verification — 2026-10-01

Base: `fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674`. Scope: real Workbench UI, its
route-specific AppShell layout, isolated demo source, and design/Wiki examples.
The backend runtime, database schema, role guards, workflow configuration and branch protection
are unchanged. The UI calls the original APIs; fictional demo code is isolated under `examples/`.

## Native UI checks

- Focused offline Vitest: 6 files, **38 tests passed**, exit 0. All workbench HTTP requests in these
  tests are in-memory fixtures, not live model or customer calls.
- Full repository TypeScript: `NODE_OPTIONS=--max-old-space-size=4096 tsc --noEmit -p
  tsconfig.typecheck.json`, exit 0.
- Targeted ESLint on all changed native TS/TSX files and their tests: exit 0, no warnings.
- `git diff --check`: passed.
- Regression sabotage: after preserving a local commit, removed the IME/composition guard only.
  The single keyboard regression failed exactly as predicted (1 failed, the other cases filtered
  out); the committed source was restored and the focused suite passed again.

Focused command (run from repository root with installed dependencies):

```sh
pnpm exec vitest run \
  tests/unit/workbench-chat-first.test.tsx \
  tests/unit/workbench-viewport-shell.test.tsx \
  tests/unit/workbench-delegation-state.test.tsx \
  tests/unit/rodape-ocupado-durante-a-chamada.test.tsx \
  tests/unit/barra-lateral-nao-flutua.test.ts \
  tests/unit/altura-fixa-le-a-reserva-do-rodape.test.ts \
  --maxWorkers=1 --reporter=verbose
```

Covered: internal-scroll/composer containment classes, viewport resize and banner observation,
normal-route sticky-header preservation, shared voice-footer reservation, two real-result display
turns, unchanged request payloads, Enter/Shift+Enter/IME, duplicate submit guard, missing model,
failed submit, acknowledged-run read failure and recovery, explicit mission acceptance and reset,
settings/modal dismissal, enabled focus restoration, active/deep-linked history and stale responses,
external approval resolution, approve/reject/undo, visible in-panel errors and cancel conflicts.

## Isolated demo checks

The [standalone demo](../../examples/chat-first-demo/README.md)'s five `npm test` suites pass: retained CRM/Mission smoke, complete-navigation
smoke, chat DOM/IME, executable runtime lab, and runtime-lab DOM/provenance/reload/reset.
The tests exercise all 62 retained render targets and structural narrow-screen rules; they do
not claim rendered mobile geometry. All 17 file hashes in `artifact-manifest.json` match the
copied source. No hosting IDs, credentials or personal filesystem defaults are included.

The example uses classic browser scripts and a CommonJS Node test harness. A narrow ESLint
configuration permits CommonJS only in that example's test files and dual browser/Node engine.
It is not excluded from lint; the existing unused-variable and test-console warnings are reported.
Production TypeScript/import rules are unchanged. See the example README for the precise boundary
between locally executed fixture traces and excerpts from the historical model report.

## Existing aggregate-check failures

These were verified in the unchanged base, not introduced by this UI diff:

- The canonical release checker rejects `.changes/mission-explicit-offer-review.md` and
  `.changes/mission-signed-channel-evidence-review.md` because their opening frontmatter is absent.
  The new `.changes/workbench-chat-first.md` passes `parseFragmento` from `lib/release/fragmento.ts`.
- `lint:channels` rejects the provider literal in
  `lib/ai/evals/mission-explicit-offer-evidence.ts:168`.

These findings are documented rather than silently broadening the UI change into unrelated fixes.

## Not verified

- No full unit suite or aggregate `gov:verify` pass is claimed. The existing full suite includes
  live external-model paths, which were outside this execution's permitted offline checks.
- No production build, fresh-Supabase E2E, live provider, customer channel, background worker,
  persistent-memory integration or role-expansion test was run for this port.
- The existing real-model/real-tenant E2E selectors were updated, but those opt-in specs were not run.
- No browser screenshot, pixel layout or physical phone/software-keyboard proof. The execution
  environment denied the prior supported browser/socket attempt; no alternative port, network
  route or access-policy bypass was used. DOM containment assertions are not geometry evidence.

## Draft PR and CI boundary

Publication uses `[skip ci]` in the HEAD commit. GitHub documents this for `push` and
`pull_request` triggers in [Skipping workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs).
The base's `ci`, `e2e`, `perf` and image-build PR workflows use those triggers. `acolhida` uses
`pull_request_target`, but only for fork PRs, without checkout or test execution; the other
workflows are scheduled or manually dispatched. No workflow is disabled or edited.

Skipped required checks may remain pending; they are **not passing evidence**. This change stays
in draft for review and the missing safe/live/browser validation. It does not authorize merge,
automatic merge or deployment of the production application.
