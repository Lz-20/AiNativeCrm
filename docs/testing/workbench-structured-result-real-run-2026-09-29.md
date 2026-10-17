# Workbench 结构化结果真实模型验证（2026-09-29）

## 结论

本地演示组织中的只读 CRM 任务完成了真实模型、真实 CRM 工具、结构化结果提交和持久化事件的端到端链路。最终状态是 `partial / missing_material`，不是业务目标已完成：模型明确列出未核实材料，也没有提出或执行写入。

`pi-coding-agent` 的职责边界在此运行中保持不变：Pi 负责模型和工具循环；CRM 负责运行状态、预算、结果端口与事件。补交轮只暴露内存中的 `submit_workbench_result`，不暴露 CRM 工具。

## 真实运行证据

### Eval revision 7 字段断言回归

Run `936aab3a-8d16-4399-a4b1-a8672dee545f` 在同一条真实模型 Playwright 用例中完成：6 次 CRM 工具调用、4 条结构化引用、11 个与成功工具观察一致的安全字段断言，0 个冲突或无法核验的断言。模型调用 2 次，实际输入与输出合计 24,409 / 32,000 token；结果仍为 `partial / missing_material`，确定性评测仍为 `needs_review`，无动作提案。真实字段断言只证明模型提交的有限标量值与本次工具观察一致，不证明自由文本 claim、运行后的当前状态或业务目标完成。

此次回归通过 `tests/e2e/agent-workbench-structured-result-real-model.spec.ts`，并验证 profile revision 7 不复用 revision 6 的评测缓存。测试 worker 已平滑退出；没有向仓库写入模型凭据或客户正文。

修复后定向回归为 7 个测试文件、59 个测试用例通过；`pnpm typecheck`、`pnpm build` 通过，`pnpm lint` 退出码 0（全仓输出 461 条警告）。首次全量 `pnpm test:unit` 在修改围栏前启动，最终 1,267 个文件通过、2 个文件中的 3 个用例失败：新增真实模型 spec 尚未列入 `FORA_DO_CI`，以及领域测试直接导入 Pi 适配器。已登记该 spec 并将 Pi 适配验证移到 `lib/agent-runtime/pi/`；两处围栏及相关单测随后全部定向重跑通过。完整单测尚未在修复后的快照上再次运行，因此不把全量套件报告为绿色。

### Eval revision 6 联调回归

新增来源检查后，真实 Run `95423944-695b-4f8d-8704-1040fb6c87fe` 在同一条 Playwright 用例中完成了结构化提交和 `GET /api/v1/ai/workbench/runs/:id/evaluation`：7 次 CRM 工具完成、5 条模型引用、6 项缺失信息、1 次模型调用，实际使用 29,900 / 32,000 token。结果是 `partial / missing_material`，确定性评测为 `needs_review`。来源检查未发现未观察到的引用；评测仍明确给出 `structured_claims_not_independently_verified`，因为引用 UUID 的来源被观察过不等于自由文本 claim 得到了字段级核验。

这次回归同时验证了新的 profile revision 6，不会重用 revision 5 的旧评测缓存；测试 worker 已平滑退出。

### 结果提交与预算回归

- 环境：loopback Supabase/Postgres，演示组织，Chrome，真实 `opencode / space-bunny-free`；模型凭据来自组织加密配置，未写入测试或事件。
- 最终代码回归 Run：`dc458785-58fc-4503-a762-96efe02e00ec`。
- 任务：只读检索演示联系人及关联商机阶段，提交带证据、缺口和下一步的结构化结果；不得修改或发送。
- 运行：7 次 CRM 工具完成；模型首轮提交，`resultRecovery=not_needed`；无 action proposal。
- 结果：`trust=model_submitted`，3 条证据引用、5 项缺失信息；`error_code=missing_material`。
- 用量：1 次真实模型调用；26,362 输入 token、2,817 输出 token，合计 29,179，低于该 Run 的 32,000 token 预算；`llm_calls.cost_cents=0`，产品事件 `usage_reported.costCents=0`。
- 最终 Run 的 3 条 `contact`、`lead`、`conversation` 引用 UUID 均在同一组织的相应 CRM 表中存在；先前补交 Run `944ba1c7-8efd-4fc0-8451-0990a8b668db` 的 7 条引用也通过了存在性检查。这不等于逐条事实声明得到核验。

首次尝试中的同类 Run `454ccb55-ae92-418f-bb91-2947da3eeecb` 因模型未主动提交、旧价格表把成本记为 `NULL`，补交被预算保护拒绝，终态为 `partial / structured_result_missing`。修复后按 [OpenCode 官方价格表](https://opencode.ai/docs/en/zen/)为该 provider 的精确模型 ID 记零成本；官方注明免费为限时，代码中的零价核验窗口在 2026-10-06 00:00 UTC 失效，此后如未重新核价，成本回到 `NULL` 并继续失败关闭。

回归还发现事件脱敏规则把数值型 `inputTokens` 和 `outputTokens` 误判为密钥。已改为仅放行 `usage_reported` 的非负数值型 token 计数；疑似密钥字符串继续脱敏。

补交 Run `944ba1c7-8efd-4fc0-8451-0990a8b668db` 虽成功提交，但它使用 14,028 输入 + 2,403 输出 token，处于 24,000 预算内。随后同一测试的 Run `01152022-500c-425e-b43a-4c1445220b81` 则使用 24,729 输入 + 2,102 输出，合计 26,831，**超过当时的 24,000 token 预算**。根因是补交前只检查余额为正，没有为重复上下文预留输入空间。现已在补交前依据上一轮实际输入预留空间，补交最多一轮，并把内置 CRM 情报员默认 token 预算调为 32,000（成本预算仍为 50 美分）。最终代码的 Playwright 用例对实际总用量设置了预算断言；它证明本次运行未超额，不代表任意 provider 都有精确预检。

## 验证命令

```bash
pnpm exec vitest run lib/ai/agents/workbench-events.test.ts lib/agent-engine/edge/llm/pricing.test.ts lib/ai/agents/workbench-result-recovery.test.ts
pnpm exec vitest run lib/ai/evals/evidence-provenance.test.ts lib/ai/evals/evaluate-run.test.ts lib/ai/evals/golden-corpus.test.ts lib/ai/evals/semantic-judge.test.ts
pnpm typecheck
pnpm build
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm exec playwright test tests/e2e/agent-workbench-structured-result-real-model.spec.ts --project=chromium --reporter=line
```

三组单测、类型检查、生产构建和真实模型 Playwright 用例均已通过。Playwright 用例只允许 loopback Supabase；未配置 Chrome 路径时，迁移后的机器因缺少 Playwright 自带浏览器而在启动阶段失败，那次失败并未进入业务流程。

## 未完成

- Eval revision 7 已对模型显式提交的有限安全字段断言与本次工具观察做确定性比较；没有提交断言的历史结果、自由文本 claim、跨字段业务推论和运行后状态仍缺独立核验。
- 演示组织缺少已发布 Wiki 知识源，知识支撑未在本场景中证明。
- 只覆盖一个真实 provider/model 和只读任务；外部动作确认、长期 Mission 的业务完成条件需要分别验收。
- 免费模型价格会变化，过期后必须重新核价或接入可信的动态定价来源，不能把未知成本当作零。
