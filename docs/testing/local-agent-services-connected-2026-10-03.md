# 本地三服务真实联调记录（2026-10-03）

## 结论与范围

Mem0、WeKnora Wiki、Langfuse 均已通过真实功能请求接入本地 CRM，不仅是进程健康。测试只使用 `pi-native-demo` 的合成资料和既有加密模型凭据；没有接通客户渠道、发送消息或修改商机。本次不证明生产可用、多 Agent 调度可靠性或业务答案全部正确。

| 链路 | 实际证明 |
| --- | --- |
| Mem0 | 人工确认事实同步至真实 512 维 ONNX/pgvector；远端搜索命中；CRM 返回 `providerStatus=connected`、1 条记忆；无鉴权访问返回 401；另一个合成测试事实经 CRM 删除、同步后远端不存在 |
| WeKnora | 实际模型完成源文档 ingest，状态 `completed`，生成并发布 11 页；CRM 检索得到 4 条当前源文档可核验的 Wiki 证据 |
| Langfuse | 实际 OTLP 模型/工具记录落入本地 ClickHouse；新版 API 回读对应 Trace、8 个分数，并核对全部 input/output 为空；浏览器可查看调用树和 Scores |

源文档 `9f8bca56-2f2e-432f-b1c8-07dca1e846dd`，KB `d96763fd-cbd1-48c0-abda-8dd1962cae37`，CRM 授权知识源 `4d311395-0f20-409a-aeab-fa622862d673`。原始合成事实记忆 `778c5b1e-fdf7-4942-bcac-0b5d3a58c065` 保留；临时测试记忆 `1a6639ac-06c5-4132-bffd-a6ab7b9202ff` 已通过 CRM API 留审计后软删除并核验远端清理，不影响其他数据。

## 最新真实 Agent 输入、工具与输出

Run：`3eb4319f-fc11-43d5-84ca-510f19113d63`。执行 14:34:04–14:34:38（北京时间），`inspect`，真实模型 `opencode/space-bunny-free`，普通可编辑的内置 Agent 副本草稿，未发布。

真实用户任务：

> [2026-10-03 memory regression] 本地三服务真实联调，仅合成演示资料。请调用 crm_get_contact 读取林晓梅的已确认记忆，并调用 crm_search_knowledge 使用 query=产品 查询 Wiki 产品与人工确认规则。分别引用客户记忆 ID 和公司 Wiki 证据，解释下午三点联系偏好与外部发送前确认规则的区别。获取证据后立即提交最终结论。必须注明合成演示；禁止发送消息、创建任务或修改商机。

实际 CRM 读工具（并行）：

- `crm_get_contact`：读取指定合成联系人，成功返回已确认记忆、客户上下文权威边界及真实 Mem0 状态。
- `crm_search_knowledge`：检索产品资料，成功返回 4 条 `organization_wiki` 证据：`2cdef2d8-0b96-4727-a445-f203cf1d059a`、`ca236502-c09d-4d76-a151-a90e9b796464`、`3ec5b3b6-32f2-482b-9b7a-6fa4733d5740`、`e60d17ff-1d10-4147-9967-d274e038bf61`。
- Agent 另通过 Harness 结果工具提交结构化报告。CRM 运行事件有 12 条；CRM Eval 的工具计数只统计 2 个业务读工具，不能与 Langfuse 包含结果提交和 Judge 的工具数混用。

实际最终回答的节选（不是替模型补写）：

> 【合成演示资料，非真实客户数据】本次为只读联调：仅调用 crm_get_contact 与 crm_search_knowledge，未发送任何消息、未创建任务、未修改商机，也未提交任何待审提案或排队发送。
>
> contact 6842302c-a864-4a4e-8dc5-a605f6c10827 返回 1 条已确认记忆，记忆 ID 778c5b1e-fdf7-4942-bcac-0b5d3a58c065，category=preference，正文自述为“[演示合成事实] 林晓梅偏好下午三点沟通；先发送书面说明再预约。不代表真实客户。”
>
> Wiki《演示合成产品资料与人工确认规则 - Summary》与《Pi Native CRM》均记载：“发送外部客户消息和其他不可逆动作必须等待人工确认。读取 CRM 数据可自动执行。”

Agent 把外联同意/审批缺失也列为缺失材料，故终态仍为 `partial / missing_material`。这次只读任务并未要求实际外联，说明任务完成判断仍可改进；没有为了显示绿色而改写运行结果。

## Trace 与真实评测

最新 Trace：`43552810a298916bccd48ff8f870186f`。

- 本地 Langfuse 持久化回读：10 条 observations，其中 3 条 `crm.model`、4 条 `crm.tool`，还包含 run/call 父节点；包含 Agent 和实际语义 Judge 的内部调用，非模型原始思维链。
- 分数：`crm.overall=81`、`crm.semantic=86`、知识证据/工具可靠性/策略合规/效率各 100，任务完成/答案质量各 50。
- Judge 发现：把 contact 的字段断言挂在记忆证据上；人工确认的“优先级”表述超出 Wiki 原文；把文档的 inspect 描述扩大为现实规则。
- 总评 `needs_review`，真实 Judge `pass / 86` 不能覆盖确定性待复核结果。
- agent_turn 顶层记录：input 11159、output 1834、cache-read 4061、33.631 秒、provider 报告成本 0；这是顶层汇总，不能用它替代每个 Pi 回合的独立观测。

可在本机查看[CRM 运行](http://localhost:3009/app/ai/workbench?run=3eb4319f-fc11-43d5-84ca-510f19113d63)与[Langfuse Trace](http://127.0.0.1:3006/project/crm-local-demo-project/traces/43552810a298916bccd48ff8f870186f)。需要本机已启动服务及对应本地账号；GitHub 不托管这些服务或其密钥。

前一条运行 `3c4d5c15-802e-429b-95ce-31a5f88a4707` 在 Wiki 未完成时有 5 次业务读工具、空知识证据和中间过程语，真实 Judge 10 分、`fail`；对应 Trace `3631b2f562d020b8276ba9d3902b6d18` 同样真实落库。这是负样例，不包装成成功。

## 实际修复与限制

- Agent 草稿 PATCH 接受 `knowledge_source_ids` 却未保存，已补齐赋值并覆盖选择、清空两条回归测试；真实 API 已读回选中来源。
- WeKnora 密码上限 32 字符，原初始化生成 64 字符导致注册失败；改为 20 字符混合密码，并限制遗留修复只处理未登记账号。后续注册默认关闭。
- Mem0 FastEmbed 上游未转发离线参数，最小 overlay 转发模型参数，使用预缓存真实 ONNX 权重，避免首次写入下载失败。
- Node 进程迁移后未使用本机代理，模型网络失败；显式配置代理并排除 localhost 后，真实 non-stream/stream 探针与 Agent 调用成功。原失败 Trace 仍显示 ERROR，没有伪造 token。
- Langfuse v4 的旧 `/traces/:id` 返回 404，即使新事件已入库；改用带时间范围的 Observations API v2、Scores API v3，并验证 Trace/Score 主体一致。
- 官方 MinIO 镜像不可用，S3 使用真实 SeaweedFS；ClickHouse 低内存池配置、S3 `/tmp` 和专用凭据卷均已实际启动验证。
- Wiki 上游没有执行配置的 2 页上限，实际生成 11 页；一次请求 5 分钟超时后重试成功，总 ingest 约 11 分 28 秒。生产预算及派生知识发布审批尚未验收。
- Langfuse Worker 有闲置队列的 Redis socket timeout 日志，但实际 ingestion 与 score 处理、回读均已完成；不能宣称后台所有队列无警告。

Docker VM 保持 4GB，没有清空 Supabase 或增加虚拟机内存。观测时新增服务约 2.52GB、VM available 367MB，当前四个目标进程均 `OOMKilled=false`。内存余量很小，不适合同时执行重型构建与大量并发任务；可暂停可观测性栈再恢复专用投递。

部署/重启说明见[本地服务运行手册](../../infra/local-agent-services/README.md)。凭据、私有 env、数据库卷和隐藏推理未提交。

## 代码验证结果

- `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm lint:channels`、`pnpm test:shell` 和 release fragment 检查通过。全量 lint 保留 475 条既有 warning、0 error；channel 检查报告 62 项已登记债务，没有新增项。
- 本次 API/集成相关定向测试 28 项通过；最终 API/本地服务配置检查 6 项通过。
- 按贡献指南做修复敏感性验证：在已提交修复后临时移除知识源字段赋值，两条选择/清空测试均失败、原测试通过；恢复原行后 6 项检查全部通过。源码已恢复到提交内容。
- **全量单测未通过**：1320 个文件中 1313 通过、7 失败；12879 个测试通过、13 失败、1 expected fail、1 skipped，耗时 926.27 秒。不能将本次交付标为全量 CI 绿色。
- 失败分布：邮件/SMTP 页面、Inbox 摘要、provider validator 共 10 项 30 秒超时；health 的小于 2 秒断言测得 3067ms；外部 DB DNS 和 Zernio 公网 URL 两项安全断言失败。本机额外实测 `db.invalid` 被解析为 `198.18.0.58`，而不是 DNS 失败，说明本地代理 DNS 改变了该测试前提。没有为通过测试放宽生产安全限制，也没有改动这些关联模块；其他超时尚未逐项修复。
- 本次浏览器实测 CRM 运行详情与 Langfuse Scores，不宣称执行了完整 Playwright 套件；本次未修改数据库 schema，未重新运行数据库不变量套件。

真实 Langfuse 调用树与评分截图：

![本地真实 Trace 与 8 项评分](screenshots/local-langfuse-trace-eval-2026-10-03.png)
