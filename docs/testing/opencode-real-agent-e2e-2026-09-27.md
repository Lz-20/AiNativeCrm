# OpenCode Zen 真实 Agent 测试记录

- 日期：2026-09-27
- 模型：OpenCode Zen `space-bunny-free`
- 数据：本地 Supabase 的合成演示 CRM；未读取真实客户租户，未连接 WhatsApp 外部发送。
- 范围：四个内置 Agent 的工作台 E2E。所有记录均为已持久化 Run；只整理用户任务、工具调用、工具结果摘要和最终回复，不导出模型内部推理文本或凭据。
- 判定：四个场景最终均通过 Playwright；情报员的首次 UI 等待因 Worker 未启动而超时，队列后来完成，随后单独重跑通过。详见各场景说明。

## 1. CRM 情报员：查联系人与关联商机

- Run：`53cd00d9-84a3-4b45-af3c-d959ff7a3bad`（重跑通过）；另有首次排队运行 `7f7d7f08-76fe-4cde-8428-ab407043c2df`，Worker 启动后也完成。
- 模式：只读（`inspect`）
- 输入：

> 请调用 crm_search_contacts 只读搜索工具，精确查找姓名‘林晓梅’，然后读取该联系人的资料和关联商机。报告 CRM 中能核实的姓名与商机阶段，并说明依据。只读，不要修改任何内容。

### 工具调用（重跑记录）

| 顺序 | 工具 | 关键参数 | 结果摘要 |
|---|---|---|---|
| 1 | `crm_search_contacts` | `query="林晓梅"`, `limit=10` | 唯一命中 1 位联系人 |
| 2 | `crm_get_contact` | 搜索命中的 `contact_id` | 联系人姓名与展示姓名一致，来源为 demo |
| 3 | `crm_list_conversations` | 同一 `contact_id`, `limit=20` | 额外读取到 1 个 open 演示会话；本任务并未要求会话信息 |
| 4 | `crm_list_leads` | `limit=100` | 列出 5 条商机 |
| 5 | `crm_get_conversation_history` | 上述会话 ID, `limit=30` | 消息列表为空；属于额外读取 |
| 6 | `crm_get_lead` | 关联商机 ID | 标题“林晓梅 — 企业官网改版”，阶段“新客户”，状态 `open`，`value_cents=1280000` |

### 输出与观察

首次排队运行最终生成了一份中文核查报告：确认联系人“林晓梅”及一条通过 `contact_id` 关联的“企业官网改版”商机，阶段为“新客户”；说明预期成交日期为空、没有写入 CRM。重跑运行的 `final_text` 字段却只保存了“Found a linked opportunity. Confirming with a direct lead read.”一类中间英文句子，未保存完整的中文最终报告。E2E 只断言最终文本非空和工具轨迹存在，因此该场景虽通过，最终输出持久化质量仍需修复。

首次排队运行中可见的最终答复摘录（已省略无关个人字段）：

> 核对结果：林晓梅存在，且有 1 条关联商机。联系人搜索唯一命中；按 `lead.contact_id` 与联系人 ID 匹配，并通过 `crm_get_lead` 复核。商机标题为“林晓梅 — 企业官网改版”，阶段“新客户”，状态 `open`，金额 ¥12,800。预期成交日为空。本次没有修改 CRM。

## 2. 销售运营 Agent：可逆地改商机标题

- Run：`bf75be53-a4f7-46ad-98a0-49030f7830a8`
- 模式：执行（`act`）
- 输入：

> 只处理当前选中的商机。先读取它，再仅把标题改为“林晓梅 — 企业官网改版 [E2E reversible check]”。只允许调用 crm_update_lead 修改 title，不要改阶段、金额、联系人或其他字段，不要创建任务或发送消息。完成后报告改动字段。

### 工具调用与 Harness 结果

1. `crm_get_lead({lead_id: 当前选中商机})`：读取原标题、阶段“新客户”、金额和联系人关联。
2. `crm_list_followups({lead_id, limit:20})`：返回空列表。
3. `crm_update_lead({lead_id, title: "林晓梅 — 企业官网改版 [E2E reversible check]", expected_updated_at: ...})`：Harness 判定 `allowed_reversible_write`，先暂存，再应用；事件记录仅 `title` 字段变化。
4. `crm_get_lead({lead_id})`：复读确认标题已更新，阶段、金额、联系人等未变。
5. E2E 随后调用业务补偿撤销；proposal 最终状态为 `undone`，演示商机恢复原标题。

### 输出摘要

Agent 报告了变更前后标题，并确认没有移动阶段、创建跟进或发送消息。其回复先说明写入已暂存，再在恢复执行后报告写入成功；Playwright 最后验证撤销可用。**最终 CRM 状态为原始标题**，不是 E2E 临时标题。

模型答复中的关键句：

> 改动字段：`title`，从“林晓梅 — 企业官网改版”变为“林晓梅 — 企业官网改版 [E2E reversible check]”。需要我回退标题的话告诉我，我按单字段方式改回。

这段回复之后，E2E 测试另行调用 Harness 补偿撤销；撤销不是模型回复中已经发生的动作。

## 3. 客户沟通 Agent：转人工须确认，拒绝后不执行

- Run：`34b527a9-a920-4944-b071-c15188463fce`
- 模式：执行（`act`）
- 输入：

> 当前选中的演示会话预览明确显示客户要求真人客服。必须调用 crm_request_human_handoff 为这个精确 conversation_id 创建待确认提案；reason 用 customer_requested_human，urgency 用 high，客户诉求用中文简洁概述，target_user_id 留空由系统路由。该工具在 Harness 批准前不会执行转交。不得只写建议，不要声称已经转交。

### 工具调用与 Harness 结果

1. `crm_get_conversation_history`：消息历史为空。
2. `crm_get_contact`、`crm_list_conversations`：找到一个 open 演示会话；预览为“我想和真人客服沟通，请不要让机器人继续回复”，未读数为 1。
3. `crm_request_human_handoff` 第一次调用参数不符合 schema（`o_que_tentei` 子项混入了不允许字段），工具返回错误，未执行转交。
4. Agent 修正参数后再次调用同一工具，Harness 接受为待人工确认提案（`requiresHumanConfirmation=true`）。提案包含 `reason=customer_requested_human`、`urgency=high`，并要求转接真人。
5. E2E 拒绝提案，记录 `human_confirmation_received: reject`；proposal 状态为 `rejected`。没有发生转接，也没有外发消息。

### 输出摘要

Agent 最终说明提案已被拒绝、转人工未发生。记录里的 `final_text` 前部混有 schema 错误说明和中间英文推理片段；可见的中文部分正确声明“未转接、未向客户发送消息”。会话历史为空，因此对客户诉求的依据来自工作台消息预览，而非历史消息工具结果。

可见答复的核心声明：

> Harness 人工确认环节拒绝了该提案，因此转交动作没有执行。客户未被转接，也没有向客户发送消息。

## 4. CRM 主管 Agent：漏斗与跟进检查

- Run：`5476c0f5-a333-47a7-9c43-912bf41ff761`
- 模式：只读（`inspect`）
- 输入：

> 分别调用一次 crm_list_leads 和 crm_list_followups 获取概览，然后立即用两三句话总结一项有数据依据的运营风险。不要重复调用，不要修改 CRM。

### 工具调用

| 顺序 | 工具 | 关键参数 | 结果摘要 |
|---|---|---|---|
| 1 | `crm_list_leads` | `status="open"`, `limit=20` | 4 条 open 商机，阶段分别为“方案沟通”“方案沟通”“已联系”“新客户”；金额原始字段以分为单位（`value_cents`） |
| 2 | `crm_list_followups` | 赵强商机的 `lead_id`, `limit=20` | 该商机的跟进记录为空；只核验了 1/4 条商机 |

### 模型输出与事实校验

Agent 将赵强、王芳、林晓梅、陈伟四条商机的金额报告为 ¥520,000、¥245,000、¥128,000、¥76,000，合计 ¥969,000，并据此称赵强占 54%。但是 CRM 返回的 `value_cents` 分别是 5,200,000、2,450,000、1,280,000、760,000；按 CNY 分转换（除以 100）应为 **¥52,000、¥24,500、¥12,800、¥7,600，合计 ¥96,900**。因此模型的金额整体放大了 10 倍，占比结论碰巧仍接近，但金额陈述错误。

输出原句摘录：

> 概览结果（4 个 open 商机）：赵强 ¥520,000、王芳 ¥245,000、林晓梅 ¥128,000、陈伟 ¥76,000，合计约 ¥969,000。最大的单子没有推进机制。

Agent 有说明跟进只核验了赵强一条，也没有修改数据。该测试目前只验证跨工具读取与运行完成，没有断言金额计算正确；建议补一条金额单位/汇总准确性断言。

## 总结

- 真实模型链路与 Harness 工具调用均发生；运行日志中的 provider/model 为 `opencode / space-bunny-free`。
- 可逆写入展示了暂存、应用、审计字段差异和补偿撤销；外部 handoff 展示了 schema 拒绝、人工确认门和拒绝后不执行。
- 本轮暴露的输出质量问题：情报员重跑未持久化完整最终答案；主管 Agent 金额单位换算错误；客户沟通 Agent 第一次提案参数不符合 schema。
- 原始 E2E 的 `usage_reported` 对 token 字段做了脱敏，且 provider 日志的 `cost_cents` 为 null；因此本报告不推断实际费用。
