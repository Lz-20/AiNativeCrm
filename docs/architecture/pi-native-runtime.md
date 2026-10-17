# Pi Native CRM runtime architecture

Pi Native CRM separates CRM policy from agent execution:

```text
CRM domain / agent turn
        │  messages, tools, guardrails, tenant context
        ▼
AgentRuntime (lib/agent-runtime/types.ts)
        │
        ▼
PiAgentRuntime ── @earendil-works/pi-agent-core
        │          └─ @earendil-works/pi-ai provider adapters
        ▼
Model gateway / provider governance
        │  BYOK, platform fallback, binding, budget, usage, audit
        ▼
Anthropic · OpenAI · Google · OpenRouter · DeepSeek
```

`AgentRuntime` is the CRM-owned seam. Domain code must not import Pi types or
call a provider SDK. Tools are CRM capabilities with an explicit capability
class (`read`, `write`, `send`, `handoff`, or `external`). The Pi adapter owns
the loop, context transformation, tool lifecycle, parallel/sequential tool
execution, stop conditions, abort propagation, and runtime events.

Provider resolution remains a separate concern. `runModelCall` continues to
resolve the organization, enforce the budget before network I/O, apply purpose
bindings, record usage/failures, and audit the call. In Pi mode it delegates
only execution to `PiAgentRuntime`; it does not hand governance to the kernel.

Runtime modes:

- `pi`: canonical execution path (default).
- `shadow`: Pi planning/evaluation with non-read tools blocked before their
  wrapped CRM handler can execute. There is no legacy agent-runtime selector;
  compatibility-only Vercel calls remain outside the agent execution path.

The compatibility adapter in `lib/agent-runtime/pi/ai-sdk-compat.ts` lets the
existing harness migrate incrementally while the CRM turn is split into
domain-owned seams. `pi-turn-execution.ts` owns the model-call adapter,
`tool-definitions.ts` owns the static capability registry, and
`context-builder.ts` owns checkpoint/lead-context assembly. The remaining
inbound-turn code is intentionally CRM policy and persistence: guarded tool
closures, handoff/follow-up behavior, checkpoint writes, and queue outcomes.
The compatibility adapter is a bridge, not the target domain API.

## Optional external Agent services

The default-off adapters and their exact ownership, activation, delivery and verification limits are
specified in [Agent services](../integrations/agent-services.md). Pi's real model/tool execution
boundary emits only allowlisted measurements; customer memory and company Wiki retrieval remain
separate from SQL workflow/approval authority. See the [service map](agent-services.architecture.json).
