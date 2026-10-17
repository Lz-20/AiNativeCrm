# Memory / Wiki / Langfuse：2026-10-03 本机真实验证

## 修复交付与第二次真实运行

以下是本次修复后的新增证据；后面的“首次验证”保留当时的失败和旧评分，不能混为当前结果。代码在独立验证 clone 的 `feat/chat-first-workbench-2026-10-01` 修改并提交至同名 GitHub 分支，不覆盖原目录的未提交工作，不合入 main。

### 修复范围

- CRM 人工确认记忆先读 SQL，不再被 Mem0 OFF 遮蔽。联系人与会话工具均显式返回来源、provider 状态和读取覆盖；远端只对本组织、相同内容哈希的本地事实排序。
- Eval profile 8 / semantic rubric 2 引入独立 SQL 存在性凭据，仅核对运行开始时已存在、期间未删除且当前仍有隐私读取资格的联系人记忆 ID。未配置平台不等于没有事实；覆盖一致也不等于任意自然语言声明已验证。
- GET Eval 可恢复材料 fingerprint 匹配的已保存真实 Judge，不再刷新就丢分，也不隐式消耗模型额度。确定性门禁与 Judge 分数分别展示。
- 新增严格白名单的合成演示证据投影；禁止提交凭据、系统 Prompt、隐藏推理、原始工具正文、电话和邮箱。固定只读演示 job 执行脚本不会消费其他历史任务。
- 修复当前分支暴露的 UI 非安全上下文 UUID、表单提交按钮、默认环境示例、Pi SDK 测试边界、事件类型约束重复定义、旧 webhook mock、发布片段缺 frontmatter、权限/品牌/架构测试契约。冻结加密协议标签，不改已有密文。渠道验签谓词归入 `lib/channels`，不降低验签与逐条消息匹配门禁。

### 对比结果（同一真实模型，合成客户）

| 证据 | 修复前原运行 | 修复后新运行 |
| --- | --- | --- |
| Run ID | `614417da-04ad-49c6-9d0c-d3a3572bb631` | `b825d92a-ec59-42c6-9db9-aa66b0cc954c` |
| SQL 确认记忆 | 1 条 | 1 条 |
| 工具读取覆盖 | 未返回确认记忆 | local / complete，联系人与会话均读到 1 条 |
| 实际工具调用 | 5 次成功 | 6 次成功 |
| 持久化事件 | 20 条 | 22 条 |
| 新确定性评测 | fail / 66 | needs_review / 71 |
| 新真实 Judge | fail / 32 | pass / 92 |
| 合并门禁 | fail / 32 | needs_review / 71 |
| Run 终态 | partial | partial |

旧 rubric 曾给修复前回答 pass / 88；新 rubric 的真实重新评审识别出 `confirmed_memory_contradicted`、`absence_stated_as_fact`，独立门禁识别 `confirmed_memory_not_observed`。不是只修改展示分数。

新任务要求读取林晓梅的确认记忆、区分事实/推断/覆盖，说明 Mem0 未连接是否妨碍本地读取。真实工具顺序：`crm_search_contacts`、`crm_get_org_memory`、`crm_get_contact`、`crm_list_conversations`、`crm_get_conversation_history`、`crm_search_knowledge`。部分工具并行；22 条原始事件可查看开始/完成的实际次序。

新输出正确引用“[演示合成事实] 林晓梅偏好下午三点沟通；先发送书面说明再预约”，明确本地 SQL 是事实源、Mem0 只是可选增强、偏好不等于外发同意。历史会话为空、组织记忆和知识依据不足，所以保持 partial / missing_material。0 个动作提案、0 次 CRM 业务写入、0 次消息发送。

新运行真实模型账本（opencode / space-bunny-free）：

| purpose | input | output | cache read | latency ms | CRM cost cents |
| --- | ---: | ---: | ---: | ---: | ---: |
| agent_turn | 17,369 | 5,696 | 24,596 | 80,922 | 0 |
| agent_turn（结构化结果恢复） | 6,608 | 1,439 | 128 | 15,731 | 0 |
| workbench_eval_judge | 4,110 | 2,029 | 141 | 28,414 | 0 |

cost=0 仅是本次 CRM 账本，非供应商独立账单核验。模型 key 仍只保存在本机加密凭据与安全环境，不进入 Git。

### 演示与证据复查

- [脱敏 JSON](fixtures/agent-services-real-2026-10-03.json)：两次实际运行，输入、最终回答、工具参数/观察摘要、事件序列、模型计量和持久化 Eval。
- 运行 `node scripts/serve-agent-demo.mjs`，打开 `http://127.0.0.1:3008/#/app/ai/workbench`，点击“真实模型录制”。可以切换修复前后、查看 Memory 事实与覆盖、展开 Tool Calling / Eval / 事件，并下载 JSON。下载文件已在真实浏览器核对与仓库录制一致。
- 真实 CRM 保留在 `http://localhost:3009/app/ai/workbench`，“运行详情 → 最近运行”可回放上述 Run。查询和刷新不再启动 Judge。
- 新合成记忆 `778c5b1e-fdf7-4942-bcac-0b5d3a58c065` 留在本机演示联系人中供查看；不是实际客户资料。首次临时记忆已按正常删除流程清空正文。
- 演示录制仅是历史回放；其他 Memory/Wiki/Trace 交互有“本地演练”标识。未部署远程 Site，不声称三个第三方平台已联通。

### 验证补充

最新生产构建、本地 bundle 检查、类型检查、全仓库 lint（0 error，继承 warning 另列）、渠道边界、角色权限与发布片段检查通过。新增/直接相关回归 6 文件 39 项通过；演示完整 DOM/样式/交互与录制隐私/零网络回放测试通过。首次回归先确认 Memory 在未配置平台时漏读的失败，再修复为通过。

本机外置盘在收尾时短暂掉线，导致一次全量单元测试以 `uv_cwd ENOENT` 中断，Docker/Lima socket 失效。重启既有低资源 VM、恢复端口后重跑；没有清空演示数据库或修改原脏工作树。完整最终结果见本节后续验证记录。

最终回归记录：

| 检查 | 结果 |
| --- | --- |
| 全量 unit | 1,318 文件通过；12,881 项通过、1 项既有预期失败、1 项既有跳过；1389.65 秒 |
| 收尾新增回归 | public trace / saved semantic / signed receipt：3 文件 9 项通过 |
| 本次核心定向回归 | 6 文件 39 项通过 |
| DB harness 静态契约 | 6 文件 43 项通过；缺 Vitest 的 shell 保护也通过 |
| 真实 PostgreSQL | 3 文件 8 项通过，baseline install 与重复 update 均通过 |
| Shell | 全仓库 shell 套件通过 |
| 生产 build | `pnpm e2e:build` 通过，浏览器 bundle 中本地 Supabase 地址检验通过 |
| typecheck / lint | 通过，lint 无 error；现有 warning 不代表已清零 |
| channels / role-rank / release | 通过；没有新增渠道识别例外，也没有写入发布版本 |
| 完整静态演示 | 62 路由及 DOM/样式/交互、真实录制隐私与零网络回放通过 |
| 实际浏览器 | 真实 CRM 保存的 Judge 92 分恢复、调用账本不增加、录制切换与 JSON 下载一致、390px 无整页横向溢出 |

没有重跑整套 Playwright，也没有跑全库全部 DB 不变量；数据库的本次范围是 Memory 隐私与组织隔离、结构化商机结果、逐条验签报价确认。完整多 Agent 与断电后的运行恢复仍需单独验收。全量 unit 在收尾新增测试文件被收集前启动，新增文件另用定向回归覆盖。

### 临时数据库镜像与恢复

Docker Hub 的 `pgvector/pgvector:pg15` 拉取两次发生 registry 网络超时。本机缓存的完整 Supabase PostgreSQL 镜像能应用 baseline，但在替换其预初始化的 `postgres` 数据库时可重复触发服务进程 exit 2，`OOMKilled=false`；不能把 install/update 成功当成整套不变量已通过，也未据此宣称某个具体扩展是根因。

最终使用相同已缓存 PostgreSQL 15.8 / pgvector 二进制启动全新标准集群，绕过供应商配置、初始化和后台组件，保留实际 ACL prelude、SCRAM 密码、fsync 与每个测试文件独立数据库。就绪探针显式传入临时测试密码；修正独立镜像的 Docker bridge SCRAM 访问规则。没有改生产数据库配置或关闭 RLS/跨组织/验签门禁。

```bash
docker build -t pi-native-test-pg15 - < scripts/test-db-supabase.Dockerfile
TEST_DB_IMAGE=pi-native-test-pg15 pnpm test:db \
  tests/invariants/ai-service-integrations.test.ts \
  tests/invariants/ai-mission-explicit-offer.test.ts \
  tests/invariants/ai-workbench-structured-result.test.ts
```

正常 CI 默认镜像仍为 `pgvector/pgvector:pg15`，离线测试镜像不能用于部署或生产耐久性认证。失败时保留临时容器的末尾诊断，再按正常 harness 清理。上述三个文件最终 8 项全部通过；日志中的跨组织 FK 和远端清理拒绝是预期的安全断言。临时测试/诊断数据库容器及其匿名卷已删除，真实 CRM 的 6 个轻量服务仍健康。

未真实配置的第三方平台、真实飞书、完整业务上线验收和无人值守稳定性仍不在本次通过范围。真实模型的 92 分不覆盖这些未验证项。

## 首次验证（修复前历史记录）

## 结论

本次已验证新增代码的生产构建、类型检查、定向回归、真实 PostgreSQL 安装/更新与安全不变量、浏览器登录及接入状态、客户记忆保存/幂等/删除，以及真实 Pi Agent 和真实模型 Judge 的运行、持久化和回放。

**不能宣称三个第三方平台已经端到端跑通。** 本机没有 `AI_INTEGRATION_BINDINGS`，也没有运行 Mem0、WeKnora、Langfuse 服务端；三项接入均为未配置、未启用。本次没有用模拟服务冒充平台联调，没有导出真实客户数据。

发现一个实际产品风险：Mem0 关闭时，工具不会返回已保存到 CRM SQL 的人工确认客户记忆；模型把不可见误表述为不存在，语义 Judge 仍给出 pass。总体 Eval 保持 needs_review，但这不等于已经识别了该事实错误。

## 代码与环境

- 仓库：`luckiest-draw/AiNativeCrm`。
- 实测分支：`feat/chat-first-workbench-2026-10-01`。
- 实测提交：`25b6f97699b0c71152c96d784b4cefae9d63e5bc`。
- GitHub main：`fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674`；本次所要求的第三方集成在功能分支，不在 main。
- 使用外置硬盘上的独立干净 clone，没有覆盖原工作目录的未提交改动，没有合并分支或推送代码。
- 实测目录：`/Volumes/exten-disk/work/crm/pi-native-crm-validation-20261003.w9F8Uy/repo`。
- 复用原仓库相同 lockfile 的真实 node_modules 副本；没有使用跨目录依赖软链接。
- 安全加载旧 `.env.e2e`，只核查变量是否存在和目标是否为 loopback；没有打印密钥。
- Colima：2 CPU、4 GiB RAM；复用现有 Supabase，不同时启动三个高资源第三方平台。
- 新版生产应用：`http://localhost:3009`。

### 挂载后的连接恢复

Docker 内部数据库健康，但宿主机 54321/54322 被挂载前遗留的 SSH mux 进程占用，连接挂起。
终止了两个已核实的旧转发进程，给当前 VM 重建端口转发，并重启 Kong；之后 Supabase Auth health 返回 HTTP 200。

在本机 Supabase 事务应用 0405、0406、0407 三项新增迁移。没有清库或重置已有数据。

## 验证矩阵

| 层次 | 实测结果 | 不应扩大的结论 |
| --- | --- | --- |
| 第一组回归 | 7 文件，76 项通过 | 含 mock/契约测试，不证明服务端可用 |
| 第二组回归 | 9 文件，78 项通过、1 项跳过 | 跳过的是可选 OpenCode 测试；另有本次真实模型验证 |
| PostgreSQL | 1 文件，3 项不变量通过 | baseline 首次安装、重复应用均成功 |
| typecheck | `tsc --noEmit` 通过 | 不是运行时业务验收 |
| 定向 lint | 新集成模块、接入面板、API、Eval 路由通过 | 未重跑全仓库 lint |
| 生产构建 | `pnpm e2e:build` 通过，确认浏览器 bundle 为本地 Supabase | 构建静态阶段有数据库断连回退警告，后续连接已恢复 |
| 浏览器 | 登录、工作台、服务面板、历史回放、Eval 展示成功 | 非整套 Playwright 回归 |
| 真实 Agent | Pi + OpenCode `space-bunny-free`，5 次 CRM 工具成功 | 终态 partial，不是任务完整成功 |
| 真实 Judge | OpenCode `space-bunny-free`，报告入库、缓存命中 | 只核对 observation，未证明业务事实正确 |
| Mem0 服务端 | 未运行 | 缺真实绑定、服务和 embedding 配置 |
| WeKnora Wiki 服务端 | 未运行 | 缺真实服务、组织可见 KB、已生成的 Wiki 与凭据 |
| Langfuse 服务端 | 未运行 | 缺独立项目绑定及实际 ingestion / 查询验证 |

真实数据库测试证实：普通角色不能直接访问客户记忆或更新集成配置；跨组织 contact FK 拒绝；联系人删除保留无正文回执，未确认远端清理时组织删除被阻止。测试日志中的两次 SQL ERROR 是预期拒绝断言，不是测试失败。临时测试数据库容器已自动移除。

## 真实产品 API 验证

### 默认关闭与启用边界

登录演示组织后，`GET /api/v1/ai/integrations` 返回 HTTP 200，三个 provider 均为：

```json
{
  "configured": false,
  "destination": null,
  "enabled": false,
  "revision": 0,
  "connectivity_verified": false
}
```

浏览器服务接入面板显示“未启用 · 等待服务端按组织配置”，启用/重试按钮均禁用。
直接请求启用 Mem0 返回 HTTP 409，要求可信服务端组织绑定；没有绕过 UI 把未配置服务打开。

### 人工确认客户记忆

仅对本机演示联系人使用明确标注的合成偏好：

```text
[临时联调测试] 演示客户偏好下午三点沟通，不代表真实客户。
```

`POST /api/v1/ai/customer-memory` 带 confirmed=true：

- 第一次 HTTP 200，返回 confirmed=true、sync_state=pending。
- 相同 request_key 和相同内容重试 HTTP 200，返回同一 memory ID。
- GET 确认正文实际保存到 SQL，write_outcome=never_started。
- 未配置 Mem0，因此没有外部 ADD / embedding / 同步发生。
- 验证后 DELETE HTTP 200，GET 确认 body 清空、sync_state=deleted、deleted_at 非空；never_started 回执的 remote_deleted_at 已设置，不需要不存在的远端删除。

测试 memory ID：`31e39b71-ab96-4f66-93bb-6b985ec1f7c4`。这条合成记忆正文已删除，脱敏回执保留。

## 真实 Agent 输入、工具与输出

Run ID：`614417da-04ad-49c6-9d0c-d3a3572bb631`。
Agent：CRM 情报员；mode=inspect；模型为组织当前默认 `opencode / space-bunny-free`。
原数据库的加密凭据可以解密，模型目录 HTTP 200 且列出该模型。没有重新硬编码或公开凭据。

输入：

```text
[2026-10-03 integrations live check] 请调用 crm_search_contacts 搜索演示客户林晓梅，调用 crm_get_contact 读取资料，列出她的人类确认客户记忆。只读，不修改 CRM，不发送消息，明确区别 CRM 事实与推断。
```

实际路径：浏览器登录 → 工作台提交 → SQL durable run / job → 精确领取本次演示 run 的队列 lease → 调用生产 `runWorkbenchStartJob` → Pi / 真实 provider → CRM 工具 → SQL observations / events → completeJob。

没有启动会消费其他遗留任务的全局 24/7 worker；本次是对指定 job 的单次生产 handler 执行，不是完整调度 daemon 的长期验证。

| 顺序 | 工具 | 结果 |
| --- | --- | --- |
| 1 | crm_search_contacts | 命中演示联系人林晓梅 |
| 2 | crm_get_org_memory | 与首次搜索并行；没有发布的组织记忆 |
| 3 | crm_get_contact | 读取联系人实际资料 |
| 4 | crm_list_conversations | 读取关联演示会话 |
| 5 | crm_get_conversation_history | 会话 checkpoint customer_memory=empty |

5 次工具均成功，0 个操作提案，没有 CRM 写入或消息发送。结果恢复阶段通过结构化提交机制保存了结果。

输出摘要：Agent 报告联系人的基本资料和会话，并把“没有人类确认客户记忆”标为数据库事实；区分了 demo 来源推断及人工接管待确认点。

实际终态为 `partial`，error_code=`missing_material`。保存了 20 个单调排序事件，包含启动、上下文、工具开始/完成、模型决策、部分完成和用量。导航离开后重新进入工作台，在“最近运行”选择本次记录，能重新看到回答、20 个事件、0 个提案、结构化结果和确定性 Eval。

### 实际模型账本

直接检查本次 run 的 `llm_calls`：

| purpose | 状态 | input tokens | output tokens | cache read tokens | latency ms | CRM 记录 cost cents |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| agent_turn | ok | 16,694 | 2,987 | 23,774 | 24,237 | 0 |
| agent_turn | ok | 3,948 | 1,328 | 128 | 13,364 | 0 |
| workbench_eval_judge | ok | 3,355 | 2,026 | 128 | 24,773 | 0 |

前两项对应 Agent 执行与结果恢复；最后一项为显式请求的语义 Judge。cost=0 是 CRM 本次账本记录，不是独立的供应商账单核验。

## Eval 真实结果与持久化

1. GET Eval：HTTP 200，确定性分数 76，verdict=needs_review；没有触发 Judge。
2. POST mode=deterministic_export：HTTP 200，报告入库，projection=queued_if_enabled。
3. POST semantic：HTTP 200，真实模型 Judge 完成；Judge verdict=pass、score=88，总体报告仍为 needs_review / 76。
4. 同样输入再次 POST semantic：HTTP 200、cached=true，没有新增模型调用。
5. 再次保存确定性报告仍成功，SQL 仅保留该 run 的两份不同 fingerprint 报告。
6. Langfuse 导出事件为 0，符合未配置/未启用的默认关闭契约；不能把 queued_if_enabled 文案视为已远端投递。

确定性维度：任务完成50 / needs_review、答案质量50 / needs_review、工具可靠性100、策略合规100、效率100；知识与多 Agent 均 not_run。

语义 Judge 指出 consent 全 null 应表述为“未记录同意”、而非“无经同意确认的偏好记录”，但仍认为观察与答案总体一致。

## 实测发现：不可见不等于不存在

合成客户记忆在 11:26:09 已保存，运行上下文在 11:26:14 开始加载，相关工具随后执行。产品 GET 和 SQL 均证实它在 Agent 执行期间存在，且尚未删除。

`readConfirmedCustomerMemory` 在没有 Mem0 binding 或未启用时直接返回 disabled / 空列表，不查询该确认事实表。会话 checkpoint 与人工确认事实属于不同数据面；前者 empty 也不能证明后者不存在。Agent 用缺失字段、空 tags、空 consent 和空 checkpoint 共同推断“数据库没有任何人类确认记忆”，超出了实际读取覆盖。

这不是 Mem0 服务错误，因为本次没有调用 Mem0。它是默认关闭状态下的产品契约/负面事实推理风险。

建议优先补齐：

- 工具返回明确的记忆检索覆盖：disabled / unavailable / empty / found；提示未检索的数据面，不能混同空结果。
- 明确 CRM 人工确认事实是否应独立于 Mem0 开关被读取。若希望停用 Mem0 仍保留记忆能力，应把 SQL 读取与外部排名拆开，而不是让 provider 开关同时隐藏本地事实。
- Eval 对“没有/不存在/从未”等断言要求完整检索覆盖或独立事实查询。当前 Judge 只看 observation，容易与执行模型共同接受一个遗漏。
- 新增固定业务 fixture 的 golden Eval：SQL 有人工确认事实、Mem0 关闭；预期答案应说明服务未接入/未检索，而非宣称无记忆。
- 保存的语义报告可以缓存复用，但工作台重载默认显示确定性报告；要查看语义结果仍需显式请求。这与当前 GET 只读确定性契约一致，需要避免用户把默认界面理解为语义报告丢失。

本次只做诊断和验证，未改写运行时行为。

## 尚未验证与下一轮前置条件

Mem0：需要真实 reviewed REST 服务、服务 key、真实 embedding 配置；验证保存→同步→排名读取→人工撤销→远端清理，以及超时后只 reconciliation 不重复 ADD。

WeKnora：需要真实 v0.8.2 服务、组织权限的 KB、已解析原文和发布 Wiki；验证真实搜索/页面/原文接口、来源更新/撤回、CRM 证据回执以及 Agent 实际使用 Wiki 引用。

Langfuse：需要真实项目的 public/secret key 与 endpoint；验证实际模型/tool trace 出队、score 投递，并通过实际查询 API/UI 证实 observation/score 落地，不能只依赖 HTTP acknowledgment。

三个平台可以使用远端测试环境，或本机依次启动并限制资源；不建议在当前 4 GiB VM 同时启动全部默认部署。
可信 `AI_INTEGRATION_BINDINGS` 应放在本机安全环境/secret manager，再由组织管理员显式启用。不要把凭据发送到聊天或提交 Git。

本次不覆盖第三方真实 ACL、数据保留/删除、跨平台异步最终一致性、完整多 Agent 场景、全仓库测试或完整 Playwright 套件。

## 保留的证据

- 本机 SQL：本次 run、20 个事件、持久化 observation、2 份 Eval 报告、3 条真实模型调用账本。
- UI 回放截图：`/Volumes/exten-disk/work/crm/pi-native-crm-validation-20261003.w9F8Uy/agent-services-replay.png`。
- 新版生产应用保留在 3009，原工作目录未被覆盖；新增迁移保留在本机 Supabase。
- 临时合成客户记忆正文已清空，回执保留；没有真实客户消息发送、第三方数据导出或 GitHub 写操作。
