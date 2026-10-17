# Optional Agent services: Mem0, WeKnora and Langfuse

Status: first working integration increment, default off. This change installs **CRM adapters**,
not three running vendor platforms. No service credentials, OAuth grant, model call, private data
export or vendor deployment is performed by migration or application startup.

## Responsibilities and activation

- SQL CRM records, Mission state, approvals and the published organization policy remain authoritative.
- Mem0 ranks customer preferences, human-confirmed facts and communication context. It cannot
  publish company/product policy or alter approval state. This increment does **not** automatically
  extract all chats into memory. A manager confirms each fact in the contact detail screen.
- WeKnora supplies company/product Wiki pages. Generated prose is derived evidence, never approval
  of a price, delivery promise or contract. Commercial commitments still require approved materials.
- Langfuse receives actual Pi model/tool boundary measurements and CRM Eval scores. It is not a
  replacement for canonical SQL run/evaluation records and cannot mark a Mission complete.

The destination is infrastructure plus narrow core integration seams: with every integration off,
ordinary CRM operation remains intact. No paid platform becomes mandatory.

### Trusted installation binding

`AI_INTEGRATION_BINDINGS` is an optional, server-only JSON array. Omit it or use `[]` on a fresh
installation. Its fields are validated with Zod in `lib/ai/integrations/config.ts`; malformed
configuration fails closed for integrations without taking down the CRM. Never prefix it with
`NEXT_PUBLIC_` and never commit real values. A deployment secret manager or server environment
injects credentials; the product API never accepts or returns credentials or arbitrary service URLs.

Every item requires `organization_id`, `provider` (`mem0`, `weknora`, `langfuse`) and `base_url`
(an origin, without path, query, credentials or fragment). Mem0/WeKnora additionally require
`api_key`. Langfuse requires `public_key` and `secret_key`. WeKnora requires a nonempty
`knowledge_base_ids` allow-list and `visibility: "organization"`. Non-loopback plain HTTP requires
an explicit `allow_insecure_http: true` for a trusted private deployment network; use HTTPS otherwise.

A binding is not activation. An organization administrator must explicitly enable it in
**Agente de IA → Provedores → Agent 服务接入**. This screen shows the destination, configuration
readiness, pause/enable control, queued trace delivery counts, and orphaned memory-cleanup receipts.
“Configured” means the local fields exist; `connectivity_verified: false` is deliberate. The screen
makes no claim that credentials, reachability, vendor ACL or provider versions were validated live.
The enable operation uses an optimistic revision so stale views cannot overwrite newer settings.

Provisioning a service, adding persistent credentials/access, selecting an external LLM, and exporting
real data need the deployment operator's authorization and a privacy/security review. Use synthetic
facts and public product documents first. A shared endpoint is not a shared authorization boundary:
use separate Langfuse projects/keys per CRM org (the adapter rejects a repeated origin/public-key
pair), scoped WeKnora workspace keys with explicit KB allow-lists, and a Mem0 service accessible
only to this CRM backend. Mem0 `user_id` filters do **not** implement ACL; CRM owns the per-org,
per-contact identity map and accepts only remote IDs matched to its own current approved records.

## Verified upstream contracts

Verified against primary code/docs on 2026-10-02:

- Mem0 official OSS REST server commit
  [`abb81c88e1f738a8117d8293530fbc31a5ef8fd9`](https://github.com/mem0ai/mem0/tree/abb81c88e1f738a8117d8293530fbc31a5ef8fd9/server).
  The initially evaluated TypeScript OSS package was `mem0ai/oss` 3.3.1. This increment deliberately
  uses the narrower server adapter instead: no eager SDK import, implicit embedder configuration,
  client telemetry, or vector database dependency is added to the CRM. GET `/memories`, POST
  `/memories`, POST `/search`, DELETE `/memories/{id}` use `X-API-Key`. Each ADD sends one approved
  message, `infer: false`, an opaque `user_id`, a unique receipt `run_id` and scoped metadata.
  An OpenAPI capability check requires the `infer` and `filters` request fields before writing;
  older official REST servers silently ignored some of these fields. The operator must deploy the
  pinned reviewed code, not assume that any endpoint returning 200 is equivalent. Set
  **`MEM0_TELEMETRY=false` on the Mem0 server before it starts**; the CRM never calls `/configure`.
  `infer:false` avoids fact-extraction LLM work, but embeddings can still incur model cost.
- WeKnora [`v0.8.2`](https://github.com/Tencent/WeKnora/tree/v0.8.2), commit
  `3e8b0bfc80b845b2d4b2ed683994748741450a97`. Read-only `X-API-Key` calls use
  `/api/v1/knowledgebase/{kb}/wiki/search?q=...`, `/wiki/pages/{slug}` and
  `/api/v1/knowledge/{id}`. No second agent/chat pipeline is introduced. Wiki creation/ingestion is
  performed in the WeKnora service; this adapter does not upload company files or rebuild its platform.
- Langfuse server [`v4.49.0`](https://github.com/langfuse/langfuse/releases/tag/v4.49.0), current
  [OTLP/HTTP JSON contract](https://langfuse.com/integrations/native/opentelemetry).
  CRM posts `/api/public/otel/v1/traces` with Basic project-key authentication and
  `x-langfuse-ingestion-version: 4`. We use direct standards-based OTLP rather than a global SDK,
  because the existing SQL outbox must own durability, redaction, identity and retries. This is not
  the deprecated trace/span/generation ingestion API. Scores use the supported **score-only**
  `/api/public/ingestion` `score-create` event: its original timestamp is on the event envelope,
  not in the REST `/scores` body (that route generates a new timestamp). HTTP 207 is parsed and every
  event ID must be in `successes`, with no errors. Delivery acknowledgment is not independent proof
  of eventual ClickHouse ingestion or dashboard display.

Mem0 core is Apache-2.0; WeKnora's own code and Langfuse core are MIT. Bundled third-party components
and Langfuse EE features have separate terms. Follow their source licenses and notices rather than
assuming every deployed component is MIT. Vendor self-hosting is operational infrastructure:
WeKnora's documented starting point is roughly 4 CPU/8 GiB RAM; Langfuse's documented Compose
starting VM is roughly 4 CPU/16 GiB RAM and 100 GiB storage, not a capacity guarantee. Databases,
Redis, object storage, backups, TLS, retention and model costs need separate planning. None is deployed
or assigned a public port by this change.

## Memory lifecycle and failure behavior

`POST /api/v1/ai/customer-memory` requires manager role, a support-write guard, `contact_id`,
`request_key`, one permitted category, `body`, and `confirmed: true`. The contact must currently
belong to the authenticated organization and be neither anonymized nor merged. The SQL fact and its
outbox item commit atomically; same-key/same-content retries reuse the fact, and key/content collisions
fail. An ambiguous COMMIT acknowledgment returns an unconfirmed-outcome response: reuse the same key.

`crm_get_contact` and `crm_get_conversation_history` consume approved memory. Conversation checkpoints
retain their existing conversation/service/demand boundary and are not replaced. Mem0 can rank only
IDs in the CRM-owned map; model context uses the **current SQL fact**, never untrusted remote text.
Remote failure falls back to the same confirmed local facts; contact privacy is checked again after
retrieval. Disabling the provider stops external retrieval; ordinary checkpoint behavior continues.

The sync worker first reconciles the exact receipt using both opaque customer and receipt scopes.
A timed-out or crashed ADD is never blindly repeated. `sending`/`unknown` outcomes stay explicitly
unresolved. The contact panel and integration settings (including hard-deleted contacts) expose a
manager-only settlement action: only after checking that the original Mem0 request has actually
finished does the manager check the confirmation and request reconciliation. It re-lists the exact
receipt, rejects duplicate matches, and **never issues ADD**. There is a one-minute local safety
window before this action is accepted. A settled missing record is not silently recreated.

DELETE/anonymization/merge immediately clears the local body and tombstones the memory. Physical
contact deletion retains a content-free cleanup receipt with an opaque subject key. Remote deletion
is verified by a subsequent scoped read. An empty result cannot clear an unresolved earlier ADD:
it might still commit later. Organization deletion is blocked while such external cleanup remains
unverified. The canonical LGPD collector/PDF includes current approved customer facts. Operator
retention of Mem0 history, vector backups and exported copies remains a separate requirement;
verified removal from current retrieval is not a claim of complete backup erasure.

## Wiki authorization and provenance

An administrator connects an entire configured KB from the provider screen. It becomes a regular
`ai_knowledge_sources` Wiki source; select it in the Agent's corpus and publish the Agent version.
The source represents **one whole organization-visible KB**. Never put mixed-ACL documents in that
KB: filtering citations after synthesis cannot remove already-leaked prose. Both the server binding
and current published corpus must authorize it. No model-provided KB/tenant ID is trusted.

`crm_search_knowledge` calls actual Wiki search and page read. It verifies every source document's KB,
active/parsed status and update time, checks for concurrent source changes and rejects a derived
page older than any source. Draft/archived/deleted pages and invalid/missing provenance are omitted.
Local pgvector remains available for local sources; raw retrieval scores are not compared across
engines. External-only Wiki sources do not require a redundant local embedding call.

The append-only CRM receipt stores the observed **Wiki page content**, its version/content hash,
source-document IDs/update timestamps/file hashes when available, and chunk-reference IDs. This is
an immutable observed-page/provenance manifest, **not** a snapshot of every original source document
or a claim-by-claim citation proof. Human evidence links and saved Workbench evidence revalidate the
current page and sources, hiding withdrawn or superseded material rather than replaying stale
transcript excerpts. Search has a shared 15-second deadline; saved evidence has a shared 8-second
HTTP deadline, at most ten receipts and two concurrent receipt checks. Failure omits unverifiable
Wiki evidence. SQL manifest persistence remains locally bounded.

## Trace/Eval delivery and privacy

Pi's actual `streamFn` and executed tool functions produce generation/tool observations with timing,
status, model/provider identity, usage and counts. The gateway links one attempt span to its SQL run,
and specialist runs to the parent trace. Retries/resumes get new attempt IDs; outbox retries retain
observation IDs and timestamps. SQL lifecycle reconciliation covers transaction-owned endings too.
Prompts, outputs, CRM message bodies, tool arguments/results, hidden reasoning/private continuation,
credentials, arbitrary exception text and personal actor IDs are never added to the trace payload.
Organization/run correlation is pseudonymous. Per-org project keys are authorization; metadata is not.

GET Eval stays read-only and reloads an existing semantic report only when the profile, rubric,
model identity and material fingerprint still match. It never invokes the model. The UI keeps
the deterministic gates separate from the recorded Judge score. Workbench's “保存并投递确定性 Eval” explicitly persists and queues deterministic
scores without invoking a model; explicit semantic Eval uses the existing judge and also mirrors the
canonical report. Cached semantic reports can safely requeue a missing projection. Fingerprint,
profile revision and rubric revision accompany scores. No judge is silently added by the exporter.

The existing event bus supplies durability, but external services use the separate
`ai-integration-drain` cron lane (one queued item and two lifecycle reconciliations per minute).
They cannot consume the business event-drain batch. Failed attempts follow existing bounded retries
and Central alerts. Paused providers keep queued items pending. No remote network call occurs in a
PostgreSQL trigger. Observer exceptions and hung observers cannot fail or indefinitely hold a CRM run.

### Langfuse retention/deletion boundary

This increment exports sanitized telemetry; it does **not** implement a Langfuse erasure coordinator.
Before deleting server-side traces, pause the integration and deal with queued/dead export rows so
a later replay does not recreate them. Use Langfuse's supported trace deletion operation and verify
the result in its current observations API/UI. Dataset copies, exports, raw ingestion/blob storage,
versioned blobs and backups need their own retention/erasure procedure. Langfuse trace deletion is
asynchronous; an accepted deletion is not verified erasure. Do not enable production data until the
operator has established and tested this lifecycle. Automatic retention/RBAC features may require EE.
See [Langfuse deletion](https://langfuse.com/docs/administration/data-deletion) and
[retention](https://langfuse.com/docs/administration/data-retention).

## Living System Checklist

1. Inputs: trusted org binding, administrator activation, manager-confirmed customer facts, published
   Agent knowledge-source selection, real Pi model/tool execution and canonical Eval reports
2. Consumers: contact/history tools, knowledge tool, Workbench evidence UI, LGPD export and Langfuse
3. Records: memory/evidence tables, audit events, canonical run events and durable `event_log`
4. Surfaces: provider settings/readiness/cleanup, contact memory panel, Workbench citations and Eval
5. Entrances: existing Provedores, Contatos and Workbench navigation; no hidden new page
6. Recovery: bounded isolated delivery, existing retry/dead alerts, explicit unknown-write reconciliation
7. Configuration: default-off validated environment binding plus revisioned organization switch
8. Human↔AI continuity: human confirms facts/corpus; agent consumes evidence and still uses Mission approvals
9. Return loop: failed retrieval omits unverifiable evidence, tombstones prevent reuse, operators resolve
   ambiguous writes without duplicate ADD, existing Eval remains authoritative
10. Map: `docs/architecture/agent-services.architecture.json`

Verification and unmeasured stages are recorded in `docs/testing/agent-services-2026-10-02.md`.

## 2026-10-03：本地记忆与独立覆盖校验

CRM SQL 中的人工确认记忆不依赖 Mem0 开关。`crm_get_contact` 与会话历史均显式返回
`confirmed_customer_memory`：本地来源、provider 状态、complete / partial / unavailable 覆盖、
返回条数和读取上限。Mem0 只对属于本组织且内容哈希一致的本地 ID 排序，不能成为事实源。
每次读取前后重新检查联系人隐私资格；删除或匿名化后的事实不得从历史恢复。

Eval profile revision 8、semantic rubric revision 2 增加独立 SQL 存在性校验。
只核对本次成功 `crm_get_contact` 观察中的联系人，按组织和当前隐私资格限定，选择运行开始时
已存在且在整个运行期间未删除的记忆 ID（不读取正文）。运行之后新增的数据不用于历史判错。
没有配置第三方服务与“没有 CRM 记忆”是两件事；遗漏已存在事实进入 fail，不完整读取进入
needs_review。覆盖匹配仍不能证明任意自然语言声明正确，也不是业务验收。

闭环交付：人工保存 → SQL 权威事实 → 联系人/会话工具 → Pi observation → SQL 存在性校验
→ 确定性 Eval → 显式真实 Judge → 保存/只读回放。恢复路径是读取 unavailable 明示、界面重试、
旧 rubric 缓存不复用，不新增后台自动 Judge。证据导出仅允许本机固定合成演示；白名单保留计量、
事件和脱敏工具摘要，不导出系统 Prompt、隐藏推理、凭据或原始客户正文。

演示入口：`examples/chat-first-demo/dist/index.html` 的“真实模型录制”；查看历史录制不调用模型。
真实运行和测试证据见 `docs/testing/agent-services-real-run-2026-10-03.md`。
