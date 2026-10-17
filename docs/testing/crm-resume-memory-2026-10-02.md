# Workbench 恢复记忆：真实 Pi 离线回归

日期：2026-10-02。基于 `8b84207519029d1a717eca8dcf88d2d99f8d68e6`，修复范围仅为 Pi 恢复时的系统基线优先级。

## 缺陷与修复

Workbench 恢复路径已读取当前组织记忆并记录 `context_loaded`，但 Pi 0.86.1 会优先使用持久化历史首条 system，忽略单独传入的新 `systemPrompt`。原来的 model-call mock 只验证了入参，没有证明新规则真正进入模型上下文。

适配层现在复制历史，并用本次明确传入的系统提示替换首条 system 的文本。保留后续补充 system 指令、用户历史、工具观察和私有 provider continuation；当前工具名称、描述及 JSON schema 仍由 Pi 重建。首次调用及没有 system 的旧历史不改变行为，显式空 prompt 可清除旧基线，反复恢复不累积旧版本。

## 验证结果

- 下面列出的 12 个 focused 文件：95 passed / 1 skipped，exit 0；跳过的是真实 OpenCode Key 用例
- 完整 `tsconfig.typecheck.json` 检查：exit 0
- 三个变更 TypeScript 文件的 targeted ESLint：exit 0；`git diff --check`：exit 0
- 真实 `PiAgentRuntime` + 官方 faux provider 经 JSON 持久化恢复，实际 provider 请求由 v1 更新到 v2，再恢复到 v3；验证当前工具 schema、历史与私有签名保留
- Workbench 恢复编排调用实际兼容适配层/Pi：provider 收到的记忆 revision 与 `context_loaded` 相同，随后保存的 messages 使用同一上下文；数据库 transport 和模型 gateway 使用受控替身
- 反向控制仅暂时移除基线覆盖：3 个新增回归均失败，exit 1，实际收到旧 v1；恢复后逐字节确认文件一致，同样 3 个回归通过，exit 0

```sh
OPENCODE_ZEN_TEST_KEY= node_modules/.bin/vitest run \
  lib/agent-runtime/pi/runtime.test.ts \
  lib/agent-runtime/pi/ai-sdk-compat.test.ts \
  lib/agent-runtime/pi/preview-fixture.test.ts \
  lib/agent-runtime/pi/workbench-result-submission.test.ts \
  lib/ai/agents/workbench-state.test.ts \
  lib/ai/agents/workbench-result-recovery.test.ts \
  lib/ai/agents/run-resumed-workbench-turn.test.ts \
  lib/ai/agents/workbench-start-job-memory.test.ts \
  lib/ai/agents/workbench-events.test.ts \
  lib/agent-engine/agent/org-memory.test.ts \
  'app/api/v1/ai/workbench/runs/[id]/evaluation/route.test.ts' \
  tests/agent-runtime/fixtures/pi-parity.test.ts --reporter=verbose
NODE_OPTIONS=--max-old-space-size=4096 node_modules/.bin/tsc --noEmit -p tsconfig.typecheck.json
node_modules/.bin/eslint lib/agent-runtime/pi/runtime.ts \
  lib/agent-runtime/pi/runtime.test.ts lib/ai/agents/run-resumed-workbench-turn.test.ts
git diff --check
```

## 边界与系统连接

本次属于核心修复：没有组织启用扩展时，Workbench 普通恢复仍必须使用本次系统规则。入口是恢复后的 CRM 消息与当前系统提示，出口是 Pi 实际 provider 上下文及 `ai_agent_run_states.messages`；既有 `context_loaded` 事件和 Workbench 时间线继续提供版本来源。失败回归验证能抓住版本未生效，不新增配置、导航、表或迁移，不改变审批与发送边界，不引入新的记忆产品或知识库集成。

没有读取或配置 API Key，没有连接外部模型、真实 Supabase、生产数据库或客户渠道。没有运行完整 unit/gov、全仓 lint、build、DB/RLS、浏览器 E2E 或部署验收。此记录证明实际 Pi SDK 与应用编排的离线接线，不代表外部 provider、真实数据库或真实租户端到端验收。提交使用 `[skip ci]`，远程 CI 未执行不算通过；没有创建 PR、合并或部署。
