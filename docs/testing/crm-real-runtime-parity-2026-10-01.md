# 真实 Workbench 能力接线：离线验证记录

日期：2026-10-01。能力与配置步骤见 [真实 API 能力矩阵](../design/crm-real-api-parity-2026-10-01.md)。测试调用生产模块和接口处理器，以受控 DB、model-call、fetch 替身隔离外部服务。没有 API Key、线上租户数据或客户发送。

## 最终结果

- 下列明确选择的 29 个 Vitest 文件：180 tests passed，exit 0
- 完整 `tsconfig.typecheck.json` TypeScript 检查：exit 0，4 GiB Node heap
- 本次所有变更 TS/TSX 的 targeted ESLint：exit 0；最后修改的 Eval 文件再次 lint：exit 0
- `lint-role-rank`：exit 0
- `git diff --check`：exit 0
- 独立代码复核已检查来源权限、builtin draft 来源选择、精确索引链接、发送控制、评测缺失材料和客户匿名化边界；所选独立离线回归通过

反向控制：提交快照后临时移除知识冲突 key 中的 chunk ID，预期“同一 Wiki 不同段落不误报冲突”用例失败。实测 1 failed / 9 passed，exit 1，失败用例恰为预期；恢复原文件后 10 passed，exit 0，并校验恢复后的文件与提交相同。没有留下测试破坏代码。

## 重现 focused suite

已有依赖时可用 `node_modules/.bin/vitest`；常规 pnpm 项目可通过 `pnpm exec vitest` 运行同样参数。本环境使用前者，避免包管理器自动安装。

```sh
node_modules/.bin/vitest run \
  tests/unit/workbench-chat-first.test.tsx \
  tests/unit/workbench-delegation-state.test.tsx \
  tests/unit/workbench-viewport-shell.test.tsx \
  tests/unit/workbench-durable-queue.test.ts \
  tests/unit/workbench-confirmed-reply-sql.test.ts \
  lib/agent-engine/agent/org-memory.test.ts \
  lib/agent-engine/agent/customer-memory.test.ts \
  lib/ai/agents/workbench-start-job-memory.test.ts \
  lib/ai/agents/run-resumed-workbench-turn.test.ts \
  lib/ai/agents/workbench-events.test.ts \
  lib/ai/agents/collaboration-runtime.test.ts \
  lib/ai/agents/workbench-job-lease.test.ts \
  lib/ai/agents/workbench-resume-job.test.ts \
  lib/ai/agents/workbench-result-recovery.test.ts \
  lib/ai/agents/workbench-observed-evidence.test.ts \
  lib/ai/agents/workbench-proposal-preview.test.ts \
  lib/ai/knowledge/busca.test.ts \
  lib/ai/knowledge/evidence.test.ts \
  lib/mcp/tools/evolucao-evidence.test.ts \
  lib/ai/evals/evaluate-run.test.ts \
  lib/ai/evals/run-evaluation.test.ts \
  lib/ai/evals/evidence-provenance.test.ts \
  lib/ai/evals/golden-corpus.test.ts \
  app/app/ai/workbench/_components/MissionSendControl.test.tsx \
  app/api/v1/ai/workbench/runs/route.test.ts \
  'app/api/v1/ai/workbench/runs/[id]/events/route.test.ts' \
  'app/api/v1/ai/workbench/runs/[id]/evaluation/route.test.ts' \
  'app/api/v1/ai/missions/[id]/commands/route.test.ts' \
  'app/api/v1/ai/knowledge/sources/[id]/trechos/route.test.ts' \
  --reporter=verbose
NODE_OPTIONS=--max-old-space-size=4096 node_modules/.bin/tsc --noEmit -p tsconfig.typecheck.json
```

最初 expanded focused run 发现旧 durable-queue source test 的两条断言仍查旧 UI 状态字符串/旧路由内 enqueue。已改为检查现有事务 helper 的调用、tenant/proposal dedup SQL 与持久恢复解析；没有为过测试更改实际队列行为。更新后全组通过。

## 其他 gate 与限制

- `node --import tsx scripts/lint-channels.ts`：exit 1，既有 `lib/ai/evals/mission-explicit-offer-evidence.ts` 的 provider literal；本次未改该文件
- `node --import tsx scripts/cortar-release.ts`：exit 1，既有 `.changes/mission-explicit-offer-review.md`、`.changes/mission-signed-channel-evidence-review.md` 缺 frontmatter；本次 fragment 格式有效，未更改旧碎片
- tsx CLI 在本环境试图创建 IPC pipe 被限制；改用相同脚本的 Node import runner，不创建 IPC listener。没有安装包、扩大权限或改变工作流
- 未运行 full unit suite、`gov:verify`、完整 lint、build、DB/RLS 集成、真实 Supabase 浏览器 E2E、worker 故障注入或带 Key 的模型/embedding/消息渠道测试
- 本次没有 schema/RLS/部署配置/依赖修改。React DOM 回归不等同浏览器像素、移动键盘或触控滚动验证
- 发布 commit 使用 `[skip ci]`；不把未运行的远程 CI 记为通过。没有创建 PR、合并 main 或部署

真实 Key 试运行应在合成测试组织先执行只读任务，核对凭据绑定、embedding、索引完成、来源允许集合、worker 和事件持久化，再单独授权并验证任何外部发送。
