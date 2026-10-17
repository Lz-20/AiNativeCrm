# Current architecture inventory

This inventory was confirmed from the current checkout, not inferred from the
older architecture notes.

| Area              | Current source                                        | Migration observation                                                                             |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Queue/worker      | `workers/agent-worker/main.ts` and `lib/agent-engine` | Keep. Claim, lease, retry, reaper, event-log, and cron behavior are CRM harness responsibilities. |
| Inbound turn      | `lib/agent-engine/agent/inbound-turn.ts`              | Keep business policy; model execution, static tools, and shared context assembly are extracted seams. |
| Model seam        | `lib/agent-engine/edge/llm/run-model-call.ts`         | Keep governance and audit; delegate execution to `AgentRuntime`.                                  |
| Former agent loop | Vercel AI `generateText` path                         | Removed from production; non-agent Vercel calls remain only in gateway/installation compatibility paths. |
| Provider registry | `lib/agent-engine/edge/llm/providers.ts`              | Keep as governance/validation; Pi adapter owns provider streaming.                                |
| Tools             | `tool-definitions.ts` plus handlers in inbound-turn  | Static schemas are isolated; handlers retain `RuntimeTool` capability metadata, CRM guards, and tenant scoping. |
| Checkpoint/context | `checkpoint-contract.ts`, `context-builder.ts`       | Keep durable checkpoint shape and lead-context projection separate from the turn orchestrator.   |
| Persistence       | Postgres migrations, RLS, `event_log`, `llm_calls`    | Keep unchanged unless a separate schema requirement is approved.                                  |

The current state contains a roughly 4k line inbound-turn module, but the
generic execution seam, static tool registry, checkpoint contract, and shared
context assembly now live in dedicated modules. The remaining large module is
CRM policy and persistence, so the compatibility adapter can be retired without
moving business rules and provider execution in one change.
