# 配置指南 — pi-native-crm

> **这份文档给谁看？** 你刚克隆完仓库，把 `.env.example` 复制成 `.env.local`，打开文件，然后崩溃了：
> "这些键都是什么？去哪拿？"这份指南解决这个问题。不跳步骤，不假设你之前配过任何东西。
>
> **预计时间：** 从零填完 60–90 分钟。可以分几次做 —— 有些键留空应用也能起来（见[推荐顺序](#推荐顺序)）。
>
> **成本：** 开发环境 R$ 0。列出的服务都有慷慨的免费额度。标 💳 的地方是平台要求绑卡（即使是免费套餐）来验证身份。

---

## 目录

1. [开始之前](#开始之前)
2. [推荐顺序](#推荐顺序)
3. [Supabase —— 数据库 + 认证 + 存储](#1-supabase--数据库--认证--存储)
4. [Upstash Redis —— 限流 + 幂等](#2-upstash-redis--限流--幂等)
5. [WAHA —— WhatsApp](#3-waha--whatsapp)
6. [Pi Agent Runtime 的 AI Provider](#4-pi-agent-runtime-的-ai-provider)
7. [OpenAI —— RAG embeddings](#5-openai--rag-embeddings)
8. [Sentry —— 错误监控](#6-sentry--错误监控)
9. [事务邮件 —— SMTP 或 Resend](#7-事务邮件--smtp-或-resend)
10. [Nuvemshop —— 电商集成](#8-nuvemshop--电商集成)
11. [本地生成的密钥](#9-本地生成的密钥--加密--secret)
12. [最终验证](#最终验证)
13. [故障排查](#故障排查)
14. [下一步](#下一步)

---

## 开始之前

**需要装好：**
- **Node.js 22** —— 推荐用 [nvm](https://github.com/nvm-sh/nvm)。在仓库里跑 `nvm use` 会切到正确版本。`pnpm test:db` 套件要求 Node 22+：测试会实例化 Supabase 客户端，它需要全局 `WebSocket`（22 起才有原生支持）。
- **Docker Desktop** —— 用来跑本地 WAHA。[下载](https://www.docker.com/products/docker-desktop/)。
- **pnpm** —— `npm install -g pnpm`（我们用的包管理器）。
- **Git** —— 你克隆了仓库就有。
- **主邮箱账号** —— 用来注册各种 SaaS。
- **信用卡** 💳 —— 有些服务即使免费套餐也要"验证身份"（Supabase、Sentry）。只要不超免费额度，**不会扣费**。

**`.env.local` 怎么用：**
- 放在**项目根目录**：`/你的路径/pi-native-crm/.env.local`。
- 每行是 `变量名=值` —— `=` 前后不要有空格。
- 含特殊字符的字符串：用双引号包起来（`"带空格的值"`）。
- 名字带 `NEXT_PUBLIC_` 的变量**会暴露到浏览器** —— 绝不要放 secret 在那里。
- 其余只在服务端。

**黄金法则：** 永远不要提交 `.env.local`。它已经在 `.gitignore` 里，但推送前用 `git status` 再确认一次。

---

## 推荐顺序

想用最小可行配置尽快把应用跑起来：

**🟢 `pnpm dev` 无致命错误启动的最小集（约 15 分钟）：**
1. [Supabase](#1-supabase--数据库--认证--存储) —— 没有它什么都跑不了（认证 + 数据库）。
2. [本地生成的密钥](#9-本地生成的密钥--加密--secret) —— `INTERNAL_SECRET`、加密密钥。
3. [Upstash Redis](#2-upstash-redis--限流--幂等) —— 限流是多条路由的前置条件。

**🟡 要测 AI 功能（+10 分钟）：**
4. 给 Pi Agent Runtime 配一个 provider（直连 Anthropic、OpenAI、Google、
   OpenRouter、DeepSeek 或兼容端点）。
5. [OpenAI](#5-openai--rag-embeddings) —— RAG 的 embeddings。

**🟡 要测 WhatsApp（+15 分钟）：**
6. [WAHA](#3-waha--whatsapp) + ngrok（需要公网 URL）。

**⚪ 开发环境可以留空（会优雅降级）：**
- [Sentry](#6-sentry--错误监控) —— 不监控错误，但应用能起来。
- [邮件](#7-事务邮件--smtp-或-resend) —— 不配 SMTP 也不配 Resend 时，邀请会变成屏幕上的链接，LGPD 导出会停在待审核；应用照常启动。
- [Nuvemshop](#8-nuvemshop--电商集成) —— 界面显示"集成未配置"。

---

## 1. Supabase —— 数据库 + 认证 + 存储

**是什么：** Backend-as-a-service。你的 Postgres、认证、媒体存储和 realtime 都在这里。没有它什么都跑不了。**免费额度：** 500MB 数据库 + 1GB 存储 + 5 万 MAU。开发原型够用。

### 步骤

1. 打开 <https://supabase.com> → **Start your project** → 用 GitHub 登录。
2. 在 dashboard 点 **New project**。
   - **Name：** `pi-native-dev`（或任意）。
   - **Database password：** 点骰子图标生成。**存进密码管理器（1Password、Bitwarden）** —— 跑 migration 时要用，而且之后在 dashboard 里再也看不到它。
   - **Region：** `South America (São Paulo)` —— 对巴西延迟最低。
   - **Pricing plan：** Free。
3. 点 **Create new project**。等大约 2 分钟。
4. 加载完，进 **Project Settings**（侧边栏齿轮）→ **API**。

### 三个密钥在哪拿

在 **Project Settings → API** 页面：

| Supabase 里的字段 | `.env.local` 里的变量 | 说明 |
|---|---|---|
| **Project URL**（如 `https://abc123.supabase.co`） | `NEXT_PUBLIC_SUPABASE_URL` | 公开 URL，可以进浏览器 |
| **Project API keys → `anon` `public`** | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 公开密钥。数据由 RLS 保护 |
| **Project API keys → `service_role` `secret`** | `SUPABASE_SERVICE_ROLE_KEY` | **关键**。绕过 RLS。绝不暴露，绝不提交。 |

> ⚠️ **安全警告：** `service_role` 相当于数据库的 root 密码。一旦泄露，任何人都能读写一切。生产环境请做季度轮换。

### 跑 migration

填好上面三个变量之后：

```bash
# 安装 Supabase CLI
brew install supabase/tap/supabase   # macOS
# Windows/Linux 见 https://supabase.com/docs/guides/cli/getting-started

# 登录（会打开浏览器）
supabase login

# 连接你的项目（project-ref 在 dashboard 的 URL 里）
supabase link --project-ref <你的 project-ref>

# 在全新的 Supabase 项目里，先启用 schema 用到的扩展 ——
# 否则 baseline 会停在 `type public.vector does not exist`。
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c \
  'create extension if not exists vector with schema public;
   create extension if not exists citext with schema public;
   create extension if not exists pg_trgm with schema public;'

# 应用 SCHEMA —— 用 baseline，不要用 migration 链。
# 脚本也会启用扩展，并从 .env.local/.env 读取 SUPABASE_DB_URL。
pnpm db:migrate
```

> ⚠️ **新建数据库时不要用 `supabase db push`。** `0001`–`0009` 和 `0013` 这些 migration
> 是 `SELECT 1;` 的占位符 —— 基础 schema 不在里面，整条链从零跑不起来。`db push`
> **会不报错地通过**，给你留下一个空数据库，而你很久以后才会在一个完全不指向这里的报错里
> 发现。`supabase/baseline.sql` 才是真实 schema，也正是 `hostgator-setup-kit/install.sh`
> 在 VPS 上应用的东西。
>
> Migration 仍然是**已有**数据库升级时的真相来源 —— baseline 用于从零创建。

如果 CLI 用不了，在 dashboard 打开 **SQL Editor → New query**，粘贴
`supabase/baseline.sql` 的内容。

### 存储 bucket

侧边栏 → **Storage** → **New bucket**：
- **Name：** `whatsapp-media`
- **Public bucket：** **不要选**（留空 —— 我们用签名 URL）

---

## 2. Upstash Redis —— 限流 + 幂等

**是什么：** Serverless Redis。用于 API 限流和幂等键缓存。**免费额度：** 每天 1 万条命令、256MB。开发足够。

### 步骤

1. 打开 <https://upstash.com> → 用 GitHub **Sign up**。
2. Dashboard 点 **Create Database**。
   - **Name：** `pi-native-dev`
   - **Type：** Regional（开发比 Global 便宜）
   - **Region：** `sa-east-1`（圣保罗）—— 免费套餐没有 SP 就用 `us-east-1`。
   - **Eviction：** 启用（默认）。
3. 点 **Create**。
4. 在数据库页面滚到 **REST API** 区域，你会看到：

| Upstash 里的字段 | `.env.local` 里的变量 |
|---|---|
| **UPSTASH_REDIS_REST_URL**（复制按钮） | `UPSTASH_REDIS_REST_URL` |
| **UPSTASH_REDIS_REST_TOKEN**（点小眼睛显示） | `UPSTASH_REDIS_REST_TOKEN` |

> 💡 Upstash 提供多种格式的现成片段。用 **`.env`** 标签，它已经排好格式 —— 直接粘贴。

---

## 3. WAHA —— WhatsApp

**是什么：** 连接 WhatsApp 并暴露 HTTP API 的服务器。固定默认值 `devlikeapro/waha:latest-2026.7.2`，NOWEB 引擎。这个版本的本地验证创建了两个 CORE 会话直到 `SCAN_QR_CODE`；没有验证 pairing 或真实发送。版本/引擎和操作后置条件决定兼容性；单看 tier 不会阻止第二个号码。

### 第 1 步 —— 生成 API key（明文 + 哈希）

WAHA 有一套特殊的认证方式：**容器**保存密钥的 SHA512 哈希；**应用**每次请求发送明文。所以两样都需要。

```bash
# 1. 生成强随机字符串（终端里）
openssl rand -hex 32
# → 类似：7a3f9b2c1d4e5f...
```

这是**明文**。复制它。现在生成它的 **SHA512 hex 哈希**：

```bash
# 2. 明文的哈希
echo -n "7a3f9b2c1d4e5f..." | shasum -a 512 | awk '{print $1}'
# → 类似（很长，约 128 字符）：9f8e7d6c...
```

> ⚠️ **克隆项目的人最容易犯的错：** 把明文和哈希搞混。记住：
> - **WAHA 容器**收到的是**哈希** → 写进 `WAHA_API_KEY_SHA512`。
> - **Next.js 应用**在 `X-Api-Key` header 里发送**明文** → 写进 `WAHA_API_KEY`。
>
> ⚠️ 另外：容器里的值需要 `sha512:` 前缀。见下方第 3 步。

### 第 2 步 —— 生成 webhook 的 HMAC secret

WAHA 用 HMAC SHA512 给每个 webhook 签名。我们再生成一个 secret：

```bash
openssl rand -hex 32
# → 粘贴到 WAHA_HMAC_SECRET
```

### 第 3 步 —— 填写 .env.local

```env
# Next 应用在 X-Api-Key header 里发送的明文
WAHA_API_KEY=<第 1 步的明文>

# 上面明文的 SHA512 哈希 —— docker-compose 用它配置容器
WAHA_API_KEY_SHA512=<第 1 步的哈希>

# webhook HMAC
WAHA_HMAC_SECRET=<第 2 步的明文>

# WAHA 跑在 localhost:3030（docker-compose 映射，host:3030 → container:3000）
WAHA_API_BASE_URL=http://localhost:3030

# WAHA 回调的公开 URL —— 第 4 步填写
WAHA_WEBHOOK_BASE_URL=
```

> ⚠️ **`docker-compose.yml` 会给哈希加上 `sha512:` 前缀。** 如果你手动起容器，
> 要自己写成 `sha512:<哈希>` —— 否则 WAHA 会把 `X-Api-Key` 字面比较，应用收到
> **401**。（issue #6 / PR #7 修的就是开发 compose 漏了前缀。）

### 第 4 步 —— webhook 的公网 URL（ngrok）

消息进来时，WAHA 需要回调我们的应用。localhost 不行 —— 需要公网 HTTPS URL。

```bash
# 安装 ngrok
brew install ngrok

# 在 https://ngrok.com 注册免费账号并拿到 authtoken
ngrok config add-authtoken <你的 token>

# 在另一个终端暴露 3000 端口（Next.js 跑的地方）
ngrok http 3000
```

ngrok 会显示：`Forwarding https://abc-123-456.ngrok-free.app -> http://localhost:3000`。

复制那个 `https://...` URL 并粘贴到：

```env
WAHA_WEBHOOK_BASE_URL=https://abc-123-456.ngrok-free.app
```

> ⚠️ 免费套餐下，ngrok URL 每次重启都会变。如果你要大量用 WAHA，每月 $8 买固定子域名，
> 或者用 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)（自有域名免费）。

### 第 5 步 —— 启动 WAHA

```bash
docker compose up -d
```

在 <http://localhost:3030/dashboard/> 确认 WAHA 在响应（WAHA 面板）。创建会话和扫码见官方文档：<https://waha.devlikeapro.com/docs/overview/quick-start/>。

---

## 4. Pi Agent Runtime 的 AI Provider

**是什么：** Pi Agent Core 执行对话循环。CRM 的 Model Gateway 负责 provider、凭据、binding、
预算、计价、用量和审计；你可以用直连 provider、OpenRouter、DeepSeek、OpenAI 兼容端点，
或可选的 Vercel AI Gateway 作为目标。
**成本：** 按量付费。Anthropic 注册送 $5。

### 方案 A —— Vercel AI Gateway 作为可选端点

1. 打开 <https://vercel.com> → 登录。
2. Dashboard → 侧边栏 **AI** → **Get started with AI Gateway**。
3. 点 **Create API Key** → 名字 `pi-native-dev` → 复制密钥。

```env
AI_GATEWAY_API_KEY=<gateway 的密钥>
AI_GATEWAY_BASE_URL=https://ai-gateway.vercel.sh/v1
VERCEL_AI_GATEWAY_URL=https://ai-gateway.vercel.sh/v1
```

> 💡 CRM 的 Model Gateway 把这个端点作为 OpenAI 兼容 provider 交给 Pi 适配器。
> 循环仍由 Pi Agent Core 执行；端点只提供模型，以及按 gateway 配置时的外部路由。

### 方案 B —— 直连 Anthropic（回退方案或偏好）

1. 打开 <https://console.anthropic.com> → **Sign Up**。💳
2. 添加支付方式（送 $5 额度）。
3. **Settings → API Keys → Create Key** → 名字 `pi-native-dev` → 复制。

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```

> ⚠️ 没有任何有效凭据时，`ai-response-worker` 会以
> `skip="ai_gateway_key_missing"` 跳过 —— 应用正常启动，只是不用 AI 回复。开发没问题；
> 生产环境至少配一个 provider 凭据。

---

## 5. OpenAI —— RAG embeddings

**是什么：** 为租户知识库生成 embeddings（向量），供 RAG 聊天机器人和 agent provider 使用。
**成本：** embeddings 很便宜；`text-embedding-3-small` = $0.02 / 1M tokens。

1. 打开 <https://platform.openai.com> → **Sign up**。💳
2. 添加支付方式（新账号不再送额度）。
3. **API Keys → Create new secret key** → 名字 `pi-native-dev-embeddings` → 复制。

```env
OPENAI_API_KEY=sk-proj-...
```

---

## 6. Sentry —— 错误监控

**是什么：** 捕获错误、堆栈跟踪和性能。没有它，你只能等客户投诉才知道应用坏了。**免费额度：** 每月 5000 错误、1 万 performance units。

1. 打开 <https://sentry.io> → 用 GitHub **Sign up**。💳
2. 创建工作区（或用个人的）→ **Create Project**。
   - **Platform：** `Next.js`
   - **Alert frequency：** "Alert me on every new issue"
   - **Project name：** `pi-native-dev`
3. 创建后，Sentry 会在 quickstart 页面显示 **DSN**。形如 `https://abc123@o456.ingest.sentry.io/789`。
4. 如果关掉了页面：**Project Settings → Client Keys (DSN)** → 复制公开 DSN。

```env
SENTRY_DSN=https://abc123@o456.ingest.sentry.io/789
```

> 💡 DSN 被认为"足够公开" —— 可以进客户端。但默认仍作为服务端变量保留（已经在 `.env.local` 里）。

---

## 7. 事务邮件 —— SMTP **或** Resend

**是什么：** 团队邀请、LGPD 导出、SLA 告警等的发送通道。有**两条**，并存：你选一条，
不需要两条，而且**两条都不是应用启动的必需项**。

| | **SMTP**（自己的服务器） | **Resend**（外部服务） |
|---|---|---|
| 何时选 | 你已有邮件服务器，或不想再开一个账号 | 想快速上线，不想碰邮件服务器 |
| 在哪配 | **Admin › 邮件**页面，或 `.env` 的 `SMTP_*` | `.env` 的两个 `RESEND_*` 键 |
| 成本 | 你自己服务器的 | 免费额度 每月 3000 封、每天 100 封 |

**系统怎么选：** 如果配置了 SMTP（服务器地址**和**发件人），就走 SMTP；没有就走 Resend。
判断依据是配置，不是失败 —— 系统不会先试一个再落到另一个，避免同一封邀请发两次。
已经用 Resend 的人**不需要改任何东西**：SMTP 留空时一切照旧。规则在
`lib/email/roteador.ts`。

**两条都不配**时应用照常启动：邀请会在页面直接显示接受链接（你自己复制转发），
LGPD 导出会停在待审核，而不是消失。

---

### 7a. SMTP —— 用自己的服务器

通过界面（推荐路径）：进入 **Admin › 邮件**（你必须是安装所有者），填字段，用
**测试连接**，保存。密码加密存储，界面不会再显示。

通过 `.env`（不开界面直接给 VPS 配置）：

```env
SMTP_HOST=smtp.seudominio.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_USERNAME=nao-responda@seudominio.com
SMTP_PASSWORD=...
SMTP_FROM_EMAIL=nao-responda@seudominio.com
SMTP_FROM_NAME=Minha Empresa
```

> 💡 端口 **587** 配 `starttls`，或 **465** 配 `tls`。`SMTP_HOST` 只填地址：前面不要
> `smtp://`，后面不要 `:端口`。
>
> ℹ️ 界面上保存的值**优先于** `.env`。环境变量作为回滚底线和自动化安装路径。

---

### 7b. Resend —— 用外部服务

**是什么：** 邮件发送服务。用于 magic link、密码重置、LGPD 导出、通知。
**免费额度：** 每月 3000 封、每天 100 封。开发 MVP 够用。

1. 打开 <https://resend.com> → 用 GitHub **Sign up**。
2. **API Keys → Create API Key**：
   - **Name：** `pi-native-dev`
   - **Permission：** `Sending access`（不是 `Full access`）。
   - **Domain：** `All domains`（开发时）—— 生产环境限制到已验证域名。
3. 复制密钥（以 `re_...` 开头）。**它只显示一次。**

```env
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=onboarding@resend.dev
```

> 💡 `onboarding@resend.dev` 是共享域名，免费套餐可用于测试。生产环境请**验证自己的域名**
> （SPF + DKIM DNS 记录），并用 `noreply@seudominio.com`。
>
> ℹ️ 不配 Resend 应用照常启动 —— 只是用 `console.log` 代替真实发送。适合不想消耗额度的开发。

---

## 8. Nuvemshop —— 电商集成

**是什么：** 巴西电商平台。我们的 OAuth 集成把订单、商品、客户导入 CRM。

> ℹ️ **开发时可以跳过。** 这些变量留空时，界面显示"集成未配置"，其余功能照常。

### 步骤

1. 打开 <https://partners.tiendanube.com/> → 注册为合作伙伴（免费）。
2. 伙伴 dashboard → **Apps → Create new app**。
   - **App name：** `pi-native-crm Dev`。
   - **Redirect URI：** `https://<你的 ngrok URL>/api/v1/integrations/nuvemshop/callback`（可以复用 WAHA 的 ngrok，或另开一个）。
   - **Scopes：** 勾选 `read_orders`、`read_customers`、`read_products`、`write_orders`（更新状态用）。
3. 创建后，应用页面显示：

| 门户里的字段 | `.env.local` 里的变量 |
|---|---|
| **App ID**（URL 里：`partners.tiendanube.com/apps/12345`） | `NUVEMSHOP_APP_ID`（= `12345`） |
| **Client ID** | `NUVEMSHOP_CLIENT_ID` |
| **Client Secret**（点击显示） | `NUVEMSHOP_CLIENT_SECRET` |

```env
NUVEMSHOP_APP_ID=12345
NUVEMSHOP_CLIENT_ID=...
NUVEMSHOP_CLIENT_SECRET=...
```

4. 同时配置应用的公开 URL：

```env
NEXT_PUBLIC_APP_URL=https://<你的 ngrok URL>.ngrok-free.app
```

OAuth 回调 URL 必须与门户里注册的 `Redirect URI` **完全一致** —— 包括 `https`，结尾不要斜杠。

---

## 9. 本地生成的密钥 —— 加密 + secret

这些由你**自己生成** —— 没有 dashboard，没有登录。它们是用于内部加密和应用 secret 的随机字符串。

```bash
# 跑 6 次，每次输出粘到不同变量
openssl rand -hex 32
```

分配到这些变量：

```env
# /api/v1/cron/* 端点的 Bearer secret（与 service role key 不同）
INTERNAL_SECRET=<输出 1>

# PII 加密（LGPD）
CPF_ENCRYPTION_KEY=<输出 2>

# Nuvemshop OAuth token 加密
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=<输出 3>

# BYO-WAHA 凭据加密（自己跑 WAHA 的客户）
WAHA_BYO_ENCRYPTION_KEY=<输出 4>

# impersonate cookie 的 HMAC（super-admin）—— 至少 32 字符
IMPERSONATE_COOKIE_SECRET=<输出 5>

# LGPD 导出 URL 签名
LGPD_SIGNING_KEY=<输出 6>
```

> ⚠️ **生产环境绝不重复使用**同一个字符串。每个加密的是不同东西 —— 泄露一个，我们希望爆炸半径有限。
>
> ⚠️ **生产有数据后绝不修改 `CPF_ENCRYPTION_KEY` 或 `NUVEMSHOP_OAUTH_ENCRYPTION_KEY`** —— 已保存的数据将无法解密。轮换这些密钥需要 re-encryption migration。

### 其他可选变量

```env
# 官方 DPO（LGPD）—— 作为 data request 邮件的 reply-to
LGPD_DPO_EMAIL=dpo@seudominio.com

# LGPD 导出链接有效期（默认 72h）
LGPD_EXPORT_EXPIRES_HOURS=72

# 规范 URL（开发一般是 localhost；生产指向域名）
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_ADMIN_URL=http://localhost:3000

# Workers —— worker 跑 event_log handler 的节奏。留空 = 默认
# （有活 2s，空闲 10s，每批 50）。已经没有 opt-in 了：之前这里的
# `EVENT_LOG_WORKER_ENABLED` 从来没有读取者，2026-08-25 随 worker
# 真正循环落地一起删掉了。
EVENT_LOG_DRAIN_INTERVAL_MS=2000
EVENT_LOG_DRAIN_IDLE_INTERVAL_MS=10000
EVENT_LOG_DRAIN_BATCH_SIZE=50
```

---

## 最终验证

全部填完后，验证：

```bash
# 1. 类型检查（会抱怨缺失的 env）
pnpm typecheck

# 2. 启动应用
pnpm dev

# 3. 另一个终端打健康检查
curl http://localhost:3000/api/v1/health
```

响应应该类似：

```json
{
  "data": {
    "supabase": { "status": "ok" },
    "redis": { "status": "ok" },
    "waha": { "status": "ok" }
  }
}
```

任何服务显示 `"degraded"` 或 `"down"`，就去 `pnpm dev` 的终端看错误 —— 通常是变量缺失或值写错。

---

## 故障排查

### 启动时 `Variáveis de ambiente inválidas`
Zod（`lib/env.ts`）在启动时校验。看它打印的错误列表 —— 会准确说出哪个变量缺失或格式不对。

### `Error: supabaseUrl is required`
你忘了填 `NEXT_PUBLIC_SUPABASE_URL`，或者多了空格/引号。确认该行正好是
`NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co`（没有引号，`=` 前没有空格）。

### 调 Supabase 时 `Invalid JWT`
`anon key` 或 `service role key` 粘错了（复制到一半）。Supabase 的 JWT 很长（约 200 字符）。
回 dashboard 用 **Copy** 按钮，不要手动选中。

### WAHA 返回 401 `Unauthorized`
可能原因：你把**哈希**放进了 `WAHA_API_KEY` 而不是**明文**。确认：应用发送 `.env.local`
里的值作为 header；WAHA 容器持有哈希（在 `WAHA_API_KEY_SHA512`）。重做 WAHA 第 1 步。
另外确认容器里的值带 `sha512:` 前缀。

### WAHA 的 webhook 收不到
- ngrok 在跑吗？（`ngrok http 3000`）
- 当前的 ngrok URL 写进 `WAHA_WEBHOOK_BASE_URL` 了吗？（免费套餐每次重启会变）
- 改完 `.env.local` 后重启 `pnpm dev` 了吗？环境变量在启动时读取。
- 看容器日志：`docker logs pi-native-waha`。

### 3000 端口被占用
有别进程在跑。用 `lsof -ti:3000 | xargs kill -9` 杀掉，或换端口跑 Next：
`pnpm dev -- -p 3001`（并更新 `WAHA_WEBHOOK_BASE_URL` 的 ngrok 指向新端口）。

### `RESEND_API_KEY is undefined`（但应用能起来）
开发环境正常，如果你**两条**邮件路径都没配（既没 SMTP 也没 Resend）。邮件会落到
`console.log`。只在要测邮件流程（LGPD 导出、magic link）时才需要配。

### Migration 跑不了
确认已登录：`supabase login` —— 会打开浏览器授权。然后重新 `supabase link --project-ref <ref>`。

### 忘了 Supabase 数据库密码
**Project Settings → Database → Reset database password**。注意这会让现有连接失效。

### Docker compose 起不来 WAHA
- Docker Desktop 在跑吗？看菜单栏图标。
- Mac M1/M2/M3 上，docker-compose 的 `platform: linux/amd64` 可能给 warning —— 正常，
  只是走模拟会慢一些。能用。

---

## 下一步

`/api/v1/health` 全绿之后：

1. 跑 `pnpm tsx scripts/seed-e2e-credentials.ts` 创建测试用户 —— 生成带 admin/manager/agent 的 `.e2e-creds.json`。
2. 读 [`README.md`](../README.md) 了解创建 WAHA 会话 + 扫码的流程。
3. 读 [`CLAUDE.md`](../CLAUDE.md) 了解项目约定。

欢迎使用 pi-native-crm。🛠️

---

> **发现这份指南有错？** 开一个 [issue](https://github.com/luckiest-draw/AiNativeCrm/issues) 或提 PR —— 这份文档靠社区贡献维护。
