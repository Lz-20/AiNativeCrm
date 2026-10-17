# Workbench Semantic Judge Adapter

## Boundary

The semantic Judge is an optional, explicit second evaluator for a completed Workbench run. It is
not part of the Agent execution loop and it cannot approve an execution that failed a deterministic
safety rule. `GET /evaluation` remains deterministic and free of provider calls;
`POST /evaluation` is the user-triggered, cost-bearing Judge operation.

The CRM-owned port is `AgentSemanticJudge` in `lib/ai/evals/contracts.ts`. The concrete
`LlmAgentSemanticJudge` adapter maps that port onto the existing `runModelCall` provider boundary.
No Pi, AI SDK, or provider response type crosses into the Eval domain.

## Model mapping

- The adapter receives the exact provider, model, credential id, organization id, Agent id, and
  Workbench run id resolved from the persisted run version.
- It invokes `runModelCall` with purpose `workbench_eval_judge`, the explicit evaluation runtime,
  at most two turns, and a 4,000-output-token ceiling.
- The only mounted tool is `submit_semantic_evaluation`. It is an in-memory, Zod-validated result
  channel: it has no CRM, database, network, or external side effect. The runtime stops as soon as
  the tool accepts one complete rubric.
- The run task and evaluation material are delimited as untrusted data. They cannot add tools,
  change the rubric, or alter system instructions.
- Providers that do not call tools may fall back to a balanced-object parser, but the response
  must still validate as one object containing all four rubric dimensions. Missing dimensions,
  invalid scores, truncated JSON, or prose-only output fail closed with typed errors.

## Rubric and verdict composition

Rubric revision 1 scores task fulfillment, factual support, honesty about missing material, and
actionability. The deterministic and semantic reports are composed by
`evaluateAgentRun`:

- a semantic result may lower the deterministic verdict or score;
- it can never upgrade a deterministic `fail` or remove a deterministic finding;
- Judge failure turns a deterministic pass into `needs_review`, while an existing deterministic
  failure remains `fail`;
- a non-terminal run does not call the Judge.

The persisted fingerprint includes the Eval profile revision, rubric revision, provider, model,
and normalized run material. Successful reports are cacheable and reproducible. A failed Judge
attempt receives a distinct failure fingerprint, so a transient provider outage does not poison a
later retry.

## Cancellation, attribution, and privacy

The route's 120-second `AbortSignal` is passed through the Judge adapter to the provider call. Usage is written
through the normal `llm_calls` path with the same organization, Agent, and Workbench run attribution
as the evaluated execution. The Judge receives a bounded digest: redacted event metadata,
specialist summaries, structured claim counts, and at most 24 bounded tool observations. Provider
credentials, raw action arguments, and unrestricted CRM records are excluded.

## Failure handling

Provider errors, invalid JSON, schema failures, and cancellation are surfaced as an explicit
`semanticJudge.status = failed`; they are not converted into a score. The deterministic report
remains available for diagnosis. Retrying the explicit POST reuses the same run snapshot and exact
model binding unless the underlying run material or versioned evaluator configuration changed.

## Real-provider proof — 2026-09-28

Run `b030b8d5-ba15-4168-8407-1ad886ce1743` was judged through
`opencode / space-bunny-free`. The provider called the structured submission tool and completed in
19.9 seconds (9,861 input, 2,114 output, 5,260 cache-read tokens). The semantic Judge returned
`pass`, 88/100, while the stricter deterministic profile remained `needs_review`, 87/100. A second
identical POST hit the persisted evaluator fingerprint and made no model call. This verifies both
provider tool compatibility and the non-upgrade composition rule.
