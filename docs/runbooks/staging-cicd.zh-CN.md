# AiNativeCrm staging CI/CD 操作手册

适用仓库：`Lz-20/AiNativeCrm`。适用 Compose 项目：`ainativecrm-staging`。
此入口更新 `app`、`worker`、`scheduler`；Supabase 和既有 VPS 服务由各自的运维流程管理。
Web 保持 `127.0.0.1:3100`，Supabase API 保持 `127.0.0.1:8000`。

## 状态与验收边界

已经实现的配置与操作入口见 [staging-release.yml](../../.github/workflows/staging-release.yml)
和 [受限部署入口说明](../../deploy/staging/RESTRICTED-DEPLOY.md)。
初始源码基准是经过核对的 r4 等效源码提交 `eaf61a2`；r4 原镜像保留自己的本地 image ID，
旧镜像标签与新 Git 提交的构建证明分别记录。

自动部署初始关闭。开启之前应有同一提交的 GitHub 检查结果、ARM64 镜像 digest、VPS 实际更新记录，
以及真实的失败发布恢复记录。单元测试、构建成功和这份文档分别证明各自范围，不代表实际部署验收。
首次接入期间备份恢复校验发现过 catalog 差异；差异清零并签发新的恢复验证证明后才进入容器更新。
当前状态以受限入口 `status`、GitHub run 和服务器日志为准。

## GitHub 配置

在仓库 Settings → Environments 创建 `staging`，把部署相关 Secrets 放在该 environment。
部署只接受 `main`；可在 environment 的 deployment branches 中进一步限定 `main`。
需要人工复核时，可配置 environment required reviewers；该保护会在部署 job 开始前生效。

| 类型 | 名称 | 用途与来源 |
| --- | --- | --- |
| Secret | `VPS_HOST` | 与经核验的 SSH 主机密钥对应的 VPS IPv4 或 DNS 名称 |
| Secret | `VPS_USER` | 专用受限部署账号；安装示例使用 `ainativecrm-deploy` |
| Secret | `VPS_SSH_KEY` | 本次 CI/CD 单独生成的 Ed25519 私钥；与个人 SSH 私钥分开 |
| Secret | `VPS_KNOWN_HOSTS` | 经已有可信 SSH 通道核验后的完整 known_hosts 记录；自定义端口使用相应 `[host]:port` 形式 |
| Repository variable | `STAGING_AUTO_DEPLOY` | 初始为字符串 `false`；验收后才设为 `true` |
| Environment/repository variable | `VPS_PORT` | 默认 `22`；与实际 SSH 端口和 known_hosts 记录一致 |
| 内置 token | `GITHUB_TOKEN` | 构建 job 使用 `packages: write` 发布 GHCR；其他 job 保持读取权限 |

`EXECUTOR_PROPRIO` 沿用已有 CI 的可选 runner 配置；没有已核验的自托管 CI runner 时保留未设置状态。
三个 staging 镜像固定在 GitHub-hosted `ubuntu-24.04-arm` 构建，不依赖该变量。

GitHub 不保存 Supabase service_role、数据库密码、应用加密密钥、测试账号密码或 `app.env`。
当前 App 在请求时由服务端输出经过白名单筛选的公开配置，浏览器读取 `window.__PUBLIC_ENV__`。
镜像构建只传 `APP_VERSION=<完整 Git SHA>`，真实 Supabase 公开地址和公开 key 由现有运行环境注入。
服务端通过 `SUPABASE_INTERNAL_URL` 访问容器内 API；浏览器使用 `http://localhost:8000`。
部署探测会核验页面中的公开配置与受保护的运行环境相符。

GHCR 镜像固定为：

- `ghcr.io/lz-20/ainativecrm-app:<完整 Git SHA>`
- `ghcr.io/lz-20/ainativecrm-worker:<完整 Git SHA>`
- `ghcr.io/lz-20/ainativecrm-scheduler:<完整 Git SHA>`

部署使用 `@sha256:...` digest，SHA 标签用于查找；回滚也使用已记录的不可变引用。
若包为私有，VPS 使用独立的只读拉取凭据；通过安全终端和 `docker login --password-stdin` 配置，
凭据仅保存在 VPS root 的 Docker 凭据目录，权限为 0600。公网包可匿名拉取。
GitHub 的包权限与仓库关联关系应允许本仓库 `GITHUB_TOKEN` 发布。

## 一次性安装受限入口

由已有运维 SSH 会话安装审查过的入口，具体路径、所有者、权限和 sudoers 合约见
[RESTRICTED-DEPLOY.md](../../deploy/staging/RESTRICTED-DEPLOY.md#installation-boundary)。
安装与后续更新这些受信任文件属于运维操作，Actions 不替换服务器上的 engine、备份脚本或 Compose。

关键约束：

1. 专用账号密码锁定，保持可执行 forced command 的 shell，移出 Docker group，省略通用 sudo 权限。
2. authorized_keys 使用 `restrict` 和固定 `ssh-entry.sh`；该目录及父目录归 root 所有，并禁止部署账号写入。
3. 唯一 sudoers 规则指向 `/usr/local/sbin/ainativecrm-staging-entry ""`，空参数约束必须保留；先运行 `visudo -cf` 检查。
4. SSH 命令必须精确为 `ainativecrm-deploy`；请求仅通过 stdin JSON 传递。密钥不允许 shell、PTY、SCP 或端口转发。
5. root 入口清空继承环境，使用 Python isolated mode，固定镜像命名空间、项目、网络和 Compose 文件。
6. 注册 r4 image ID、完整源码基准 SHA、schema 指纹、数据库 catalog 指纹及数据库身份。
7. 保存 r4 镜像与原部署配置；固定备份恢复验证通过、回滚入口实际验收后才登记相应状态。

运行时配置继续使用：

```text
/home/ubuntu/apps/AiNativeCrm-staging/final-20261027/private/app.env
```

该文件保持现有所有者和 0600 权限，父目录为 0700。Actions 既不获取也不覆盖此文件。
SSH 隧道使用原有运维别名 `crm-vps`，专用 Actions 密钥不承担隧道功能。

## 手动构建、部署、查询和回滚

在 GitHub Actions → `staging-release` → Run workflow 选择 `main` 与 `operation`。
也可在已登录的本地 GitHub CLI 运行：

```bash
gh workflow run staging-release.yml --repo Lz-20/AiNativeCrm --ref main -f operation=build
gh run list --repo Lz-20/AiNativeCrm --workflow staging-release.yml --limit 5
gh run view RUN_ID --repo Lz-20/AiNativeCrm --json headSha,status,conclusion,url
```

先记录待验证的完整 main SHA，触发后核对 run 的 `headSha`。每个 job 使用该事件的固定 `GITHUB_SHA`；
如果 main 后续移动，后一次运行属于新的版本，需要新的完整验收。

| operation | 实际作用 | 接触 VPS |
| --- | --- | --- |
| `build`（默认） | 运行现有 CI、生产构建、E2E；并行原生 ARM64 构建和发布三镜像；检查通过才形成 release manifest | 否 |
| `deploy` | 重跑同一事件 SHA 的全部检查及构建，形成 digest manifest，检查服务器状态后发起受限更新 | 是 |
| `status` | 查询当前 SHA、digest、schema、备份/回滚及暂停开关状态 | 只读 |
| `rollback` | 验证新的备份恢复证明后恢复上次成功的三个业务镜像；异常中断时恢复日志中的最后成功版本 | 是 |

```bash
gh workflow run staging-release.yml --repo Lz-20/AiNativeCrm --ref main -f operation=deploy
gh workflow run staging-release.yml --repo Lz-20/AiNativeCrm --ref main -f operation=status
gh workflow run staging-release.yml --repo Lz-20/AiNativeCrm --ref main -f operation=rollback
```

`build` 的产物不是可跳过检查的部署通行证。`deploy` 会生成并验证本次运行自己的 manifest。
现有 `ci.yml`、`perf.yml`、`e2e.yml` 的检查仍然保留；上游手动发布 workflow 的发布语义继续保留。

如需从原有运维会话查询和恢复：

```bash
ssh crm-vps
printf '%s\n' '{"operation":"status"}' | sudo -n /usr/local/sbin/ainativecrm-staging-entry
sudo /usr/local/libexec/ainativecrm-staging/rollback.sh
```

服务器逐项更新 App、Worker、Scheduler，检查容器健康、Web readiness、普通测试用户的核心只读 API，
并比较 Supabase 容器、已有系统服务、监听端口和运行环境摘要。
失败时恢复上一版本的三个镜像并重新探测；数据库不参与自动回滚。
恢复失败或部署中断会保留 `pending`，下一次普通发布停止，运维人员查看日志后使用 rollback 入口处理。

## 数据库变更转人工审查

服务器从固定 Git 仓库只读获取 main；候选提交必须属于 main，且位于当前成功版本之后。
首次 legacy r4 使用单独登记的 `approved_source_sha`。指纹来自：

```bash
git ls-tree -r -z --full-tree COMMIT -- supabase lib/database.types.ts
```

上述原始字节的 SHA256 与已登记 schema 比较；同时扫描整个版本区间内的 `supabase/`、
`lib/database.types.ts` 和 SQL 文件变更，改后回退也进入人工审查。
新备份恢复得到的实际 catalog 还要与已批准 catalog 一致。

触发门禁后，运维人员先审查 SQL、影响对象、真实恢复结果和兼容性验证，按数据库变更流程取得审批。
获批后独立执行需要的数据库步骤，验证数据、RLS、RPC、Storage、Realtime，最后登记新的批准基准。
源码仅需等效调整而无需数据库写入时，同样需要人工核对并留下批准记录。
不要直接改指纹或 `approved_source_sha` 来消除未知差异；CI 和 SSH 请求均没有自动批准或迁移选项。

## 暂停与启用自动发布

日常暂停自动 push 发布，可关闭 GitHub 变量：

```bash
gh variable set STAGING_AUTO_DEPLOY --repo Lz-20/AiNativeCrm --body false
```

此变量不终止已经开始的更新。需要阻止接下来所有普通部署时，在现有运维 SSH 会话创建服务器暂停标记：

```bash
sudo install -m 0600 /dev/null /var/lib/ainativecrm-staging-deploy/paused
```

暂停标记保留 `status` 和 `rollback` 能力；它在部署入口检查，运行中的事务继续完成或按自身失败机制恢复。
原因处理完成并复核日志后，只删除该准确标记恢复入口：

```bash
sudo rm -- /var/lib/ainativecrm-staging-deploy/paused
```

服务器另有独立的 root 状态开关 `auto_deploy_enabled`。使用原有运维会话和已安装的可信模块修改，
与部署共用锁，避免覆盖活动事务。以下命令将其关闭：

```bash
sudo python3 -I - <<'PY'
import fcntl
import importlib.util
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location('staging_engine', '/usr/local/libexec/ainativecrm-staging/engine.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runtime = module.RootRuntime()
lock = Path('/var/lib/ainativecrm-staging-deploy/deployment.lock')
if lock.exists():
    module.secure_path(lock, mode=0o600)
descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    state = runtime.load_state()
    if state.get('pending'):
        raise SystemExit('Resolve pending deployment first')
    enabled = False
    if enabled and state.get('rollback_verified') is not True:
        raise SystemExit('Verify rollback first')
    state['auto_deploy_enabled'] = enabled
    runtime.save_state(state)
    runtime.audit({'phase': 'operator_auto_deploy', 'enabled': enabled, 'at': module.utcnow()})
finally:
    os.close(descriptor)
PY
```

仅在手动 GitHub 发布、普通用户功能探测、故意失败恢复、Supabase/已有服务/端口对比均有实际通过记录后，
才由运维人员将上述 `enabled` 改为 `True` 执行，并设置 GitHub 的 `STAGING_AUTO_DEPLOY=true`。
还应确认暂停标记已移除、没有待恢复事务。两个自动开关都开启之后，main push 才具备自动更新条件。

## 日志、备份与回滚资产

| 位置 | 内容 |
| --- | --- |
| GitHub run 日志 | CI、构建与发布结果；SSH 失败只提供阶段信息，不转发原始敏感输出 |
| artifact `staging-image-{service}` | 三镜像各自的 SHA、schema 和 digest |
| artifact `staging-release-{SHA}` | 通过完整检查的本次 release JSON |
| artifact `staging-result-{RUN_ID}` | 经过字段筛选的部署前后状态与结果 |
| `/var/lib/ainativecrm-staging-deploy/deployments.jsonl` | 事务开始、失败、成功、回滚的时间、SHA、digest 和阶段 |
| `/var/lib/ainativecrm-staging-deploy/state.json` | 当前/上一版本、批准基准、pending 和开关；root 0600 |
| `/var/lib/ainativecrm-staging-deploy/backup-attestation.json` | 最新恢复验证证明；部署前要求本次 hook 新签发 |
| `/var/lib/ainativecrm-staging-deploy/backups/` | 受保护的数据库、Storage 备份与恢复证据；root 0700 |
| `/usr/local/libexec/ainativecrm-staging/compose.release.yml` | 已审查并固定摘要的业务 Compose 模板 |

备份包含数据库及存储内容，保留在受保护目录；避免上传到普通 Actions artifact 或聊天记录。
`app.env` 及普通测试账号凭据同样保留在 VPS。保留原 r4 镜像、原 Compose 快照和后续成功版本引用，
本流程没有镜像、卷或备份自动清理入口。

从运维 SSH 会话查看业务日志：

```bash
sudo tail -n 50 /var/lib/ainativecrm-staging-deploy/deployments.jsonl
for service in app worker scheduler; do
  cid=$(sudo docker ps -q --filter label=com.docker.compose.project=ainativecrm-staging --filter label=com.docker.compose.service="$service")
  test -n "$cid" && sudo docker logs --tail 100 "$cid"
done
```

应用日志含业务诊断信息，只在受保护终端查看，分享前做必要脱敏。完整备份恢复与保留策略由运维人员管理。

浏览器访问通过原有运维 SSH 密钥建立隧道：

```bash
ssh -N -L 3100:127.0.0.1:3100 -L 8000:127.0.0.1:8000 crm-vps
```

访问 `http://localhost:3100`；浏览器的 Supabase 请求经本机 `localhost:8000` 隧道抵达 VPS。
该操作没有新增 VPS 公网监听。

## 维护验证

```bash
python3 tests/staging_ci_test.py
python3 -m unittest discover -s tests/deployment -p 'test_*.py' -v
pnpm cercas
pnpm typecheck
pnpm lint
pnpm test:shell
```

Node 与 pnpm 版本以 `.nvmrc`、`package.json` 为准，CI 安装使用 frozen lockfile。
`tests/unit/staging-cicd.test.ts` 实际执行 Python 协议及部署/备份测试，并拒绝空 discovery 结果。
完整 Linux CI、E2E、ARM64 构建以及 VPS 真实恢复/发布/回滚记录共同构成验收证据。

官方参考：[GitHub ARM runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、
[Actions 安全使用](https://docs.github.com/en/actions/reference/security/secure-use)、
[GHCR 认证与权限](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。
