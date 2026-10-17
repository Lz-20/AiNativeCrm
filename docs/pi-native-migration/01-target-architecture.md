# Target architecture

The target is a Pi-native CRM with a stable CRM-owned runtime boundary:

```text
Inbound event → queue/lease → CRM turn builder
                         │
                         ├─ tenant/RLS context
                         ├─ memory/RAG/context transform
                         ├─ published skills and tools
                         └─ before/after effect policy
                                  │
                                  ▼
                         AgentRuntime.run()
                                  │
                                  ▼
                    Pi Agent Core + Pi AI provider
                                  │
                                  ▼
                 CRM result persistence and side effects
```

The model gateway is intentionally outside the kernel. It resolves BYOK or
platform credentials, purpose bindings, custom endpoint policy, enabled models,
budget state, pricing, usage, and `llm_calls` audit records. Pi receives only
the final model binding and the CRM-owned capability set.

The queue and event-log harness remain the source of truth for delivery and
retry. Pi is not allowed to claim jobs, query CRM tables directly, bypass RLS,
send messages, or perform handoffs without a CRM tool invocation.
