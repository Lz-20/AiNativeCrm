# 专项 Playwright 配置

从仓库根目录运行。2026-10-05 将原根目录的 `playwright.acceptance.config.ts` 和 `playwright.live.config.ts` 移入本目录；根目录的 `playwright.config.ts` 继续作为默认测试入口。

| 配置 | 命令 | 用途 |
|---|---|---|
| 默认（根目录） | `pnpm test:e2e` | 本地隔离数据库，启动已构建的 Next 应用 |
| [acceptance.config.ts](acceptance.config.ts) | `pnpm test:e2e:acceptance` | 本地验收，启动 127.0.0.1:3012，隔离回跳地址与浏览器代理 |
| [live.config.ts](live.config.ts) | `pnpm test:e2e:live` | 本地真实模型场景，复用已启动的 3009 服务；可用 `LIVE_BASE_URL` 指定测试服务 |

三者均需要本地 `.env.e2e`，并拒绝非本地 Supabase。前两者需先完成 E2E 构建；live 不启动服务，也不是生产环境测试入口。真实模型场景还需要有效模型凭据，可能产生费用和测试数据，不要仅为确认配置迁移就运行真实模型。

只检查配置加载和测试发现，可在已有安全的本地测试环境中运行：

```bash
pnpm test:e2e:acceptance --list
pnpm test:e2e:live --list
```

`--list` 不启动浏览器或执行测试，不能算作端到端验收。失败截图与 Trace 仍输出到被忽略的根目录 `test-results/`。只有经过脱敏且有明确引用用途的证据才应另行加入 `evidence/`。
