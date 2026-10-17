# Module mapping

| Existing module                                     | Action                         | Pi-native destination                                         |
| --------------------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| `lib/agent-engine/agent/inbound-turn.ts`            | ADAPT then split               | CRM turn builder and policy callbacks                         |
| static tool definitions and opening context          | ADAPT then split               | `tool-definitions.ts`, `context-builder.ts`, `checkpoint-contract.ts` |
| `lib/agent-engine/edge/llm/run-model-call.ts`       | KEEP boundary, ADAPT execution | model gateway + `AgentRuntime` delegation                     |
| Vercel AI `generateText` loop                       | REPLACE in production          | `PiAgentRuntime`                                              |
| `lib/agent-engine/edge/llm/providers.ts`            | KEEP governance metadata       | provider/model policy; Pi adapter handles streaming           |
| `AGENT_TOOL_DEFS`                                   | ADAPT                          | `RuntimeTool[]` with capability classes                       |
| queue/lease/reaper/event-log                        | KEEP                           | unchanged CRM harness                                         |
| memory/RAG/skills/handoff/followup                  | KEEP, expose callbacks/tools   | domain adapters injected into the turn                        |
| former `lib/ai/runtime/agent.ts`                   | DELETE                        | moved to `lib/agent-engine/agent/ai-agent-run.ts`; persisted-run composition delegates to Pi |
| direct provider SDK imports outside gateway/adapter | REPLACE                        | route through model gateway or Pi adapter                     |

No database schema change is required for the runtime boundary. Existing
`llm_calls`, event-log, queue, audit, RLS, and multi-tenant rules remain the
system of record.

## Complete `lib/agent-engine` classification

The table above names the architectural seams. The following directory-level
map covers every production module under `lib/agent-engine` (test files are
verification artifacts, not runtime modules). A row applies to every module in
the listed path unless a more specific row overrides it.

| Path / modules | Classification | Reason and destination |
| --- | --- | --- |
| `agent/inbound-turn.ts` | ADAPT + SPLIT | CRM turn orchestration, durable outcomes, policy callbacks, and queue decisions remain here; generic execution moved behind `AgentRuntime`. |
| `agent/turn-tools.ts`, `tool-definitions.ts`, `context-builder.ts`, `checkpoint-contract.ts` | ADAPT | CRM-owned tool closures, capability metadata, context assembly, and checkpoint parsing are injected through the Pi-facing seam. |
| `agent/pi-turn-execution.ts` | ADAPT | Single model-call seam: delegates execution to `AgentRuntime` while retaining the CRM gateway contract. |
| `agent/ai-agent-run.ts`, `request-deps.ts`, `sandbox.ts`, `preview.ts`, `reply-drafts.ts`, `case-reply-turn.ts`, `followup-turn.ts`, `operator-turn.ts` | ADAPT | Composition and preview paths remain CRM-owned and inject the canonical Pi runtime; no independent loop is retained. |
| `agent/agent-config.ts`, `resolve-turn-agent.ts`, `router-config.ts`, `intent-classifier.ts`, `stage-classifier.ts`, `declaracao.ts`, `projecao.ts` | KEEP | Agent configuration, routing, intent, sales state, and context projection are business domain responsibilities. |
| `agent/search-knowledge.ts`, `skill-references.ts`, `skills.ts`, `playbook.ts`, `playbook-seed.ts`, `lead-notes.ts`, `lead-notes-recall.ts`, `org-memory.ts`, `compromissos-do-contato.ts` | KEEP | RAG, skills, playbooks, customer memory, organization memory, and CRM context remain database-backed domain services. |
| `agent/human-cases.ts`, `human-handoff.ts`, `aviso-de-escalacao.ts`, `approved-reply.ts`, `atraso-humano.ts`, `janela-de-atendimento.ts`, `janela-de-followup.ts`, `schedule-followup.ts`, `followup-flow-classify.ts` | KEEP + ADAPT | Handoff, follow-up, service-window, and human-ownership policy remain CRM business logic exposed as tool callbacks. |
| `agent/abordagem-de-formulario.ts`, `aux-model-args.ts`, `compaction.ts`, `media-parts.ts`, `prune-tool-results.ts`, `reentry-knobs.ts`, `reentry-template.ts`, `split-message.ts`, `sugestao-de-resposta.ts`, `fuso-da-org.ts`, `meet-delivery.ts`, `playbook.ts` | KEEP | Supporting CRM context, compaction, media, pacing, and response-shaping behavior; no agent loop ownership. |
| `edge/llm/run-model-call.ts` | ADAPT | Model Gateway orchestration: provider/model/credential resolution, budget, pricing, usage, audit, and Pi execution delegation. |
| `edge/llm/credentials.ts`, `binding-do-ponto.ts`, `capabilities.ts`, `orcamento.ts`, `pricing.ts`, `stable-prefix.ts`, `prazo-do-endereco-proprio.ts`, `count-tokens.ts` | KEEP + REFACTOR | Provider governance and accounting stay outside Pi; split helpers provide the gateway's policy seams. |
| `edge/llm/providers.ts`, `test-model.ts`, `embed.ts` | KEEP | Vercel AI SDK factories remain only for non-agent auxiliary calls, smoke tests, and embeddings; production agent execution uses the Pi model adapter. |
| `edge/crm/*`, `edge/channel/*`, `channel-adapter.ts`, `edge/egress.ts` | KEEP | CRM tools, MCP bridge, channel adapters, egress policy, session reconciliation, and message delivery are infrastructure/business boundaries. |
| `db/*` | KEEP | Pool and repository access remain PostgreSQL infrastructure; Pi never queries CRM tables directly. |
| `queue/*`, `cron/*`, `flywheel/*` | KEEP | Claim, retry, lease, reaper, scheduler, and event-driven background work remain outside the agent kernel. |
| `guardrails/*`, `pacing/*`, `spinning/*`, `health/*` | KEEP | Safety, anti-ban pacing, liveness, circuit, and channel health policies remain CRM infrastructure. |
| `obs/*`, `env.ts`, `surrogates.ts` | KEEP + ADAPT | Logging, metrics, environment policy, and test surrogates consume normalized runtime events and injected runtime contracts. |
| former `lib/ai/runtime/agent.ts` and any executable Vercel agent loop | DELETE | Removed from the production graph; only provider-neutral CRM support utilities and non-agent compatibility calls remain. |

This map intentionally classifies by responsibility rather than moving files
just to make the tree look new: business intelligence stays in the CRM while
agent infrastructure is replaced by the Pi adapter.
