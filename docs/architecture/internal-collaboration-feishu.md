# 飞书内部补充入口（开发中）

业务场景：商机任务正在等待交付同事核对交期。同事在飞书对该任务对应的问题回复具体信息；CRM 把这段话当作未经核实的内部事实，创建一次有预算和发送闸门的 Mission 续跑。它不构成折扣、报价或客户消息的批准。

## 已实现的边界

- `POST /api/v1/ai/internal-collaboration/feishu/events` 验证原始请求体的飞书事件签名、五分钟时间窗、应用 ID 和验证令牌；加密事件使用飞书官方 Node SDK 定义的 AES-256-CBC 封装解密。只处理 `im.message.receive_v1` 的员工文本回复，忽略卡片动作、机器人消息和非绑定线程消息。
- CRM 已登录的组织成员在个人资料页发起十分钟一次性绑定挑战；口令仅展示一次，数据库只存 SHA-256。必须由同一飞书租户的真人账号私聊机器人发送完整口令，并经过签名事件核验，才原子建立成员映射。首次租户绑定仅允许 `FEISHU_TENANT_ORGANIZATION_ID` 指定的 CRM 组织经理发起；服务端不允许任意组织抢占飞书租户。过期、重用、跨组织、群聊、机器人发送、撤权成员均失败关闭。已绑定的原始飞书账号不能由另一 CRM 用户凭新口令接管。
- 服务端独占的 `ai_internal_platform_tenants`、`ai_internal_platform_users`、`ai_mission_internal_threads` 分别固定平台租户到 CRM 组织、平台用户到 CRM 成员、飞书回复线程到 Mission。消息正文、聊天名和 `@` 提及都不能自行声明身份或任务。
- 回调只做一次短事务：在已绑定的租户、员工和回复线程下，把正文用安装密钥派生的独立 AES-GCM 密钥加密放进服务端独占 inbox，并同时写入 `internal_im_event` 队列任务。相同平台事件 ID 只保留一个 inbox；正文或来源变化的同 ID 回调被拒绝。工作进程随后解密，在 Mission 行锁内重新核对映射与成员状态，沿用 CRM 的内部补充续跑事务。原文只进入受限 Run 任务；账本和事件保存摘要、来源 ID，不复制原文。
- 已处理的 inbox 内容立即清除；需要人工复核的内容最多保留七天供排查，超期由 Worker 清除。队列重投使用同一来源 ID，不会再创建第二个 Run；耗尽重试后记录待复核状态。
- Worker 在创建续跑和结算 inbox 时核对同一份队列租约；过期 Worker 不能继续提交业务动作。如果 Run 已提交、Worker 却在结算 inbox 前退出，接管者通过来源 ID 找回同一 Run，再清理 inbox，而不是重新执行任务。即使队列最终耗尽，对账也先核对已提交的来源账本，避免把成功创建的 Run 误报为待复核。
- 负责人可在等待内部信息的商机任务旁，从已绑定的飞书同事中选择收件人并确认确切问题。`POST /api/v1/ai/missions/:id/internal-question` 在 Mission 行锁下复核负责人权限、成员映射与状态，幂等地加密写入 `ai_internal_question_outbox` 并入队。Worker 发送私信时使用 outbox ID 作为飞书发送 UUID；只有收到消息 ID 与会话 ID，才将该真实消息绑定为 Mission 的回复线程。商机界面明确区分“已排队”和“已送达”。
- CRM 主管内置智能体在关联商机 Mission 的行动运行中可调用 `list_internal_colleagues` 读取已绑定同事，再调用 `ask_internal_colleague` 提出确切问题。这个工具只保存待审提案，模型调用不会向飞书发消息。负责人在工作台看到收件人和原文后批准；批准事务按 Mission→Run→Proposal 加锁，复核 Agent 版本、负责人权限和唯一待审提案，同时加密入 outbox、入队、保存 Pi 观察、终结当前 Run 并把 Mission 置为 `waiting_internal`。发送成功后依旧由真实消息 ID 绑定回复线程；同事回复创建同一 Mission 的新 Run。拒绝则清除提案中的问题原文并让 Pi 从保存的消息状态继续。批准后的提案原文也被清除；运行事件只保存 ID 和状态。
- 飞书发送 UUID 仅在一小时内防重。自动发送期限设为 45 分钟；超过期限、无法确认实际消息 ID、成员失效或队列耗尽时转人工核对，不在去重窗口外盲目重发。发送成功立即清除问题密文；待复核密文七天后清除。发送前再检查并锁定 Mission、租户和员工状态，锁持续到渠道调用结束：先完成取消或撤权就不会发送；若发送已获得锁，随后取消必须等待，且已进入飞书传输的消息无法撤回。
- 提供信息的员工只作为来源记录。Agent 继续使用原任务负责人作为执行身份；如果负责人已失去组织经理权限，拒绝续跑。外部发送依旧经过 CRM 提案确认和最终发送闸门。

## 尚缺的真实联调与产品能力

目前仍需由运维在飞书租户安装自建应用、配置机器人与事件订阅，并把真实租户 key 和目标 CRM 组织 UUID 配置到服务端。身份绑定的 CRM/飞书双证明流程已有实现，但尚未在真实飞书租户完成端到端联调；仅靠服务端配置不是自动安装或平台侧租户所有权验证。没有映射时不能选择收件人，普通任务回调会应答 `unbound`，不会启动 Agent。Agent 提问仅在内置 CRM 主管的 Mission 行动运行中开放，且必须由负责人确认；它不是通用 MCP 能力，也不会自行批准。

卡片动作需要独立的审批协议和签名验证，不能复用文本回复入口。回调现在会在 inbox 与队列同事务提交后应答，不等待 Mission/模型执行；数据库写入自身仍可能超过平台时限。正式部署前仍需用真实租户验证口令绑定、重投、时限、线程字段和签名。本文不宣称已完成飞书/WhatsApp 跨渠道端到端验收。

环境变量：入站需要 `FEISHU_APP_ID`、`FEISHU_EVENT_ENCRYPT_KEY`、`FEISHU_EVENT_VERIFICATION_TOKEN`、`AI_CRED_AES_KEY`；出站还需要 `FEISHU_APP_SECRET`、`FEISHU_TENANT_KEY`。首次租户绑定还要求 `FEISHU_TENANT_ORGANIZATION_ID`（CRM 组织 UUID），须由部署者在验证真实租户后设置。缺少对应变量时入口失败关闭。不要将值放入仓库或运行事件。

签名与加密格式核对依据：[飞书官方 Node SDK 事件处理](https://github.com/larksuite/node-sdk)、[官方签名实现](https://github.com/larksuite/node-sdk/blob/main/dispatcher/request-handle.ts)、[官方 AES 解密实现](https://github.com/larksuite/node-sdk/blob/main/utils/aes-cipher.ts)。出站依据：[发送消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/create)；[官方 SDK 对发送 UUID 的说明](https://larksuite.github.io/oapi-sdk-java/com/lark/oapi/service/im/v1/model/CreateMessageReqBody.Builder.html)。
