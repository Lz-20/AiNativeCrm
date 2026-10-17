# DuoAgent Runtime 与 Eval 真实模型验收（2026-09-28）

## 结论

当前实现达到可交付的 **bounded multi-Agent runtime + durable Eval Beta**：它不是通用 Agent
图编排器，而是一个有界、可恢复、可审计、父级单写者的 CRM 协作 Harness。真实 CRM 工具、
真实 `opencode / space-bunny-free` 模型、持久化 child run、结构化 claims、确定性门禁与语义
Judge 已在同一条运行上闭环。

生产就绪度判断：

| 子系统               | 判断                       | 依据                                                                       |
| -------------------- | -------------------------- | -------------------------------------------------------------------------- |
| Durable Harness      | 8.5/10，Beta 可交付        | 队列、取消、预算、确认/恢复、事件回放、child lease/fencing                 |
| Multi-Agent runtime  | 8.5/10，Beta 可交付        | 三 specialist 并行、父级 join/synthesis、single-writer、部分成功、重试复用 |
| Eval 基建            | 8/10，Beta 可交付          | revision 5、指纹缓存、7 类 golden case、56 claims、真实语义 Judge          |
| CRM / Wiki grounding | 6.5/10，接口成熟但数据不足 | Wiki/RAG contract 已接入；演示组织没有 published source，因而正确降级      |

仍不宣称“无人值守生产级”：还需要长期人工标注集、更多真实 Wiki 样本、provider/model
矩阵回归，以及 worker 进程被强杀后的端到端恢复压测。

## 真实输入

- Parent Run：`b030b8d5-ba15-4168-8407-1ad886ce1743`
- Built-in Agent：CRM 主管 Agent
- Provider / Model：`opencode / space-bunny-free`
- Mode：`inspect`
- Scope：一个 demo contact、lead 与 pipeline
- 用户任务：

> 请对当前选中的商机做一次完整审查：核对客户沟通事实、商机阶段与跟进风险，并查询
> “商机成交审批政策”。综合独立证据给出事实、冲突、缺失材料和下一步建议。如果知识库
> 没有证据，必须明确写出知识缺口。只读，不要修改 CRM。

## Agent 拓扑与真实 tool calling

```text
CRM Supervisor (parent, only writer)
├─ customer_evidence      [inspect-only]
│  ├─ crm_get_contact
│  ├─ crm_list_conversations
│  └─ crm_get_conversation_history
├─ opportunity_diagnosis [inspect-only]
│  ├─ crm_get_lead
│  └─ crm_list_followups / pipeline context
└─ policy_advisor        [inspect-only]
   ├─ crm_get_org_memory
   └─ crm_search_knowledge("商机成交审批政策")
             ↓ join
CRM Supervisor synthesis
```

持久化事件计数显示 specialist 共完成 7 次工具调用，父级再完成 1 次读取，共 **8 completed / 0
error**。三个 specialist 的开始时间相差约 4ms，模型调用并行；父级只在三者进入终态后综合。

| Specialist              |      终态 | Tool calls | Structured claims | 主要 observation                                                             |
| ----------------------- | --------: | ---------: | ----------------: | ---------------------------------------------------------------------------- |
| `customer_evidence`     | completed |          3 |                29 | open WhatsApp 会话、1 条未读、客户要求真人、历史消息接口为空                 |
| `opportunity_diagnosis` | completed |          2 |                27 | 商机阶段/金额/负责人、跟进与 pipeline 对照                                   |
| `policy_advisor`        |   partial |          2 |                 0 | memory 空；knowledge retrieval unavailable，缺 `published_knowledge_sources` |

`partial` 是预期且有意义的终态：模型没有把空知识库伪装成“没有审批要求”，而是把缺失
政策列为阻断材料。父级最终输出明确区分“无记录”“取数失败”和“无知识证据”。

## 真实输出摘要

父级输出为完整 Markdown 报告，包含四部分：可引用事实、冲突与风险、明确知识缺口、待人工
执行的下一步。关键结论包括：

- 商机仍处于首阶段，金额 128 万 CNY，预计成交日为空；同一 pipeline 的演示数据仅作对照。
- 客户最近一条消息明确要求真人服务，但会话未读且未形成可确认的排队/接管状态。
- 历史消息接口返回空，报告将其标为取数失败，没有推断“客户没有异议”。
- “商机成交审批政策”检索状态为 unavailable，明确指出无法判断 128 万是否触发审批。
- 所有建议都标为待人工执行；本次 `inspect` run 没有修改 CRM。

语义 Judge 还发现两处值得继续改善的表述：部分 pipeline 对照超出被保留的 observation
截断范围；把同批时间戳解释成种子数据应明确写成推论，而不是事实。这说明 Judge 在安全门禁
之外能提供语义层质量反馈。

## Eval 结果

### 确定性 profile revision 5

| 指标                       |                结果 |
| -------------------------- | ------------------: |
| 最终 verdict / score       | `needs_review` / 87 |
| Tool calls / errors        |               8 / 0 |
| Specialist runs / failures |               3 / 0 |
| Structured claims          |                  56 |
| Knowledge searches         |                   1 |
| Grounded Wiki evidence     |                   0 |

`needs_review` 的原因是 policy specialist 为 `partial`、该 specialist 无 claims、组织没有可引用
Wiki 证据。确定性评测不尝试用语言流畅度掩盖这些事实。

### 真实语义 Judge

- Judge：`workbench_semantic_v1:opencode:space-bunny-free`
- Verdict / score：`pass` / 88
- Provider call：19,894ms；9,861 input、2,114 output、5,260 cache-read tokens
- 提交方式：模型调用唯一的 `submit_semantic_evaluation` 内存工具；参数由 Zod 完整校验
- 最终合成：仍为 `needs_review` / 87，因为语义 Judge 不允许升级确定性门禁
- 第二次相同 POST：`cached=true`，没有再次调用模型

真实 E2E：

```text
tests/e2e/agent-semantic-judge-real-model.spec.ts
1 passed (41.7s)
```

## Runtime 恢复与 fencing

Migration 0385 为每个 running specialist 增加 `execution_attempt_id` 和 lease expiry，并通过
service-role-only RPC 原子 claim。数据库事务验证：

```text
first claim                     = 1 row
reclaim before lease expiry     = 0 rows
reclaim after lease expiry      = 1 row, new attempt token
finish with stale attempt token = 0 rows
finish with current token       = 1 row
RPC privileges                  = anon 0 / authenticated 0 / service_role 1
```

这解决了 worker 崩溃/重试时“双执行者都认为自己拥有 child”的核心竞态。完成的 child 在父级
重试时直接复用；未完成 child 只有 lease 到期后才能由新 attempt 接管；旧 worker 无法覆盖新结果。

## 真实回归中发现并修复的缺陷

1. child `observations` 被写成对象，但数据库契约要求数组；修为版本化 envelope 数组并补单测。
2. specialist 缺少执行 lease，worker 重试存在 stale completion 风险；增加原子 claim/fencing。
3. reasoning 模型在 1,500/4,000 token 上限前耗尽输出，普通 JSON Judge 三次分别出现 invalid、
   timeout 和 missing；改为受控 schema tool 后一次成功。
4. provider reasoning 中可能先出现花括号；兼容 fallback 改为识别引号与转义的平衡 JSON 扫描，
   并保留 typed fail-closed 错误。

## 复现

```bash
CRM_EVAL_RUN_ID=b030b8d5-ba15-4168-8407-1ad886ce1743 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
pnpm playwright test tests/e2e/agent-semantic-judge-real-model.spec.ts --reporter=line
```

该测试只对 loopback Supabase 和 demo 组织运行；真实凭据留在组织的加密 credential store，不写入
测试、报告或事件。Docker/Colima 验收期间保持 **2 CPU / 4 GB**，没有为通过测试提高资源。

## 后续成熟化优先级

1. 建立有人工标注答案的长期校准集，跟踪 Judge 与人工分歧，而不仅是单次分数。
2. 发布最小真实 Wiki policy fixture，再跑一条 `groundedEvidenceItems > 0` 的真实模型回归。
3. 用进程级 kill/restart 做 worker 恢复 E2E，覆盖 lease 到期前后与父取消传播。
4. 扩展 provider/model contract matrix，验证结构化 tool submission、取消与 token 计量一致性。
