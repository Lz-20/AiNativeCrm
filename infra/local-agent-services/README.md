# 本地真实 Agent 服务（内部联调）

安全说明：`provision-local-wiki.ts` 默认只复用完整的现有合成 fixture。缺少模型/知识库/文档时会在远端请求之前拒绝；只有明确接受 `--allow-unbounded-synthetic-ingest` 的未设硬上限成本才能重新生成。已部署 WeKnora 曾忽略页数配置，因此不存在已验证的“最多 2 页”保证。该开关不是生产审批机制；CRM 使用 retrieve-only 密钥读取，不能自动生成或发布知识。

这里运行真实的 Mem0、WeKnora 和 Langfuse，不是健康检查模拟器。配置只绑定合成演示组织 `pi-native-demo`，不得用于真实客户或无人值守生产。

## 服务与资源

| 服务 | 本机地址 | 固定版本 | 内存上限 |
| --- | --- | --- | --- |
| Mem0 API | http://127.0.0.1:8888/docs | 源码 abb81c88，SDK 2.2.1 | 768MB |
| WeKnora API | http://127.0.0.1:8088/health | v0.8.2 | 512MB |
| Langfuse | http://127.0.0.1:3006 | 4.49.0 | Web 1536MB，Worker 768MB |
| 独立 PostgreSQL | 127.0.0.1:5438 | 15.8.1.085 | 256MB |
| ClickHouse / Redis / S3 | 仅 Docker 内网，S3 本机 8333 | 25.12.5.44 / 7.2.7 / SeaweedFS 3.95 | 768 / 64 / 192MB |

所有宿主端口仅绑定 loopback。数据库、文件、向量、事件分别保存到命名卷，未复用或清空 CRM 数据库。Docker VM 保持 4GB；容器上限之和并非同时占用，但这一组合仍较重。已验证 Web 的 384MB/640MB Node 堆不足以启动本版本，不能为了看上去轻量而保留会崩溃的配置。重型 build 与服务联调建议错峰；可用 compose `stop langfuse-web langfuse-worker clickhouse seaweedfs redis` 暂停可观测性栈，恢复后继续投递队列，切勿 `down -v`。

## 初始化（仅一次）

需要 Docker、Compose v2、pnpm；当前机器 Compose 二进制位于 `/Volumes/exten-disk/work/crm/agent-services-tools/docker-compose`。以下 `docker compose` 可替换为该绝对路径。compose 设置 `pull_policy: never`，先准备指定版本镜像，避免无意更新。

```bash
pnpm exec tsx scripts/provision-local-agent-services.ts init
docker build -f infra/local-agent-services/Postgres.Dockerfile -t crm-agent-services-postgres:15.8.1.085 infra/local-agent-services
docker compose --env-file infra/local-agent-services/.env.generated -f infra/local-agent-services/compose.yml up -d postgres
pnpm exec tsx scripts/provision-local-agent-services.ts mem0-db
```

生成的 `.env*.generated` 为 0600、受 Git 忽略，包含私有密钥和管理员密码。不要复制到演示录制、报告或聊天中。

Mem0 使用上游源码 `abb81c88e1f738a8117d8293530fbc31a5ef8fd9` 作为 build context，先按 `Mem0.Dockerfile` 构建 `crm-agent-services-mem0:abb81c88`，再按 `Mem0Offline.Dockerfile` 构建 compose 使用的 `crm-agent-services-mem0-local:abb81c88`。overlay 只让上游 FastEmbed 转发 `local_files_only` 和线程配置，不替换检索结果。构建时下载真实 `BAAI/bge-small-zh-v1.5` ONNX 权重，运行时离线、512 维、单线程。

```bash
docker compose --env-file infra/local-agent-services/.env.generated -f infra/local-agent-services/compose.yml --profile mem0 up -d mem0
# 第一次等待上游 Alembic 完成后，再设置持久化 embedding 配置并重启 Mem0。
pnpm exec tsx scripts/provision-local-agent-services.ts mem0-config
docker compose --env-file infra/local-agent-services/.env.generated -f infra/local-agent-services/compose.yml --profile mem0 restart mem0
```

`infer:false` 使用已人工确认的 CRM 合成事实；`unused-infer-false-local-embedding` 只是满足上游初始化字段，不是可用 LLM 密钥。这里验证真实向量检索，未验证 Mem0 的 LLM 自动事实提取。

## 分阶段启动 Wiki 与 Langfuse

Wiki 没有依赖额外 embedding、Ollama 或图数据库，使用上游 Lite 执行器和 PostgreSQL 的持久化任务。首次创建本地账号时显式暂开注册，之后恢复默认关闭：

```bash
WEKNORA_DISABLE_REGISTRATION=false docker compose --env-file infra/local-agent-services/.env.generated -f infra/local-agent-services/compose.yml --profile wiki up -d weknora
pnpm exec tsx --env-file=.env.e2e scripts/provision-local-wiki.ts
docker compose --env-file infra/local-agent-services/.env.generated -f infra/local-agent-services/compose.yml --profile wiki up -d weknora
```

脚本仅从合成组织既有加密凭据中读取 `opencode/space-bunny-free`，通过真实模型建立 Wiki；管理员密码不打印，CRM API Key 仅有 `retrieve` 权限并绑定单一 KB。生成需要多次真实模型请求，超时会重试。草稿不等于可检索证据；上游在完整 ingest 成功时自动发布派生页面（本次共 11 页），这不代表人工审核其业务结论。`--publish-synthetic` 只用于检查指定产品页面及其单一合成文档引用，若仍为草稿则显式发布该页。CRM 检索还会验证源文档和页面的范围、状态及新鲜度。

本版本实际 ingest 未遵守配置的 `max_pages_per_ingest: 2`：短文仍生成了 11 页，耗时约 11 分钟，包含一次模型超时重试。并发 1 确实限制了内存和模型并发，但不是模型调用次数的硬上限；生产接入前需要独立的生成预算与发布复核，不能只依赖该上游字段。

Langfuse 的 ClickHouse 用 `ClickHouse.Dockerfile` 构建为 compose 指定镜像。SeaweedFS 使用官方 3.95 arm64 发布二进制构建 `SeaweedFS.Dockerfile`，不是 MinIO 模拟实现；验证过的官方压缩包 MD5 为 `bf384a31c4e171dc3ec3f2a984becdbf`。创建 `crm-agent-services-s3-config` 卷，使用临时 helper 容器把生成的 `.env.s3.generated` 复制为 `/etc/seaweedfs/auth.json`，不可放入镜像或提交 Git。启动 S3 后创建 `langfuse` 桶，再启动 Worker/Web：

```bash
docker compose --env-file infra/local-agent-services/.env.generated -f infra/local-agent-services/compose.yml --profile langfuse up -d redis clickhouse seaweedfs
printf 's3.bucket.create -name langfuse\n' | docker exec -i crm-agent-services-seaweedfs-1 /weed -logtostderr=true shell -master=seaweedfs:9333 -filer=seaweedfs:8888
docker compose --env-file infra/local-agent-services/.env.generated -f infra/local-agent-services/compose.yml --profile langfuse up -d langfuse-worker langfuse-web
```

`agent-services@localhost.test` 为本地合成管理员。密码从私有文件读取，不能记录到 README。

## CRM 绑定与真正验收

```bash
pnpm exec tsx scripts/provision-local-agent-services.ts bindings --langfuse
# CRM 与选定的真实运行 worker 都必须加载以下两个 env 文件。
NEXT_PUBLIC_APP_URL=http://localhost:3009 node --env-file=.env.e2e --env-file=infra/local-agent-services/.env.crm.generated node_modules/next/dist/bin/next start --port 3009
```

在 CRM 集成页面启用对应 provider，通过管理员 API 连接 Wiki source，并把该 source 选择到测试 Agent 的草稿。已有真实 API 的权限、审计和组织隔离继续适用；脚本不直接改写 Agent 配置或发布 Agent。

本机网络需要代理时，Node 24+ 可使用 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 NO_PROXY=localhost,127.0.0.1`，CRM 和选定 worker 均需设置。容器的 `SERVICE_HTTP_PROXY` 必须是 Docker VM 实际可达的本机代理地址。当前 VM 通过 SSH 反向转发 17897 和仅绑定 Docker 网桥的 socat 17898 访问本机代理；VM 重启后需重新建立这两个转发。不要把宿主 `127.0.0.1` 当作容器可达的宿主地址。

真实运行创建后，只执行该合成 run 的 job，不启动整个业务消费器：

```bash
pnpm exec tsx --env-file=.env.e2e --env-file=infra/local-agent-services/.env.crm.generated scripts/run-demo-workbench-job.ts RUN_ID
pnpm exec tsx --env-file=.env.e2e --env-file=infra/local-agent-services/.env.crm.generated scripts/verify-local-agent-services.ts mem0 MEMORY_ID
pnpm exec tsx --env-file=.env.e2e --env-file=infra/local-agent-services/.env.crm.generated scripts/verify-local-agent-services.ts wiki SOURCE_ID
pnpm exec tsx --env-file=.env.e2e --env-file=infra/local-agent-services/.env.crm.generated scripts/verify-local-agent-services.ts langfuse RUN_ID
```

先通过 CRM 的显式 Eval POST 生成报告，再通过已鉴权的 `ai-integration-drain` 专用接口投递并等待 Worker 落库。Langfuse v4 使用 Observations API v2 和 Scores API v3 回读，不能用旧 `/traces/:id` 的 404 判断入库失败；见[官方 API 文档](https://langfuse.com/docs/api-and-data-platform/features/public-api)。探针必须查到对应 run 的模型、工具、分数，并确认 input/output 均为空（隐私保护），不能将 HTTP 200 或队列 done 当作完整验收。

验证输出只含 ID、数量、哈希和分数，写入受忽略的 `.env.verification.generated`。真实模型调用成功不代表业务任务完成；部分结果、Judge 失败、来源缺失必须保留。

## 外置盘迁移后的注册邮件恢复

2026-10-03 实际遇到两个本地配置问题：`.env.e2e` 的旧 `NEXT_PUBLIC_APP_URL` 指向 3001，导致确认邮件验证后跳到未监听端口；Colima 的 Kong 模板 bind mount 在 VM 中成了目录，GoTrue 缓存了目录列表而非邮件模板。宿主模板文件没有改动，数据库、卷和会话没有清空。

启动真实 3009 时按上面的命令显式设置回跳地址；隔离 Playwright 3012 使用 `tests/e2e/configs/acceptance.config.ts`，不能沿用 3001。邮件故障须先确认容器和 mount 形态；本机已验证的恢复操作仅针对以下本地容器：

```bash
docker update --memory 128m --memory-swap 128m supabase_inbucket_pi-native-crm
docker start supabase_inbucket_pi-native-crm
# 仅当目标 .html 实际为目录时，恢复该目录的默认 index 文件。
docker cp supabase/templates/confirmation.html supabase_kong_pi-native-crm:/home/kong/templates/email/confirmation.html/index.html
docker cp supabase/templates/recovery.html supabase_kong_pi-native-crm:/home/kong/templates/email/recovery.html/index.html
docker restart --timeout 10 supabase_auth_pi-native-crm
```

这修复了当前邮件内容及 GoTrue 缓存，不意味着 Colima 的文件共享配置已规范化。后续重建 VM/容器须重新核对模板 mount。验收已用新合成账号完成真实 Mailpit 收信、确认、onboarding 与重登录；不提交邮件 token、私有环境文件或浏览器 trace ZIP。上述命令需要当前 Colima Docker context；不要启动另一个默认 VM 或执行 `down -v`。
