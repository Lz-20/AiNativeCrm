# 贡献指南 — Pi Native CRM

## 开始之前

0. 用你的代码助手（Claude Code、Codex、Cursor、OpenCode 或 Antigravity）打开仓库，在提 PR 前先跑本地检查。要在任意目录安装辅助指南，执行 `bash scripts/instalar-guias.sh`；编辑指南时，用同一个安装器加 `--fonte .`，确保生效的是克隆里的副本。
1. 读 [`CLAUDE.md`](CLAUDE.md) —— 不可协商的约定。
2. 读 [`ARCHITECTURE.md`](ARCHITECTURE.md) —— 一页纸全局视图。
3. 在 [`docs/stories/epics/MASTER.md`](docs/stories/epics/MASTER.md) 里找到来源 epic。

## 流程

### 分支

```
feat/EPIC-XX-short-slug         # 新功能
fix/EPIC-XX-short-slug          # 缺陷修复
chore/short-slug                # 杂项（依赖、配置）
docs/short-slug                 # 仅文档
```

### 提交

Conventional commits + `EPIC-XX` 范围：

```
feat(EPIC-04): kanban drag-and-drop com fractional indexing
fix(EPIC-03): cron recover-stuck-messages marcando sending stuck >5min como failed
docs(EPIC-12): mark complete + wave log
```

提交信息用葡语也可以。标题必须用祈使句，且 ≤72 字符。

### epic-executor

大型改动遵循 [`docs/stories/epics/`](docs/stories/epics/)。`epic-executor` 读取 frontmatter（`epic_id`、`priority`、`depends_on`、`status`），按 wave 逐个执行并持续做 E2E 验证。

完成一个 epic 时：

1. 更新 frontmatter：`status: pending → completed (partial: ...)` 或 `status: completed`。
2. 在文件末尾追加 "Wave Completion Log"。
3. 更新 `docs/stories/epics/MASTER.md` 里对应的行。

### PR 流程

1. 从 `main` 拉分支。
2. 实现。补测试（流程用 E2E，纯逻辑用 unit）。
3. **Definition of Done。** 这份清单分成两类是有原因的：过去它把"机器会自动拦下的"和"只有人能发现的"混在一起，贡献者出于好意把整个清单都勾上，结果被一个没人告诉过他的 gate 挡住。

   **CI 会自己拦下的** —— 开 PR 前先跑，就不会有意外：

   ```bash
   pnpm cercas    # 约 30 秒：结构性守卫（baseline、MANIFEST、docs、workflows）—— 最容易拦下 PR 的那批
   pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build
   pnpm test:db   # 需要 Docker；起一个干净的 Postgres 并应用 baseline
   ```

   **CI 看不到的** —— 这部分靠你自己和评审，也是代价高昂的缺陷所在：

   - 如果你新建了租户相关表，RLS 要启用且策略为 `tenant_isolation_<tabela>_all`
     （隔离测试只覆盖一个固定表列表；你新建的表不会自动进列表）
   - 有重要变更时要发审计日志
   - 公开路由要限流
   - 所有外部输入都用 Zod 校验
   - 不能遗留 `console.log`（用 `lib/logger.ts`）。**`pnpm lint` 不会拦这个** —— 规则是警告级，
     所以它会绿着通过；这项靠人工检查
   - 新环境变量要同时写进 `.env.example` **和** `lib/env.ts`，默认值不能破坏全新安装
   - Schema 变更要走**三件套**：`supabase/migrations/` 里的文件、`supabase/baseline.sql` 里的
     幂等附录、`MANIFEST.md` 里的一行。自托管套件**只应用 baseline** —— 没进 baseline 的
     migration 到不了装在 VPS 上的用户那里。没有任何 CI job 会检查这一点
   - **如果你动了 `Dockerfile*`、`docker-compose*.yml` 或 `hostgator-setup-kit/`：** 改动要能到达
     **已经装过**的用户。法则见 [`docs/doctrine/packaging.md`](docs/doctrine/packaging.md)。
     CI 会拦 `build:`-only 服务、移动 tag 安装和坏镜像（`imagens-ok`）；剩下的靠你：新变量要有
     不破坏旧 `.env` 的默认值，升级过程不能要求手动改文件。**任何版本升级都不能要求 VPS 操作者
     手动改任何东西** —— 如果必须改，请开 issue 并附迁移计划，而不是提 PR
   - 契约变了就更新文档（PRD/spec）
   - `pnpm test:e2e`（相关子集）—— **从外部贡献时可以跳过**，见下文
4. 对 `main` 开 PR。描述里要引用 epic 并列出证据（日志/测试截图）。
5. **动了权威文档？** 只修正**那份**文档里关于状态的陈述 —— 即"什么是生效的、什么还缺、什么指向
   哪里"。不要去别的文档里地毯式搜索：没人喂养的债务会自己衰减。实测发现及各自的复现命令见
   [`docs/audits/2026-08-14-afirmacoes-de-estado.md`](docs/audits/2026-08-14-afirmacoes-de-estado.md)。

6. 合并前 CI 必须通过。必过项：`verify`、`invariants`（RLS 隔离）、
   `build-and-size`、`e2e` 和 `imagens-ok`。

   `imagens-ok`（在 `.github/workflows/publish-image.yml`）构建自托管用户安装的三个镜像，
   在 PR 上运行，并且自 2026-08-13 起**会阻塞合并**。

   `e2e` 绿**不**等于"旅程已被证明"：它自己会在摘要里打印哪些 spec 没覆盖。具体是哪些，
   请自己从 workflow 里读，而不是相信这一行 —— 它曾说过唯一没覆盖的是 `vps-fresh-onboarding`
   （全新安装），而自 PR #983 起这条已经在 CI 里跑了：

   ```bash
   git show origin/main:.github/workflows/e2e.yml | grep -A4 'FORA_DO_CI:'
   ```

   而且即使是有 gate 的旅程，当你改动它时，仍然欠一次**屏幕上的**证明（DoD 12）：gate 证明的是
   没有回归，不是体验变好了。

   > 这份清单曾写着"三个必过项"并把 `e2e` 说成不阻塞。两点都过时了，照它办事的人会拿错尺子。
   > 相信任何写死的清单之前，先查源头：
   > 到你的部署来源仓库的配置里查看必过检查。

### 认领 issue 的协议

这条规则存在是因为我们失败过：2026-07-30 我们开了一个 issue，一位贡献者开始解决，
一位维护者**提前 21 秒**交付了同样的修复，而两人谁都没能看见对方。他的工作成了废纸。
下面的规则就是为了不再发生。

1. **写代码前先评论"我要这个"。** 一行就够。维护者会把 issue 指派给你 —— 从此它是你的，
   别人不再动。
2. **已有指派的 issue 不要重复做。** 如果你还是想帮忙，评论提议即可；不要开竞争性 PR。
3. **维护者不得在未公开认领的情况下实现标记为 `good first issue` 或 `help wanted` 的 issue。**
   如果你看到这类 issue 无人认领，它就是你的 —— 这是我们为你的第 1 步提供的保证。
4. **"我要这个"之后 48 小时没有回复？** 直接开始，并在 PR 里说明。延迟是我们的，代价不该是你的。

### 如果你从外部（fork）贡献 —— 请读这一段

有一件事看起来像你的错，但其实不是：

- **workflow 会停着等待批准**，出现在你的第一个 PR 上。这是 GitHub 对从未贡献过的人的政策。
  维护者会放行；从第二个 PR 起就会自动运行。如果等太久，在 PR 里评论。

**永远从有名字的分支开 PR，不要从你 fork 的 `main` 开。** 如果你的 fork `main` 里已经有你的
个性化改动 —— 而且几乎总是有，因为你的 VPS 就是从它拉取的 —— 那么这个 PR 会把这些个性化
改动提给整个产品。它不会产生冲突，也不会点亮任何 gate：它们会**静默地**进入所有安装。这是
实测过的（PR #465）：七个文件带着某个客户品牌，其中六个合入时没有任何冲突。正确做法是从
**本仓库**的 `main` 执行 `git checkout -b fix/o-que-voce-conserta`，只带上你的修复。

**在你的 PR 上开启 "Allow edits by maintainers" 后，项目可以直接往你的 PR 分支推修复** ——
机械性调整，或者有冲突时把 `main` 合进来。永远以新 commit 的形式：绝不 `--force`，绝不
rebase，你的 commit 原样保留。推送前我们会在 PR 里通知。发生这种情况后，继续工作前先拉分支
（`git pull --no-rebase`）再推送；你这边一个 `--force` 会抹掉我们推上去的东西。如果该选项关闭，
修复会走我们自己的分支。两种路径下，属于你的工作都以你为作者进入。

**你的安装品牌不能靠改代码来换。** 不要改 `lib/branding.ts` 里的 `DEFAULT_APP_NAME`，也不要改
`app/` 里的标题。数据库说了算（`platform_branding`、`organizations.settings.branding`），
`.env` 里的 `APP_NAME` 只是 `install.sh` 询问的种子，其余在 **设置 › 品牌** 页面。完整配方见
[`docs/white-label.md`](docs/white-label.md)。改常量会改变**产品默认值** —— 你的品牌会在下一次
`git pull` 时消失，这正是受支持的路径对你更好的现实原因。

关于 DoD 里的 `pnpm test:e2e`：跑完整套件需要 Docker、已播种的数据库和本地 WAHA。
**我们不以此卡外部 PR** —— 交上你能证明的东西（unit + 手工测试描述），屏幕证明由维护者负责。
要求证明却不提供产出证明的工具，那是收费站，不是严谨。

### `tests/invariants/` 是冻结的 —— 而且这约束的是**行为**，不只是文件

`tests/invariants/` 里的文件保存着产品的定律，改动它们需要书面理由。有两件事不明显，
而且已经让贡献者付出过时间：

1. **守卫是维护者本地的 hook**（`core.hooksPath=loop/hooks`），不是 CI 检查。你在自己的 fork 里
   不会看到它拦截 —— 你看到的是之后集成时卡住。
2. **一个 PR 可以不碰 invariant 文件却让它失败。** 如果你的修复改变了那条定律所断言的行为，
   红色就会在那里出现。这**不是你的疏忽** —— 它是"存在两条相互竞争的规则"的信号：已写下的
   那条，和你提出的那条。

发生时，**不要删除或放宽断言**：在 PR 里说明你的理由，让选择显式化。分诊的人会带着要求的
理由修改 invariant，或者调整修复以保留旧定律 —— 决定会记录在 PR 里，那正是它能为下一个人
服务的地方。

### 界面文案：每一句新文案都需要西班牙语

产品支持葡萄牙语和西班牙语，CI 会拦**没有翻译的新句子**。这条规则在 2026-09-16 之前都没写在
这里，结果一个首次贡献的 PR 被它拦下了 —— 那是我们的问题，不是贡献者的问题。

如果你加了一句会显示在界面上的话，它要经过 `t("...")` **并且**在 `lib/i18n/dicionario.ts`
里加一行：

```ts
"Digite o identificador do modelo": { es: "Escribe el identificador del modelo" },
```

键就是葡萄牙语原文（不是编码）。只有西班牙语需要加行；其余语言按设计降级到葡萄牙语。

开 PR 前想单独确认，不必跑整套：

```bash
pnpm test:unit tests/unit/i18n-espanhol-cobre-a-tela.test.ts
```

它双向校验：界面上用了但没西班牙语，以及没经过 `t()` 的葡语文本。**如果你不会西班牙语，
照样提交**，并在 PR 里说明 —— 对分诊的人来说那是十秒钟的事，不该成为扣住修复的理由。

### 禁止的反模式

完整列表在 `CLAUDE.md`。最致命的几个：

- Postgres 触发器发 HTTP 请求
- handler 里用 service role 却不手动过滤 `organization_id`
- 后端用 `getSession()`（要用 `getUser()`）
- API key 放在 query string
- Bearer 明文存进数据库
- 已合并代码里遗留 `console.log`

## 本地环境

见 [`README.md`](README.md) §本地开发。

## 支持

**Discussions** —— 使用部署方配置的公开频道；它对所有人可用，并把答案留给后来的人。Bug 请在
该安装配置的来源仓库里开 issue。

如果是不适合公开的内容（比如安全问题），使用 GitHub 的私有漏洞报告 —— 与
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) 里指出的是同一个频道。

> 这一节曾指向一个邀请链接放在私有 Notion 里的内部 Discord —— 恰恰对最需要它的人（外部来的人）
> 不可达。留在这里作为提醒：支持渠道要从外面测试。
