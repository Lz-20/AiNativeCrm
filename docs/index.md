---
type: index
project: pi-native-crm
status: draft
last_updated: 2026-07-29
generated_by: auditoria documental (Claude Code)
confidence: alta (inventário de arquivos é CONFIRMADO; agrupamento temático é INFERIDO)
audited_against: origin/main @ 789dfa6 (v1.0.0, 2026-07-27)
---

# 文档索引 — pi-native-crm

`docs/` 下 **187** 个 `.md` 文件、分布在 **20** 个子目录的地图 —— 用这两把尺子量：
`git ls-files 'docs/**/*.md' | wc -l` 和
`git ls-files 'docs/**/*.md' | sed 's|^docs/||;s|/.*||' | sort -u | wc -l`。
之前这里写的数字（154/20）会随交付变化；**相信命令，不要相信这一行**。

**两份文档冲突时的优先级：**
`CLAUDE.md`（教义）> `docs/specs/`（技术契约）> `docs/prd/`（意图）>
`HANDOFF-*.md`（会话状态）> README。发现分歧时，改正优先级较低的那份并记录下来。

---

## 1. 从这里开始

| 文档 | 用途 |
|---|---|
| [`README.md`](../README.md) | 当前项目定位、状态与本地开发（简体中文） |
| [`VISION.md`](../VISION.md) | 定位、为什么自托管、面向谁 |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | 一页纸架构 |
| [`AGENTS.md`](../AGENTS.md) | 面向代码 Agent 的契约（任何工具） |
| [`CLAUDE.md`](../CLAUDE.md) | **不可协商的教义。** 约定、反模式、Definition of Done |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | 如何贡献 |
| [`CHANGELOG.md`](../CHANGELOG.md) | 按版本的变更（SemVer）。**运行 VPS 的人在 `update.sh` 前必读** —— 需要手动操作的变更会出现在 "⚠️ Requer atenção" 下 |
| [`docs/current-state.md`](current-state.md) | **今天哪些完成、哪些不完整、哪些坏了** |
| [`.agents/skills/`](../.agents/skills/pi-native-instalar/SKILL.md) | **助手指南** —— 安装、按行业配置客户、指标、提示词、贡献。由 Claude Code、Codex、Cursor、OpenCode 和 Antigravity 读取（不要和 AI Agent 的 *Skills* 混淆，那个在界面 AI › Skills） |

## 2. 产品与意图

| 文档 | 内容 |
|---|---|
| [`prd/00-prd-master.md`](prd/00-prd-master.md) | 主 PRD —— 愿景、MVP 范围、KPI、约束 |
| [`prd/01-prd-platform-base.md`](prd/01-prd-platform-base.md) | Auth、多租户、RBAC、LGPD 框架 |
| [`prd/02-prd-customer-360.md`](prd/02-prd-customer-360.md) | Customer 360 + 确定性身份合并 |
| [`prd/03-prd-whatsapp-waha.md`](prd/03-prd-whatsapp-waha.md) | WhatsApp 渠道、防封、24 小时窗口 |
| [`prd/04-prd-pipeline-attendance.md`](prd/04-prd-pipeline-attendance.md) | Kanban、接待、工单、转人工 |
| [`prd/05-prd-ai-rag-handoff.md`](prd/05-prd-ai-rag-handoff.md) | 对话式 AI、按租户的 RAG、情绪 |
| [`prd/06-prd-nuvemshop-lgpd.md`](prd/06-prd-nuvemshop-lgpd.md) | Nuvemshop 集成 + LGPD webhook |
| [`business-rules/00-business-rules-catalog.md`](business-rules/00-business-rules-catalog.md) | **业务规则目录** —— 代码之外的真相来源 |
| [`presentation/pitch-deck.md`](presentation/pitch-deck.md) | 路演材料 |

## 3. 技术契约（specs）

细化到 SQL schema 和精确 payload。**建模前先查这里。**

| Spec | 领域 |
|---|---|
| [`specs/01`](specs/01-spec-platform-base.md) | 平台基础 —— 多租户、RLS、RBAC、API、审计 |
| [`specs/02`](specs/02-spec-customer-360.md) | Customer 360 |
| [`specs/03`](specs/03-spec-whatsapp-waha.md) | WAHA —— 出站队列、预热、文案轮转、cron |
| [`specs/04`](specs/04-spec-pipeline-attendance.md) | Pipeline 与接待 |
| [`specs/05`](specs/05-spec-ai-rag-handoff.md) | AI、RAG、转人工触发条件 |
| [`specs/06`](specs/06-spec-nuvemshop-lgpd.md) | Nuvemshop + LGPD |
| [`specs/07`](specs/07-spec-events-workers.md) | **`event_log`、workers、原子认领、backoff/DLQ** |
| [`specs/08`](specs/08-spec-deploy-observability.md) | 部署与可观测性 |
| [`specs/09`](specs/09-spec-frontend-backend-integration.md) | 前后端集成 |
| [`specs/10`](specs/10-spec-ai-agents-runtime.md) | AI Agent 运行时 |
| [`specs/11`](specs/11-spec-mcp-server-internal.md) | 内部 MCP server + tools 目录 |
| [`specs/12`](specs/12-spec-ai-agents-ui.md) | AI Agent 界面 |
| [`specs/13`](specs/13-spec-governanca-atendimento.md) | 接待治理（epic G1–G6） |
| [`specs/14`](specs/14-contrato-governanca-agentes-externos.md) | 外部 AI Agent 契约 |
| [`specs/15`](specs/15-spec-casos-humanos.md) | 人工案例（AI 交给人工） |
| [`specs/16`](specs/16-spec-tres-papeis-do-agente.md) | **Agent 的三个角色** —— 对话者 / 操作者 / 安全员 |
| [`specs/17`](specs/17-spec-conversa-vira-lead.md) | **对话变成线索** —— 接待与 CRM 之间的纽带 |
| [`specs/17`](specs/17-spec-indice-de-atrito.md) | **摩擦指数** —— 衡量目的（双方摩擦更小），而不是活跃度 |
| [`specs/18`](specs/18-spec-voice-calls-wacalls.md) | WhatsApp 语音通话（WaCalls）—— 草稿，无专属子 PRD |
| [`specs/extensoes-declarativas-v1.md`](specs/extensoes-declarativas-v1.md) | **声明式扩展 v1** —— 严格 JSON 包、由安装所有者认可的目录、按组织激活、CRM hub 里的指南 |
| [`specs/RECONCILIATION-LOG.md`](specs/RECONCILIATION-LOG.md) | Specs 之间的对账日志 |

## 4. 教义与架构

| 文档 | 内容 |
|---|---|
| [`doctrine/sistema-vivo.md`](doctrine/sistema-vivo.md) | **活系统教义 —— 法则。** 7 条不变量 + 时间规则 + Living System Checklist（DoD 第 13 项） |
| [`doctrine/sistema-vivo/`](doctrine/sistema-vivo/README.md) | **活系统手册** —— 8 个可插拔章节（普适原理 + 参考实现）。每条不变量背后的*为什么*，以及如何把教义搬到别的系统 |
| [`doctrine/restricao-de-canal.md`](doctrine/restricao-de-canal.md) | 外部渠道的自我限制 × 他者限制；派生参数契约 |
| [`doctrine/separacao-fala-e-operacao.md`](doctrine/separacao-fala-e-operacao.md) | 内部词汇绝不泄漏给客户 |
| [`doctrine/packaging.md`](doctrine/packaging.md) | **打包教义 —— 法则。** 8 条不变量 + 渠道策略 + 发布清单（DoD 第 15 项） |
| [`doctrine/destrutivo-pede-confirmacao.md`](doctrine/destrutivo-pede-confirmacao.md) | 破坏性操作需要**点名目标**的确认 —— 两个孪生按钮，同一个契约 |
| [`doctrine/extensoes.md`](doctrine/extensoes.md) | **扩展教义 —— 法则。** 用"零激活时常规运营是否完整？"区分内核与扩展 + 13 条不可协商项，含 DEC-004 策略（DoD 第 18 项） |
| [`specs/19`](specs/19-spec-console-de-agencia.md) | **代理控制台** —— 运营 N 个客户组织；计费单位已定（按被运营客户收 retainer）。法则见 [`doctrine/operacao-de-agentes.md`](doctrine/operacao-de-agentes.md) |
| [`adr/0001-packaging-e-distribuicao.md`](adr/0001-packaging-e-distribuicao.md) | 打包 ADR：命名空间、3 个 package，以及被否掉的方案 |
| [`adr/0002-tabelas-de-modulo-num-banco-so.md`](adr/0002-tabelas-de-modulo-num-banco-so.md) | **2026-09-17 通过。** 可选模块的表：单一数据库、`public` schema，模块被安装时由固定的 provisioning 函数创建 |
| [`architecture/agent-turn.html`](architecture/agent-turn.html) | Agent 回合图（入站 → guardrails → 出站） |
| [`specs/pre-go-live-whatsapp.md`](specs/pre-go-live-whatsapp.md) | 按渠道的 WhatsApp 测试模式：电话列表、对公众开放，以及和来源授权策略的兼容性 |
| [`specs/19`](specs/19-spec-console-de-agencia.md) | **代理控制台** —— 运营 N 个客户组织；计费单位已定（按被运营客户收 retainer）。法则见 [`doctrine/operacao-de-agentes.md`](doctrine/operacao-de-agentes.md) |
| [`architecture/pre-go-live-whatsapp.architecture.json`](architecture/pre-go-live-whatsapp.architecture.json) | 上线前、管理配置与共享 gate 的地图 |
| [`architecture/extensoes-declarativas.architecture.json`](architecture/extensoes-declarativas.architecture.json) | 声明式扩展的活地图 —— 准入、下载、回执、按组织激活、CRM 里的指南 |
| [`architecture/teto-de-orcamento.architecture.json`](architecture/teto-de-orcamento.architecture.json) | **AI 花费上限的活地图** —— 谁给 gate 供数、停止**不**会自动撤销什么、以及回流环（不变量 7） |
| [`release/teto-de-orcamento.md`](release/teto-de-orcamento.md) | **面向 VPS 运维者的发布说明** —— 改了什么、要做什么（什么都不用）、R$ 到 US$ 的标签切换、如何开启保护 |
| [`research/architecture-diagrams.md`](research/architecture-diagrams.md) | 架构图 |
| [`research/extensoes/`](research/extensoes/README.md) | 扩展平台 —— 已批架构、已完成工作台、第一个集成已在界面上验证；随 PROG-021 |
| [`research/reference-synthesis.md`](research/reference-synthesis.md) | 继承自 WAHA 参考实现的架构 |
| [`research/followup-reference-mining.md`](research/followup-reference-mining.md) | Follow-up 引擎调研 |
| [`threat-model.md`](threat-model.md) | **自托管的真实攻击面** |
| [`alertas-de-seguranca-triados.md`](alertas-de-seguranca-triados.md) | GitHub 面板里每个**被弃用**告警的理由，以及按类别扫描发现了哪些 scanner 看不到的问题 |

## 5. 设计系统

[`design-system/README.md`](design-system/README.md) 是入口（v1.0，5 个锁定的视觉选择：
Sage 调色板、Atkinson Hyperlegible、通透密度、Phosphor duotone、IBM Plex Mono）。
编号 `00`–`09`：概览、tokens、调色板、排版、密度、图标、组件、动效、语气与用词、**反模式**。
屏幕流程在 `design-system/screen-flow/`（旅程、clickflow、状态机、无障碍）。

## 6. 运维与安装

| 文档 | 内容 |
|---|---|
| [`SETUP.md`](SETUP.md) | 环境变量与本地配置完整指南 |
| [`deploy-selfhost/README.md`](deploy-selfhost/README.md) | 通用自托管 |
| [`deploy-hostgator/README.md`](deploy-hostgator/README.md) | HostGator VPS（`install.sh`、`backup.sh`、`reset-mfa.sh`） |
| [`DEPLOY-CHECKLIST.md`](DEPLOY-CHECKLIST.md) | 部署清单 |
| [`ATUALIZANDO.md`](ATUALIZANDO.md) | `update.sh`、`restore.sh`、`healthcheck.sh` |
| [`runbooks/deploy.md`](runbooks/deploy.md) | **生产部署 —— compose 的两个 `-f`、部署后验证** |
| [`runbooks/remediar-worker-congelado.md`](runbooks/remediar-worker-congelado.md) | **事故：崩溃的 worker** —— 诊断（`diagnostico.sh`）、实测影响和两条修复路径。**尚未演练** |
| [`runbooks/ativar-packaging.md`](runbooks/ativar-packaging.md) | **启用打包教义** —— 3 个放不进 PR 的步骤（公开包、必过 check、首次发布） |
| [`runbooks/custo-e-cota-do-supabase.md`](runbooks/custo-e-cota-do-supabase.md) | **"我的 Supabase 超配额了"** —— 如何定位消耗来源、队列的两个间隔、以及两张只增不减的表 |
| [`runbooks/waha-hostgator.md`](runbooks/waha-hostgator.md) | 生产环境 WAHA runbook |
| [`runbooks/cloudpanel.md`](runbooks/cloudpanel.md) | **80/443 上已有 CloudPanel/Nginx 的 VPS** —— 套件的外部代理模式、宿主机 Nginx 的固定地址，以及全局 webhook 的 403 |
| [`runbooks/ai-credentials-rotation.md`](runbooks/ai-credentials-rotation.md) | AI 凭据轮换 |
| [`../SECURITY.md`](../SECURITY.md) | 漏洞报告政策 |

## 7. 测试与 QA

| 文档 | 内容 |
|---|---|
| [`testing/user-journey-map.md`](testing/user-journey-map.md) | **活的旅程地图** —— 用例、`[P0]` 优先级、发现。始终更新 |
| [`testing/HANDOFF-vps-qa.md`](testing/HANDOFF-vps-qa.md) | VPS 风格全新环境的配方 |
| [`harness-audit.md`](harness-audit.md) | **Harness 审计** —— 20 项 + 成熟度等级 |
| [`audits/2026-08-14-afirmacoes-de-estado.md`](audits/2026-08-14-afirmacoes-de-estado.md) | **393 条状态陈述逐条对着源头测量**，每条都附回答它的命令。这是支撑本日教义修正的带日期快照 —— 引用其中任何数字前先看日期 |
| [`audits/2026-08-14-alinhamento-stable-v1.3.0.md`](audits/2026-08-14-alinhamento-stable-v1.3.0.md) | 标签 `v1.3.0`（跑在 VPS 上的套件，不是 `main`）实际包含什么 |
| [`../tests/e2e/README.md`](../tests/e2e/README.md) | 如何运行 E2E |

## 8. 执行 —— 计划、epic、交接

*过程*文档。更替频繁；把它们当作状态，而不是契约。

- [`stories/`](stories/) — epic 和 story（`epics/MASTER.md` = 按 epic/wave 的计划）
- [`superpowers/`](superpowers/) — 按 wave 标注日期的 `plans/` 和 `specs/`
- [`growth/`](growth/) — 增长材料 · [`brand/`](brand/) — 品牌 · [`white-label.md`](white-label.md) — 品牌自托管，另有 [en](white-label.en.md) 和 [es](white-label.es.md)（译文由原文哈希封印；见 `scripts/selar-traducao.ts`）
- [`../loop/`](../loop/) — gov-loop 机器（`LOOP.md`、`CHECKPOINT.md`、`checkpoints/G1..G6-report.md` + `.approved`）

## 9. 知识图谱

`graphify-out/` —— 仓库图谱（上次生成：7310 个节点、17705 条边、538 个社区）。
在用技能 `graphify` 之前不要扫原始代码。`GRAPH_REPORT.md` 含 god nodes、hyperedges 和社区。
**生成物 —— 不要编辑。** ⚠️ 它针对 v1.0.0 之前的树生成；在依赖细节前先重新生成（`/graphify .`）。

---

## 本索引已知的缺口

- `docs/vendaval-fusion-plan.md` 和 `docs/vendaval-vps-deploy-comandos.md` 指向一个仍处于
  **待确认**状态的集成（"Vendaval"）—— README 的"下一步"里**已经不再列出**它，尽管触发条件
  （`loop/checkpoints/G6.approved`）仍然存在。
- `docs/diagrams/` 没有 `.md`，未纳入清单。`docs/evidence/` 是视觉证据（18 张 PNG），不是阅读文档。
- `docs/architecture/` 汇总 JSON 地图及其可用渲染。查阅[地图目录](architecture/README.md)和目录文件；
  数量随交付变化。教义要求表示新部件及其关系，`tests/unit/mapas-de-arquitetura.test.ts`
  校验运行时形态和 kind。这个 gate 本身不能证明每个功能都有地图。
- `docs/growth/`（3 个文档）和 `docs/brand/`（1 个）未逐篇细读 —— 按目录名分类，因此是**推断**。

- [按会话的管理跟踪](support-sessions.md) — 权限、只读、产出和 OAuth 契约。

### 可选的 Agent 服务

- [Mem0 客户记忆、WeKnora 企业 Wiki、Langfuse trace/Eval 适配器](integrations/agent-services.md)
- [适配器验证与未测量的部署门禁](testing/agent-services-2026-10-02.md)
- [系统全面验收：真实模型、多 Agent、Memory/Wiki/Langfuse 与失败门禁](testing/system-acceptance-2026-10-03.md)
