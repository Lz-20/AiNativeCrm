# Workbench 结构化结果契约

真实任务：给定一个已选定的 CRM 对象与委托目标，Agent 读取证据并可提出动作；用户需要看见有依据的结论、缺口和下一步，而不是把模型的自由文本误当作已执行的 CRM 事实。

## 执行边界

`submit_workbench_result` 是 CRM 提供给 Pi 的内存结果端口（`lib/ai/agents/workbench-result-submission.ts`），不是 CRM 工具或外部副作用。它使用 Zod 输入 schema，并在 `execute` 时再次校验；每次模型调用只接受一次。`runModelCall` 将它与受控 CRM 工具一同交给运行时，Pi 原始消息仍只保留在 service-only `ai_agent_run_states`。工具只返回 `accepted`，不批准、发送或修改业务数据。

提交内容版本 1：`summary`、最多 12 条带 UUID 的 `evidence` 引用、最多 8 条 `missingInformation`、`nextStep`、建议的 `wakeCondition`。每条引用可选填最多 4 个 `assertions: [{ field, equals }]`；仅允许提交联系人布尔状态、商机状态/阶段/金额/币种/预计成交日，以及会话状态/渠道/未读数等有限标量字段，不接受姓名、电话或消息正文。该字段是兼容旧结果的可选扩展，因此文档版本仍为 1。提交后本轮模型循环停止；CRM 仍要处理本轮提出的工具提案，决定自动写入、等待审批或部分完成。模型提交的引用和断言都是待核验材料；建议唤醒条件不会直接设置 Mission 状态。

结果写入 `ai_workbench_runs.result_document`，带 `trust: model_submitted`。已有 `final_text` 只取结构化摘要，页面把它与提案、发送凭证和业务验收分开显示。未调用提交工具时，旧文本提取仅提供诊断性回退，Run 标记为 `partial / structured_result_missing`；提交了缺失材料时标记为 `partial / missing_material`。历史 Run 的 `result_document` 可为 `NULL`。

数据库迁移 0390 对版本、信任标签和顶层类型做约束；应用在提交时作完整 Zod 校验。两条模型路径（首轮和审批后续跑）都使用同一契约。工作台详情 API 继续按组织和 manager 角色读取，原始 Pi continuation 不随结果返回。

## 验证现状与缺口

单元测试覆盖 schema、一次性提交、只开放结果工具的有界补交和 CRM→Pi 工具适配形状；临时 PostgreSQL 测试覆盖约束、组织隔离和重放安装。2026-09-29 已用真实 `opencode / space-bunny-free` 模型完成只读 CRM 端到端运行，详见[运行记录](../testing/workbench-structured-result-real-run-2026-09-29.md)。一次真实运行在首轮未提交后由 Harness 仅开放 `submit_workbench_result` 补交；最终代码的回归则由模型首轮直接提交。两条路径均得到 `model_submitted` 结果及明确的 `missing_material` 部分终态。

Eval revision 7 对结构化引用增加有限字段核验：只把本次成功 CRM 工具观察中的对应对象 ID、持久化 specialist Run ID 或事件 ID 计为已观察；未观察到的引用使确定性评测失败。对联系人、商机、会话的显式安全字段断言，用同一运行的工具结果按字段逐项比较；多个读取结果取最后一次出现该字段的值，后续稀疏结果不会抹去已观察值。值不一致使确定性评测失败；字段缺失、来源类型不适用或没有成功读取时标为无法核验。评测报告只保存计数，不复制断言值。旧结果没有断言仍可解析，但引用存在仍不能证明自然语言 claim；即使所有断言一致，claim、运行后当前 CRM 状态和独立业务结果仍需人工/语义复核。不同 provider 的结构化工具遵循度与长期业务验收尚未完成。

若首次模型调用的成本未知且 Run 设置了成本预算，补交轮不会继续调用模型；事件以 `resultRecovery=skipped_unknown_cost` 区分这一情况与真正耗尽预算。已有 CRM 读取仍保留在持久化状态中，终态不会伪装为成功。

补交前会根据上一轮实际输入量预留上下文与最低输出空间，并把补交限制为最多一轮模型调用。该检查是保守估算，不是 provider 精确 token 预检；首次调用或分词差异仍可能越过预算，端到端测试已加入实际用量断言。
