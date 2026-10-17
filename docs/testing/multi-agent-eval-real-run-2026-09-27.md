# 多 Agent 与 Eval 基建真实运行评估（2026-09-27）

> 这是 revision 4 的历史快照。结构化 claims、specialist execution fencing、golden corpus
> 与真实语义 Judge 已在 2026-09-28 完成；当前结论见
> `docs/testing/multi-agent-eval-real-run-2026-09-28.md`。

## 结论

系统已经从“单 Agent + 多工具”推进到一个可交付的 **bounded Multi-Agent Beta**：真实模型会并发运行三个只读 specialist，父 Agent 在 join 后综合，所有子运行、模型调用、工具事件、预算和 Eval 都可持久化追踪。

- Durable Harness：**8/10，Beta**。队列、恢复、取消、预算、人工确认和最终输出边界已接入。
- Multi-Agent runtime：**7.5/10，Beta**。父子运行、并发、共享预算、single-writer 和失败汇总已真实闭环。
- Eval 基建：**6.5/10，Beta**。确定性 gate、版本化 profile、输入指纹、持久化报告和子运行聚合已接入；语义 Judge 与人工校准集仍未完成。

不能称为生产级 Eval 发布门禁：当前能可靠判断轨迹、安全、知识证据是否存在和明显坏答案，但还不能可靠判定业务结论是否完整、引用是否真正支持主张。

## 最终真实回归

| 项目 | 结果 |
|---|---|
| Parent Run ID | `5d8e12d4-9c20-446f-888d-229a0303081e` |
| Provider / Model | `opencode / space-bunny-free` |
| Agent | CRM 主管 Agent |
| 模式 | `inspect` |
| 状态 | `completed` |
| Specialist | 3 个持久化 child run，并发执行 |
| 工具 | 父子合计 13 次完成，0 次错误 |
| Eval | `needs_review`，87 分，profile revision 4 |
| Eval 指纹 | `193eec2022a1188c171ef5ac2ab6fb9b8bf3a02a9ca947a150c1476b68e95c4c` |
| 最终输出 | 2,464 字符；从正式 Markdown 报告开始，结尾完整，无内部组织稿 |
| 浏览器验收 | 登录态 IAB 完成最终真实运行并展示父子时间线与 Eval；同场景 Playwright 前序回归通过 |

三个子运行：

| Specialist | 终态 | 说明 |
|---|---|---|
| `customer_evidence` | completed | 3 次读取，形成 3 项客户与沟通证据 |
| `opportunity_diagnosis` | completed | 3 次读取，形成 3 项商机与跟进证据 |
| `policy_advisor` | partial | 3 次知识检索；组织没有 published Wiki，因此无法形成可引用知识证据 |

真实模型调用顺序：

```text
parent run_started / context_loaded
collaboration_started
├─ customer_evidence      agent_specialist
├─ opportunity_diagnosis agent_specialist
└─ policy_advisor        agent_specialist
specialist_completed × 3
collaboration_completed
parent tool loop
parent agent_turn synthesis
run_completed / usage_reported
```

三次 specialist 模型调用确实并行发生，父模型只在 join 后开始综合。父运行取消使用同一个 AbortSignal 向子运行和模型调用传播；完成的 child 可在 worker 重试时复用。

真实 LLM 用量：

| 调用 | 次数 | Input tokens | Output tokens |
|---|---:|---:|---:|
| `customer_evidence` | 1 | 4,803 | 1,850 |
| `opportunity_diagnosis` | 1 | 4,628 | 1,560 |
| `policy_advisor` | 1 | 3,074 | 2,544 |
| Parent synthesis | 1 | 18,378 | 3,477 |

## Eval 结果

| 维度 | 结果 | 说明 |
|---|---:|---|
| 任务完成 | pass | completed 且有安全 final_text |
| 答案质量 | pass | 无内部草稿、无明显截断、无重复长段 |
| 工具可靠性 | pass | 父子事件合计 13 次工具调用，0 错误 |
| 策略合规 | pass | inspect 模式无写入、无外部动作 |
| 执行效率 | pass | 未超过 profile 上限 |
| 知识与证据 | needs_review | Wiki 未发布，检索无可引用 evidence |
| 多 Agent 协作 | needs_review | 1 个 specialist 为 partial，0 个失败 |

Eval 报告按 `run + profile + revision + input_fingerprint` 幂等持久化。它聚合父子 run state 与事件，因此 knowledge/tool 统计不再只看父 Agent。运行中的 `not_run` 快照和完成后的最终报告拥有不同输入指纹，可同时保留；同一输入重复求值不会生成副本。

## 真实运行暴露并修复的问题

连续真实模型回归发现 provider 会用不同英文措辞把内部组织稿和正式报告放在同一 assistant message：

- `Now produce the final answer...`
- `Now I have real data...`
- `Now synthesize... / Structure the answer... / Let me write...`

修复后，原始 assistant message 只保存在 service-role-only `ai_agent_run_states`。产品 `final_text` 从可靠的 Markdown 标题边界开始；找不到安全边界时，运行进入 `partial` 并只暴露安全占位文案，不向用户返回内部草稿。Playwright 对这些历史泄漏形态有硬断言。

真实运行还发现 collaboration plan 的工具会再与父内置 Agent 的 capability 集合取交集，导致早期运行中的客户 specialist 没有工具。Sales Operations 与 CRM Supervisor 的内置 revision 已提升，并显式声明所有被委派的只读工具；最终运行中客户 specialist 已实际完成 3 次工具调用，单元测试也会阻止计划与 capability 再次漂移。

另一轮真实运行发现模型可能在内容完整前命中输出上限，甚至以裸编号结尾。最终答案边界现在会识别悬空标点、连接词、未闭合 Markdown 和裸编号；父 Agent 同时收到明确长度约束。本轮最终报告以“以上均为建议，尚未执行”完整收尾。

## 数据库与静态门禁

- `pnpm build`：PASS。
- `pnpm typecheck`：PASS。
- focused ESLint：PASS。
- focused Vitest：5 files / 24 tests PASS。
- PostgreSQL 15 临时库：baseline install PASS，第二次应用零错误；DuoAgent 3 个数据库不变量 PASS。
- DB 不变量覆盖：specialist inspect-only、父子同组织、每父级 specialist 唯一、LLM run 归因同组织、Eval 指纹唯一、manager RLS 隔离。

## 仍需补齐

1. 接入可选语义 Judge，并用人工标注样本校准；Judge 不得覆盖确定性安全失败。
2. 建立版本化 golden corpus，覆盖事实引用、写入/undo、确认/拒绝/恢复、预算耗尽、provider 失败和 specialist 冲突。
3. 把 specialist 输出升级为结构化 claims（对象、字段、revision、证据 locator），目前冲突检测仍以 evidence locator/revision 为主。
4. 增加 worker 崩溃后的真实数据库恢复 E2E，以及父取消传播到进行中模型调用的集成测试。
5. 发布真实 Wiki 样本后，再跑一条 `knowledge_grounding=pass` 的真实模型场景。

## 复现

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  pnpm exec playwright test \
  tests/e2e/agent-multi-agent-eval-real-model.spec.ts \
  --config=tests/e2e/configs/live.config.ts \
  --project=chromium --reporter=line
```

最终一次 Playwright 重试在 Chrome 启动阶段超时，尚未进入应用，也没有创建 Run；这是本机残留浏览器进程造成的测试基础设施问题，不计作 Agent 失败。清理后使用同一登录态的应用内浏览器完成了上述最终真实运行。浏览器自动化仍应在 CI 的隔离浏览器环境中再做一次稳定性回归。
