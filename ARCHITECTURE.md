# 架构 — Pi Native CRM

> 一页纸的全局视图。深度内容在 `docs/specs/` 和 `docs/stories/epics/MASTER.md`。
> 全部文档索引：[`docs/index.md`](docs/index.md)。
> 真实实现状态（哪些完成、哪些没完成）：[`docs/current-state.md`](docs/current-state.md)。

## 分层

- **App（Next.js 16 App Router）**：UI 和 Route Handlers 在同一个仓库。默认 Server Components，需要客户端状态时才用 Client。边缘中间件在 `proxy.ts`（Next 16 把 `middleware.ts` 改名成了 `proxy.ts`）。
- **DB（Supabase Postgres）**：所有租户相关表都通过 `fn_user_org_ids()` 启用 RLS。Migration 版本化在 `supabase/migrations/`。
- **Auth（Supabase Auth + `@supabase/ssr`）**：Cookie 为 `SameSite=Strict`。服务端永远用 `getUser()`，绝不用 `getSession()`。**MFA TOTP 是可选的，由管理员决定是否开启** —— 两条独立策略相加（`platform_admins.mfa_required` 和 `organizations.settings.security.mfa_required`），默认都是**不要求**；纯规则在 `lib/auth/politica-mfa.ts`。这一行曾写着"对 admin/super-admin 强制"，那是旧规则：因为 `install.sh` 把所有者创建为 platform admin，每次自托管安装都会在 onboarding 之后立刻被一个全屏拦截器挡住。**注册**和**验证**是两件事 —— 已经拥有因子的用户，在会话中**始终**需要验证，与策略无关。
- **Realtime（Supabase Realtime）**：`postgres_changes` 用于 inbox/kanban；`broadcast` 用于轻量信号。
- **Storage（Supabase Storage）**：私有 bucket `whatsapp-media`，使用签名 URL。
- **WhatsApp（WAHA Plus / NOWEB 引擎）**：HMAC-SHA512 webhook；防封限流；STOP 检测。
- **队列（轻量事件溯源）**：`event_log` 表 + 通过 cron 运行的 worker。Postgres 触发器**绝不**发 HTTP 请求。
- **限流（Upstash Redis）**：`lib/ai/dispatcher/rate-limit.ts` 里的**固定窗口**计数器（`INCR` + `EXPIRE`），Redis 不可用时回落到内存。⚠️ 目前只用于 **2 个点**（获客 webhook 和 AI dispatcher）—— 公开的 auth 接口还没有。见 [`docs/threat-model.md`](docs/threat-model.md) §T1。
- **AI / Agent**：Pi Agent Core 是 agent 循环的规范内核；CRM 的 Model Gateway 负责 provider、凭据、binding、预算、计价、用量和审计。Vercel AI SDK 只保留在 embeddings 和非 agent 的辅助调用里。
- **可观测性（Sentry）**：`beforeSend` 清洗 PII（CPF/邮箱/手机号）和敏感 header。

## 多租户

所有租户相关表都有 `organization_id uuid not null`。RLS 通过 helper 实现。Service role **绕过 RLS** —— 使用 admin client 的 handler **必须**手动过滤 `organization_id`，且只能来自可信来源（cookie/JWT/webhook secret/path token），**绝不能**来自请求体。

细节：[`docs/specs/01-spec-platform-base.md`](docs/specs/01-spec-platform-base.md)。

## REST API `/api/v1/`

- JSON snake_case。UUID v4。ISO-8601 UTC。金额用 `_cents` + `currency`。
- 包装器 `ok()` / `fail()` 在 `lib/api/wrappers.ts`。
- 双认证：Cookie 会话（前端）或 `Authorization: Bearer dsk_...`（服务端到服务端）。
- 每个响应都带 `X-Request-Id`，在 `proxy.ts` 中注入并与审计日志关联。
- `Idempotency-Key` 是创建型 POST 的约定；两条路由落回执（`lgpd/requests/[id]/approve` 和 `admin/tenants`），并提供可复用 helper `lib/api/idempotency.ts`，已用于 `message-templates`。其余创建路由**尚未**覆盖，也没有关闭相同 key 并发请求之间的竞态（需要改 schema —— issue #778）。要测量而不是引用：`grep -rln 'Idempotency-Key' app/api/v1 --include='route.ts'`。
- 细节：[`docs/specs/01-spec-platform-base.md`](docs/specs/01-spec-platform-base.md) §API。

## 一次请求的路径

**租户认证路由**（`/api/v1/*`，166 个 handler）：

```
request → proxy.ts（X-Request-Id、x-pathname；isPublicPath? → 直接放行；
                    否则通过兼容 cookie sb-pi-native-auth 校验 Supabase 会话）
        → route handler：
             1. Zod 校验外部输入
             2. guard：requireRole() | requirePlatformAdmin() | secret/HMAC
             3. resolveActiveOrg() → 从可信来源取 organization_id（绝不用 body）
             4. 查询（会话 client 走 RLS，或 service role 手动按 org 过滤）
             5. 有变更则 audit() fire-and-forget
             6. ok(data, meta) | fail(code, message, status)
```

**非 Cookie 接口**：`/api/v1/cron/*`（Bearer `INTERNAL_CRON_SECRET`，fail-closed）、
`/api/internal/*`（`x-internal-secret`）、`/api/mcp`（Bearer `dsk_...` 对 `api_tokens`）、
`/api/v1/webhooks/*`（HMAC + path token）。完整清单在
[`docs/threat-model.md`](docs/threat-model.md) §1。

**AI Agent 回合**：WhatsApp 入站 → HMAC + 幂等 → `event_log` →
worker → `runAgentTurn`（RAG + MCP tools）→ 发送前 guardrails → WAHA 适配器 →
满足条件时转人工。图：[`docs/architecture/agent-turn.html`](docs/architecture/agent-turn.html)。

## Event log + workers

Postgres 触发器向 `event_log` 写入行。Workers（cron / Realtime listener）消费并触发副作用。幂等通过 `unique (organization_id, external_id)` + 捕获 `code === '23505'`。

Workers 在 `workers/`（`ai-response`、`ai-sentiment`、`rag-indexer`、`media-persist`、
`media-derive`、`lgpd-export`、`lgpd-redact`、`storage-cleanup`、`agent-worker`），由
`app/api/v1/cron/` 的 10 个端点驱动。契约：[`docs/specs/07-spec-events-workers.md`](docs/specs/07-spec-events-workers.md)。

## 外部集成

| 服务 | 用途 | 位置 | 缺失时 ⇒ |
|---|---|---|---|
| **Supabase** | Postgres + Auth + Realtime + Storage | `lib/supabase/{browser,server,admin}.ts` | 应用起不来（始终必填） |
| **WAHA Plus**（NOWEB） | WhatsApp：收发、多号码会话 | `lib/waha/` | 渠道不可用；生产必填 |
| **Upstash Redis** | 限流 + RAG 防抖 | `lib/ai/dispatcher/rate-limit.ts`、`lib/ai/rag/debounce.ts` | 带 `warn` 降级到内存 |
| **Pi Agent Core + Model Gateway** | agent 循环、tools、provider 治理与用量 | `lib/agent-runtime/`、`lib/agent-engine/edge/llm/` | Agent 不响应 |
| **Vercel AI SDK** | embeddings 和非 agent 辅助调用 | `lib/ai/`、辅助 workers | 辅助能力不可用 |
| **Nuvemshop** | 电商：订单、商品、LGPD webhook | `lib/nuvemshop/` | 可选（`NUVEMSHOP_ENABLED`） |
| **Sentry** | 错误 + 性能，`beforeSend` 清洗 PII | `sentry.*.config.ts`、`instrumentation*.ts` | 可选 |
| **Resend** | 事务邮件（团队邀请） | `lib/email/` | 可选 —— 邀请降级为复制链接 |
| **MCP** | 把 CRM 暴露为 Agent 可调用的 tools | `app/api/mcp/`、`lib/mcp/` | — |

## 加固

- Error boundaries 在 `app/error.tsx`、`app/app/error.tsx`、`app/(public)/error.tsx`、`app/global-error.tsx`（Sentry 捕获 + 可见 eventId）。
- 自定义 404/403/500/503 页面，使用规范葡语文案。
- P0 路由有 loading skeleton。
- Playwright E2E + axe-core。
- 细节：[`docs/stories/epics/EPIC-12-hardening.md`](docs/stories/epics/EPIC-12-hardening.md)。

## 深入阅读

- [`docs/prd/`](docs/prd/) — PRD（愿景、MVP 范围、KPI、平台基础、Customer 360、WhatsApp、Pipeline、AI-RAG、Nuvemshop）。
- [`docs/specs/`](docs/specs/) — 技术规格，含 SQL schema 和 payload。
- [`docs/business-rules/`](docs/business-rules/) — 代码之外的业务规则。
- [`docs/stories/epics/MASTER.md`](docs/stories/epics/MASTER.md) — 按 epic/wave 的执行计划。
- [`CLAUDE.md`](CLAUDE.md) — 不可协商的约定（多租户、幂等、RBAC、LGPD、WAHA、反模式）。
- [`AGENTS.md`](AGENTS.md) — 面向代码 Agent 的可移植契约（任何工具）。
- [`docs/index.md`](docs/index.md) — 全部文档索引。
- [`docs/harness-audit.md`](docs/harness-audit.md) — harness 成熟度与验证缺口。
- [`docs/threat-model.md`](docs/threat-model.md) — 自托管攻击面。
