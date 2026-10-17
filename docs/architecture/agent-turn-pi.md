# Agent turn contract

An agent turn has four layers:

1. The CRM builds tenant-scoped context, system policy, memory/RAG results,
   published-agent configuration, and capability tools.
2. The model gateway resolves provider/model/credential/binding and performs
   the preflight budget decision.
3. `AgentRuntime.run()` executes the turn. Pi Agent Core owns the loop and
   emits lifecycle/tool events; CRM callbacks enforce before/after tool policy.
4. The CRM persists the resulting messages, usage, audit trail, and queue
   state. Sending, handoff, and external automation remain CRM-owned effects.

The runtime contract is intentionally serializable and provider-neutral. A
tool receives only its arguments, a tool call id, and an abort signal. It does
not receive a Pi `Agent`, a provider client, or a database connection unless a
CRM adapter explicitly supplies one.

Side-effect policy is defense in depth:

- existing CRM guardrails remain inside the capability handler;
- `beforeToolCall` can block or terminate before execution;
- `afterToolCall` can redact/replace a result or terminate the turn;
- shadow mode blocks all capabilities except reads;
- tenant and RBAC checks remain at the database/API boundary.

Events are normalized into `AgentRuntimeEvent` so queue telemetry, audit, and
future realtime UI do not depend on Pi event names or package versions.
