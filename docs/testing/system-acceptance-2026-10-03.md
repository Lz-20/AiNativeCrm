# 系统全面验收：2026-10-03

## 结论

**不通过全面验收；可继续用于内部开发和受控演示，不能据此宣称生产就绪。**

Mem0、WeKnora Wiki、Langfuse 三个真实本地服务已接通，真实模型、工具、运行事件和语义 Judge 也有持久化证据。但“接通”不是“业务任务完成”：本次多 Agent 没有交付最终答案，单 Agent 错误降级了已确认客户记忆，数据库还存在实际业务错误，自动化门禁并非全绿。

验收基线：`616c3f7b3a3fa665e45ba381cc6eb9742f0dd89d`，分支 `feat/chat-first-workbench-2026-10-01`。本轮没有修改产品运行时、数据库迁移或业务数据规则；新增的是本报告、脱敏结果摘要、可选本地浏览器配置及临时数据库隐私验收测试，并在 README 和文档索引提供最新结论入口。

## 环境与证据边界

- CRM 真服务：`http://localhost:3009`；3008 是录制回放演示，不能作为实时后端验收证据。
- macOS 16GB 内存，Docker VM 保持 4GB。验收时错峰暂停 Langfuse Web/Worker，随后恢复；没有扩大 VM、清空 Supabase 或删除持久化卷。
- Node 26.0.0、Next.js 16.3.5；不是项目标准 Node 22 的验证矩阵。数据库使用已缓存的 PostgreSQL 15 镜像，不代表 PostgreSQL 17 或完整 VPS 部署也已验收。
- 真实模型来自组织的加密凭据：`opencode / space-bunny-free`。没有把测试替身称为真实模型，没有提交凭据、浏览器登录态、私有续跑状态或隐藏推理。
- 新真实运行只读取 `pi-native-demo` 的合成联系人/商机。没有向客户发送消息，没有修改客户资料、创建跟进或批准外部动作。
- 自动化测试允许写入专用 E2E 合成组织和临时数据库；临时数据库由测试脚本退出时清理，不接触 CRM 的持久化数据库。
- [脱敏机器可读摘要](system-acceptance-2026-10-03.json)只保存状态、计数、工具名称、运行 ID 和评估分数，不保存原始 CRM 工具正文。

## 验收矩阵

| 范围 | 实测结果 | 判断 |
|---|---|---|
| 真实模型与组织 BYOK | 两条新只读运行及两个语义 Judge 均有成功的真实模型调用记录 | 接入通过，任务质量不通过 |
| 四个内置 Agent | 当前组织存在四个稳定 builtin key，均为 `organization_default` | 当前组织通过；新组织/重复初始化依赖自动化覆盖 |
| 内置原件保护 | PATCH、DELETE、合法发布请求均返回 `409 builtin_locked` | 通过 |
| 真实多 Agent | 三个 specialist、持久化子运行、14 次业务工具调用；主运行无最终答复 | **失败** |
| 真实记忆消费 | 真实 Mem0 检索命中；联系人工具返回已确认记忆，但 Agent 错误视为未核实 | 服务通过，消费质量失败 |
| 真实 Wiki | WeKnora 返回四条有来源和内容哈希的证据 | 读取通过；生产写入预算/审批未验收 |
| 真实 Langfuse | 新多 Agent 与单 Agent 的 observations、对应 scores 均回读成功，input/output 为空 | 通过 |
| Eval | 真实 Judge 给多 Agent 5 分 fail、单 Agent 74 分 needs_review，结果刷新后仍可读取 | 基础设施通过，业务质量未达标 |
| SSE 重放 | 完整序号 1–28；after=20 返回 21–28；负序号返回 400 | 通过 |
| 取消 | 排队取消 200；重复取消 409；持久化 user_cancelled 及取消事件 | 排队路径通过；真实长任务中途取消未专项验证 |
| 跨组织 API | 他组织 Agent GET/运行返回 404，他组织商机 scope 返回 422 | 所测路径通过；不等于全部租户数据面都已证明 |
| CRM 页面 | 联系人、销售漏斗、任务、记忆、知识源、运行记录及工作台可加载 | 读取冒烟通过；完整 CRUD 未通过浏览器回归 |
| 登录 | 非法凭据在中文页面显示“邮箱或密码错误”；匿名重定向、登录 a11y、首页无浏览器错误检查通过 | 所测路径通过；完整 MFA/RBAC UI 回归未完成 |
| 安装/升级 | 空库 install、update 均 ON_ERROR_STOP；有数据升级及旧版 view 迁移通过 | PostgreSQL 15 所测路径通过 |
| 构建、静态检查 | 新生产构建、typecheck、lint、channel/role 检查、shell 测试通过 | 通过，lint 有 475 warnings |
| 全量单测 | 12,888 passed，5 failed，1 expected fail，1 skipped | **失败** |
| 全量数据库不变量 | 2,173 passed，37 failed，1 expected fail，1 skipped | **失败** |
| 新增记忆隐私行为验收 | 实际匿名化、清理事件幂等、跨组织保护，4 passed | 所测本地路径通过；不抵消全量失败 |
| 外部渠道、人审恢复、真实可撤销写入 | 本轮没有真实外部渠道，不为验收而发消息/执行不可逆动作 | 未完成端到端验收 |
| 压测、备份恢复、VPS/TLS、安全渗透 | 本轮未执行 | 未验收 |

## 两条真实模型运行

### A. 商机复盘与风险评估：多 Agent

运行 `681406d2-261e-41bf-8ba1-43fcc56d995d`，只读模式，CRM 主管，自动协作。

输入要求：三个专业 Agent 分别核对客户事实、商机风险、业务政策，再综合证据、冲突、知识缺口和建议；明确标记合成资料，客户偏好不能被提升为公司政策，禁止发送或修改 CRM。

实际结果：

- `opportunity_diagnosis` completed；`customer_evidence` completed；`policy_advisor` partial。
- 主运行 `partial / empty_final_answer`，最终答案为空，未提交结构化结果，0 个操作提案。
- 28 个产品事件、14 次业务工具调用、0 次业务工具错误、3 次知识查询、13 条知识证据、182 条 specialist claims。
- 专业子运行有证据，但没有可靠汇总为用户可用结果；政策顾问产生了 114 条 claims，仍为部分结果。
- Harness 用量：input 35,752、output 5,404，4 次聚合调用，记录费用 0；配置预算 48,000 tokens、16 steps、100 cents。免费模型的零费用不代表执行没有 token/延迟成本。
- 确定性 Eval 为 84 / needs_review；真实语义 Judge 为 **5 / fail**。两者是独立结果，不能只展示 84 分来宣称成功。
- 工作台显示 partial、empty_final_answer、三个子运行及已保存的真实 Judge 失败原因，刷新读取不重新请求模型。

Langfuse trace `7ab10fd2d97ff6ff5f9720f44985a36e`：34 observations，10 model observations，15 tool observations，8 scores，其中 overall=5、semantic=5，input/output 均未导出。产品业务工具计数和底层 observation 计数不是同一口径。

### B. 已确认客户记忆：单 Agent

运行 `b5524809-fd7a-4c56-bdad-f7c0a7e3de5d`，只读模式，CRM 情报员，禁用协作。

输入要求：只读取所选联系人和已确认记忆，简短列出姓名与沟通偏好，说明不是公司政策；不查知识、不发消息、不改 CRM，提交结构化结果。

实际结果：

- `crm_get_contact`、`crm_get_org_memory` 两次工具调用成功，0 次工具错误，0 个提案。
- 提交了结构化文档，但终态是 `partial / missing_material`。
- Agent 识别了合成客户，却把 `confirmed_customer_memory` 视作“非标准字段/未核实的嵌入内容”，拒绝正常采信下午沟通及先书面说明的偏好。
- 实际联系人 handler 明确返回该字段，独立事实校验也确认记忆存在；服务接通后，工具说明、来源权威、模型消费和结果验收仍未闭环。工具 description 未说明这一新增记忆字段，是需要修订的契约线索，不是已经证明的唯一根因。
- 真实调用 input 7,715、output 2,682、cache-read 3,962，聚合调用延迟 37,797ms。
- 确定性 Eval 76 / needs_review；真实 Judge **74 / needs_review**，指出 verified_memory_discounted、contract_field_naming、timestamp_precision、overshoot_scope。

Langfuse trace `df1f30186700f7043d5c5e6010769948`：10 observations，3 model observations，4 tool observations，7 scores，overall=74、semantic=74，input/output 均未导出。

## 三个真实服务的证据

### Mem0

重新查询已确认合成记忆，CRM 状态 connected，memoryCount=1，remoteSearchMatched=true；未经鉴权请求返回 401。真实 ONNX embedding / pgvector 检索不是本地假响应。

当前配置是 `infer:false` 的已确认事实投影，**没有验收自动 LLM 记忆抽取**。保留 CRM 为事实源、Mem0 为外部索引的边界。

### WeKnora Wiki

重新查询“产品”，source 状态 complete，返回四条证据 ID 及内容 SHA-256，来源受组织和知识库范围约束。

此前真实 ingest 产生 11 页，而配置的 2 页限制没有约束上游生成；本轮没有重新 ingest。这是生产预算与审批的未关闭风险，不能因读接口通过而忽略。

### Langfuse

不是只探测 health=200：通过鉴权回读当前运行的 Observations API v2 和 Scores API v3，确认模型、工具和真实评估分数属于对应 trace，input/output 为空。

首轮 drain 使用未设置的 INTERNAL_CRON_SECRET，返回 403；按专用接口支持的 INTERNAL_SECRET 更正调用后投递成功。这个 403 是探针调用配置错误，不是 Langfuse 接入失败。Worker 停止/恢复期间分数短暂不可见，恢复后两条新 trace 均完成回读；不将队列 done 当成落库验收。

## 自动化门禁与失败分类

### 全量单测

`NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:1 pnpm test:unit --maxWorkers=2`：1,320 个文件，1,315 passed / 5 failed；12,895 个 case 中 12,888 passed / 5 failed / 1 expected fail / 1 skipped，810.64s。

loopback 闭端口覆盖只用于阻止测试环境默认占位地址走 DNS/代理；不是产品安全降级。结果与默认环境历史运行不同，不能拿重试替代本次全量失败。

| 失败文件 | 实际观察 | 分类与状态 |
|---|---|---|
| `tests/unit/evidencia-citada.test.ts` | 把文档相对截图引用当作仓库根路径；截图实际在 git 中 | 证据路径解析契约问题，不是图片未提交；未修复 |
| `lib/external-db/guardas.test.ts` | `.invalid` 被本机 DNS 解析到特殊地址；仍失败关闭，但错误码为 ip_especial 而非 dns_falhou | 环境相关断言差异；未减弱 SSRF guard |
| `tests/unit/channel-adapter-zernio.test.ts` | 应为公网的域名被判 private_ip | 本机 DNS/代理影响；未放行特殊 IP |
| `tests/unit/health-separa-env-errado-de-servico-caido.test.ts` | 耗时约 3 秒，超过小于 2 秒的断言；单独低并发重试仍失败 | 探针超时/断言边界需排查，不能简单归于整机忙 |
| `tests/unit/provedores-x-registry.test.ts` | 空 key 检查遍历 provider，超过 30 秒；单独低并发重试仍失败 | Validator 的离线契约/测试超时需排查 |

Pi runtime、边界、审批续跑等测试被全量 unit 配置包含；这提供测试替身层面的证据，不代表外部副作用已经真实端到端执行。

### 数据库不变量

`TEST_DB_IMAGE=crm-agent-services-postgres:15.8.1.085 pnpm test:db`：264 个文件，259 passed / 5 failed；2,212 个 case 中 2,173 passed / 37 failed / 1 expected fail / 1 skipped，658.11s。临时容器限额 384MB，退出诊断 oom=false；错误不是容器 OOM。install 与 update 均实际应用 baseline，ON_ERROR_STOP=1。

| 失败组 | 数量 | 结论 |
|---|---:|---|
| `cliente-nasce-do-agendamento.test.ts` | 30 | 实际 SQL 抛出 invalid configuration parameter name `pi-native.cliente_pela_agenda`。baseline 和 migration 都使用该名字；需要安全迁移到合法 GUC 名称并回归日程/联系人/标签链路 |
| `agenda-meet-export.test.ts` | 4 | 测试 admin 链式替身缺 `.is()`，新 customer memory 导出分支无法执行；需补替身及覆盖，不等于真实 Supabase 不支持 `.is()` |
| `agenda-meet.test.ts` | 1 | Google failure 场景预期 meeting_last_error=google_failure，实际 null；未确定唯一根因 |
| `rls-completude-varredura.test.ts` | 1 | 17 张新增表未登记跨租户行为证明；需逐表补证明或登记已经存在的专用证明，不能靠增加无理由豁免 |
| `lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts` | 1 | 扫描器未识别独立 memory privacy trigger；需结合下面行为测试修订覆盖契约，不能直接宣称数据泄漏 |

RLS 登记缺口：ai_agent_eval_reports、ai_customer_memories、ai_integration_settings、ai_internal_event_inbox、ai_internal_identity_challenges、ai_internal_platform_tenants、ai_internal_platform_users、ai_internal_question_outbox、ai_mission_commands、ai_mission_events、ai_mission_explicit_offers、ai_mission_internal_inputs、ai_mission_internal_threads、ai_mission_wakes、ai_missions、ai_wiki_evidence、ai_workbench_send_decision_receipts。该结果是证明登记不完整，不是已经发现跨租户可读漏洞。

另外，`test:db:update` 在带 10 条合成数据的临时 PostgreSQL 15 上通过：数据数量不变，当前 view OID 不变，旧版带 title 的 view 成功迁移且下一次升级保持 OID。

### 浏览器验收

原配置选了 11 个关键模块、28 个测试，已报告 9 次失败后停止继续重复同一登录前置失败；退出 130，**不是完整 28 项的最终统计**。初始 localhost 导航有超时；用新增 `tests/e2e/configs/acceptance.config.ts` 固定 127.0.0.1 并禁用浏览器代理后，能够正常访问页面。

直连登录测试仍出现两项失败，原因是脚本查找 `/entrar/i`，当前按钮为“登录”。该次运行 1 passed / 2 failed / 2 did not run，达到 max-failures 停止。没有修改断言来隐藏问题。

只跑语言无关的现有断言：匿名访问重定向、登录无 serious/critical a11y 问题、首页 200 且无 console/page error，**3 passed / 12.3s**。另用真实浏览器中文表单实测非法凭据提示；这不能替代尚未跑通的 MFA、RBAC、联系人 CRUD、商机 CRUD 和审批 UI 全流程。

页面读取冒烟覆盖联系人、销售漏斗、任务、记忆、知识源、运行记录；确认的是页面入口与读取，不把页面加载当作业务闭环。

### 构建与其他门禁

- typecheck：通过；新增验收文件再次检查。
- eslint：0 errors / 475 warnings；新增验收文件单独检查。
- lint:channels：通过，62 个已知项；lint:role-rank：通过。
- test:shell：通过。
- 新生产 build：通过，包括编译、TypeScript、57 个静态页面、standalone 产物及本地 Supabase URL 正向检查。
- 构建在独立临时源码副本进行，避免覆盖 3009 正在服务的 `.next`。首次把 node_modules 软链接到副本外，Turbopack 拒绝越过 filesystem root；复制实际依赖目录后，未修改产品构建配置的完整构建通过。该首次失败属于隔离验收仪器，不是产品构建缺陷。

## 修复优先级与复验条件

1. **P1：可靠交付多 Agent 结果。** 分析 specialist partial 和主 Agent 空最终答复；限制无效 claims 膨胀，保证最终结构化汇总有证据、冲突与缺口。相同真实案例必须得到可用结果，不允许把空答案包装为 completed。
2. **P1：让已确认记忆被正确消费。** 对齐工具 description、来源 authority、确认/版本/范围信息和提示；真实单 Agent 正确列出偏好，同时维持“客户上下文≠公司政策”。重跑 Judge，不手工提高评分。
3. **P1：修复 PostgreSQL GUC 名称。** 做兼容迁移，回归 30 个相关测试及整套数据库门禁；仅全文品牌替换不能保证数据库标识合法。
4. **P1：补齐隔离与隐私证明。** 逐表复核 17 张新增表的权限和范围；更新证明登记。隐私 scanner 必须认识有效触发器，并继续保持行为级反例/控制，不用豁免掩盖问题。
5. **P2：修复测试契约。** 中文 selector/MFA、导出链式替身、Meet failure、离线 provider 校验、health 探针、证据引用解析；在本机与标准 CI 环境分别复验，保持安全 guard。
6. **P2：关闭运营边界。** Wiki ingest 页数/预算/人审，4GB VM 的持续运行与故障恢复、真实可逆 CRM 写入、外部动作拒绝/批准/恢复、跨组织 Proposal/Run 细粒度 API、备份恢复和标准部署矩阵。

通过条件：两条真实任务达到有效业务结果、关键门禁全绿、相关 E2E 真正走过断言、外部副作用/恢复路径有明确的受控验证记录。内部 demo 读链路的通过不构成上线授权。

## 本地复现与日志

可复现入口：

```bash
pnpm typecheck
pnpm lint
pnpm lint:channels
pnpm lint:role-rank
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:1 pnpm test:unit --maxWorkers=2
pnpm test:shell
TEST_DB_IMAGE=crm-agent-services-postgres:15.8.1.085 pnpm test:db
TEST_DB_IMAGE=crm-acceptance-pg15:20261003 pnpm test:db:update
TEST_DB_IMAGE=crm-acceptance-pg15:20261003 pnpm test:db tests/invariants/ai-memory-privacy-acceptance.test.ts
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm exec playwright test -c tests/e2e/configs/acceptance.config.ts tests/e2e/smoke.spec.ts tests/e2e/auth.spec.ts --grep 'home returns|anon GET|a11y'
```

`crm-acceptance-pg15:20261003` 仅继承已缓存 PostgreSQL 15 测试镜像并设置合成测试 PGPASSWORD，让旧 update harness 的 TCP 探针可鉴权；不改变实际服务认证方式。默认标准镜像、Node 22、PG17 矩阵仍应在 CI 复验。

完整本地日志在 `/tmp/crm-acceptance-*-20261003.log`：unit、db、db-update、memory-privacy-db、build、e2e、e2e-direct、e2e-locale-independent、real-multi、real-single、real-single-eval、langfuse-multi、langfuse-single、memory、wiki、cancel-detail、builtin-ui 等。日志与浏览器 trace ZIP 没有批量上传 GitHub，避免夹带登录态/请求头；仓库只交付脱敏摘要及可复现入口。

## 本轮新增的隐私行为验收

`tests/invariants/ai-memory-privacy-acceptance.test.ts` 专门调用实际 `fn_lgpd_cascade_redact_contact`，不是只扫 SQL 文本：正向控制两条活跃记忆、匿名化后本地内容清空并保留远端清理凭据、重复匿名化不重复发事件、跨组织联系人拒绝且另一组织记忆不变。**4 passed / 1.14s，命令退出 0。** 初次探针把 psql 的 SET 回执一起当作 JSON 解析，3 passed / 1 个解析失败；将探针设为 quiet 后重跑通过，没有修改业务函数或削弱断言。

这里只证明本地内容清除和清理事件；没有用真实 Mem0 执行新的删除，也不能把 remote_deleted_at=null 当成远端已删除。
