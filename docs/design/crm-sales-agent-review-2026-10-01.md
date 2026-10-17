# 从销售日常出发的 CRM 与 Agent 改进建议

审阅日期：2026-10-01。代码基线：[`fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674`](https://github.com/luckiest-draw/AiNativeCrm/commit/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674)。

## 结论

当前产品已经有耐久队列、受控多 Agent、人工审批、客户发送账本、持续商机任务和证据评测。下一阶段最值得做的是：让销售能从“今天该找谁”一直走到“客户确认了什么、下一步谁负责”，而不必理解执行器、工具事件或模型评分。

优先次序：

1. 先保护客户上下文和草稿，避免换客户后带错内容；把日常回复、审批、跟进放进同一条工作路径。
2. 让聊天成为操作入口，同时保留客户、商机、收件人、下一步和发送状态这些确定性界面。
3. 补齐知识的来源、版本、有效期和可见范围；先解决现有两条 Agent 路径的记忆一致性，再扩展“长期记忆”。
4. 保留一个有责任边界的主 Agent。复杂调查才调用只读专家；增加 Agent 数量不是产品目标。
5. 用客户工作流的成功率评价系统。工具成功、Run 完成、已发出、客户回复和业务验收必须分别显示。

本报告是代码审阅与产品建议，不是生产验收。没有调用真实模型、发送客户消息、接入飞书或执行线上安全测试。文中“已实现”表示在上述提交中找到相应实现，不表示本次重新跑过完整测试。另行进行的聊天界面改动应以其 PR 和测试记录为准。

## 已实现的基础与下一步差距

| 能力         | 代码中已有                                                                    | 接下来该解决的问题                                                  |
| ------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 客户沟通     | Inbox 已有客户会话、CRM 侧栏、内部备注、可编辑 AI 草稿、批准发送和人工接管    | 把建议和操作放在当前客户上下文中；不要另造一套发送链                |
| Agent 执行   | Pi 是运行时内核，CRM 负责模型绑定、工具、范围、持久化和策略                   | UI 不应让销售先学习四种 Agent 才能起草回复                          |
| 持久化与恢复 | `workbench_start` 从保存状态运行，审批后可续跑；SSE 按事件序号重放            | 把恢复状态翻译成“仍在处理／等待你／需核对”，不要只给原始事件        |
| 多 Agent     | 三个只读专家、父 Agent 写入、工具预算、超时、取消、租约和过期写入防护         | 按任务收益启用；Mission 当前串行执行专家，不应宣称总是三路并行      |
| 写入与审批   | 只读模式；有限商机字段的可补偿更新；其余变更走提案                            | 人看得懂的字段差异、收件人和后果必须紧挨确认按钮                    |
| 客户发送     | Workbench 草稿进入现有 `fn_reply_action` 和发送队列，具备状态与发送证据核对   | 明确区分批准、排队、渠道接受、客户回复、条款确认                    |
| 持续目标     | Mission 与 Run 分离；客户文本、内部资料、期限可驱动继续；方向修订可取消旧执行 | 销售先看到目标、负责人、阻塞、下一次检查和业务证据，而不是 Run 列表 |
| 飞书协作     | 已有 CRM 口令配对、签名私聊绑定、已绑定同事列表、问题发送与回复续跑           | 产品化安装引导、配置失败诊断、真实租户端到端证明仍需独立验收        |
| Wiki 与 RAG  | Wiki 来源、文件提取、分块、嵌入、按来源版本、检索证据契约                     | 尚不能把它等同于自动维护、处理冲突且有精细权限的知识 Wiki           |
| Memory       | 公司母文档版本指针、active 学习条目、客户 checkpoint、Mission 方向和 Run 状态 | 统一读取语义；客户承诺要能回到原消息，不能混进全公司规则            |
| Eval         | 确定性执行评测、结构化结果 provenance、可选语义 Judge、Mission 发送／回复证据 | 加上销售任务验收、错误承诺、草稿串客户、恢复后重复触达等场景        |

依据：[S1](#s1)、[S2](#s2)、[S3](#s3)、[S4](#s4)、[S5](#s5)、[S6](#s6)、[S7](#s7)。

## 一名销售的一天

### 早上先决定该找谁

打开“今天”，先看到需要本人行动的客户：客户在等回复、今天承诺的事、待审批、内部同事未答复、到期跟进。每条只显示客户、为何现在要处理、最后一次有效互动、负责人、建议下一步和主要依据。

已有任务、AI Inbox、Radar、商机和跟进数据可作为来源。建议做一个统一的工作视图，不要新建一套重复任务真相；每条保持原记录 ID、归属和状态。排序首先使用明确到期时间、客户未读入站和责任人，再把模型的风险解释作为辅助。不要仅用模型打分把本来承诺今天处理的事排到后面。

销售点“准备回复”，系统带上确切 contact／lead／conversation 范围，并在输入框旁持续显示。批量筛选用数据库缩小范围，再为少量客户生成建议；不要给每行创建一个 Agent。

### 打开客户先恢复上下文

主区域显示客户会话；同一处可打开精简的客户时间线：

- 客户说了什么，原消息可点开
- 我方承诺了什么，谁在什么时候承诺
- 当前商机与下一步，负责人和期限
- 待发送草稿、待审批变更、正在等谁
- AI 推断单独标识，可纠正，不覆盖原始记录

同一个联系人可能有多个商机。显式选择本次商机，不能凭名字或最近时间静默认领。任务切换后旧客户的草稿、附件、引用消息和审批状态不能跟过来。

### 在聊天里请求一件具体的事

例如：“根据客户这次预算异议，帮我拟一条回复，先不要承诺交期。”

默认呈现：一段短建议、依据、缺失信息、可编辑草稿和一个主要动作。模型、Agent 类型、预算、专家执行和 Eval 放到可展开详情中。对销售来说，顶层动作更适合是“了解客户”“准备回复”“安排下一步”“请同事确认”，底层可以映射现有 Agent 定义。

聊天输入与客户消息输入必须视觉和文案区分：“问助手”与“发给客户”。任何把助手输出转为外发的动作都必须再次展示真正的客户和渠道。

### 审阅并发送

确认卡片至少包含：收件人、渠道／账号、关联商机、最终正文、附件、相关价格／交期来源、审批后的动作。销售修改正文后需要对修改后的内容确认；旧审批不能授权新的正文。

当前 Inbox 已支持编辑 AI 建议；Workbench 的 decision API 审批原始草稿正文。因此要优先复用既有 Inbox 编辑／审批边界，或者明确设计新 revision 合约，不能只在 Workbench UI 增加可编辑文本后仍批准旧正文。[S1](#s1)、[S4](#s4)

客户新回复、人工接管、政策版本变化、收件人变化或草稿过期时，解释“为什么需重新检查”，保留人工编辑供比较，不静默重写，也不悄悄发送。

### 发送后安排有条件的跟进

发送成功后，界面问的是“下一步等什么”：客户回复、同事给交期、约定日期，或人工审批。已有 Mission 机制适合承载持续业务目标，不要把每条聊天都变成 Mission。

没有客户答复不应无限追发。跟进计划要包含渠道、时间窗口、停止条件、负责人和最大触达次数；客户回复或要求停止后取消不再适用的提醒。重试前核对发送账本，未知发送结果进入人工核对。

### 交接与验收

交接给同事的内容是可核验的小包：客户目标、关键原话、我方已作出的承诺、待决问题、当前负责人、下一次动作和证据链接。内部回复带来资料，不自动成为批准客户发送或修改商业条款的授权。

结束时显示实际证据：“渠道已接受”“客户随后回复”“这版结构化条款有明确确认”“负责人已验收”。已实现的明确报价协议仍保持 `businessOutcomeVerified: false`；这项保守边界应保留，而不是用一个绿色完成标记掩盖差别。[S6](#s6)

## 最需要优先做的 UI 与交互

### P0 客户范围和草稿隔离

源码中 Inbox 的 Composer 保存 text／file／mode 等本地状态，父组件未按 conversation ID 设置 key，选择客户只清除引用消息。在不发生 loading 卸载的切换路径，尤其缓存命中时，这形成草稿或附件带到另一个客户的风险。此处是代码风险判断，不是已复现线上事件。

验收：客户 A 输入但不发送正文并选附件，切到已缓存的 B；B 不得出现 A 的可发送内容。回 A 能恢复其草稿，或明确说明未保存。引用、内部备注模式、附件上传进行中、返回前进和多个窗口都要覆盖。建议按组织＋用户＋conversation＋回复／备注模式保存草稿，并在提交时核对当前目标；仅 key 重挂载能隔离但会丢草稿。发送回调还应绑定提交时的草稿 revision，避免较晚成功回执清掉销售刚输入的下一条消息。[S8](#s8)

### P0 先明确销售和经理的权限分工

Workbench 页面、列举／创建 Run 以及审批 API 当前都要求 manager。把页面改成聊天不会让 agent 角色的销售可用。不要直接把所有接口降成 agent：先定义“看分配给我的客户／起草／创建个人任务”的范围和独立“批准外发／改价格／跨漏斗批量操作”的权限，再按矩阵增加 server-side 和数据库测试。[S9](#s9)

### P0 把批准动作做成业务卡片

将“工具将被调用”翻译成“把下列正文发给哪位客户”“把成交预估从多少改为多少”“向哪位同事问什么”。卡片显示是否可撤销、审批所依据的版本和有效范围。批准后只显示已确认的下一状态：排队不是已送达。关闭侧栏或刷新不能丢失待审批动作。

### P1 补上中等屏幕的上下文入口

当前 Inbox 的抽屉按钮在 `md:hidden` 区域，而固定 CRM 侧栏到 `xl` 才出现。768–1279px 区间可能没有同屏 CRM 抽屉入口，只剩跳转客户页。让侧栏按钮显示到 xl，并验证平板横屏与常见笔记本宽度。聊天输入固定占位，长消息只滚动正文区域；移动键盘不能盖住提交按钮。[S8](#s8)

### P1 统一待办视图和客户时间线

统一视图要保留任务来源和责任，允许“分配给我／待我批准／等待客户／等待内部／已完成”筛选。客户时间线应能过滤沟通、承诺、业务变更、AI 建议与审批；默认隐藏 token、模型调用和重复执行日志。技术审计仍保留在详情中。

任务本身已支持 contact／lead ID，但当前任务表单调用方没有传入这两个范围，列表也没有直接回到客户的链接。因此先做“从会话创建跟进，自动继承范围，再从任务回到该会话”，比新建通用任务系统更有价值。[S18](#s18)

### P1 新手入口和真实状态

在客户页和会话页带范围进入助手；空白页提供三个与当前对象有关的例子。模型未配置、无知识来源、权限不足、任务暂停和预算耗尽都给一个可执行的下一步。演示预设回复与真实 CRM 运行要有持久明确标识，不借用同一个“已完成”外观误导。

## Agent Harness 与 Runtime 应怎样分工

保留现有分层并把契约收紧：

1. **CRM 事实层**：客户、商机、会话、任务、审批、报价和发送回执是事实源。知识摘要不能替代这些记录。
2. **上下文装配层**：从可信组织与人员身份解析目标，读取所需证据及版本，记录本次读到哪些材料。
3. **Pi Runtime**：负责模型循环和工具调用生命周期。它提出方案，不能自行扩大权限。
4. **CRM Harness**：负责工具分类、范围、预算、超时、取消、批准、执行、补偿、持久状态和重放。
5. **用户界面与验收层**：显示业务状态和待用户决定的事。Eval 检查执行与证据，业务结果由相应事实或明确人工验收支持。

当前 `tool-effects.ts` 对未知工具关闭，普通写入默认需要确认；仅有限商机字段进入可补偿写入。`reversible-lead-update.ts` 使用读取快照和 `updated_at` 比较，防止撤销覆盖更新后的人工修改。不要为了“自主”去掉这些机制。[S3](#s3)、[S4](#s4)

### 哪些情况值得多 Agent

- 复杂商机复盘：客户会话、商机／跟进、产品政策三个独立证据面，可并行读取。
- 需要不同工具或不同权限的资料调查：让每个专家只拿最小必要工具与上下文。
- 高代价承诺前的独立核查：核查者读证据，不获得发送权；只有发现具体差异才打断销售。

单句改写、查询一个字段、创建已明确的跟进，不需要三个专家。当前选择器已跳过部分直接编辑请求，但依赖任务文字规则，值得用中文、葡语、英语的实际短指令评估误分流。[S2](#s2)

当前独立审查允许 `maxParallel: 3`，最多 18 次专家工具调用、每专家 3 个回合、90 秒超时；Mission 分支把并发设为 1，以降低共享预算旧余额竞争。若以后开放 Mission 并发，应先增加预算预留、结算、失败释放和未知价格处理。现有调用前读已持久化用量是有用保护，但不是 provider 级硬性原子费用上限。[S2](#s2)、[S10](#s10)

### 专家不同意时如何处理

不要投票或让主 Agent 无痕选择最顺耳的答案。对同一实体、字段或命题：比较来源范围、权威、版本与生效时间；重读当前 CRM；记录未解决分歧。价格与交期等承诺仍无法解决时，输出缺口并请求有权人员决定。

现有冲突检测会比较同一 CRM 字段的哈希和 revision；但证据层按 provider＋sourceId 聚合，只要两个专家摘录不同就可能报分歧。同一 Wiki 的两个不同段落并不必然矛盾。建议把 chunk／锚点／revision 加入证据身份，命题冲突单独比较，保留“不一致候选”与“已确认矛盾”两种状态。[S11](#s11)

### 恢复与重放不是重新做一遍

保留耐久事件游标、执行租约、旧 worker fencing、幂等发送账本和补偿的 compare-and-set。恢复时优先读取已经提交的事实；部分写入结果不确定时先核对，不能把重放 UI 事件当成重放外部副作用。新的方向是受控取消旧 Run 再创建新 Run，并不意味着同一模型回合已经可信地读取指令。

一次建议应能追溯到：任务／Run ID、Agent 配置版本、读取的 CRM revision、知识来源 revision、提案、审批人及正文 revision、执行结果和后续客户证据。用户只需看其中有业务意义的部分；原始工具参数和敏感消息不能放进普遍可读事件。[S3](#s3)、[S4](#s4)、[S5](#s5)

## Memory 应分成四层

| 层次           | 该记什么                                     | 真相与更新方式                                           |
| -------------- | -------------------------------------------- | -------------------------------------------------------- |
| 当前执行状态   | 工具结果、待审批提案、续跑位置               | 现有服务端 Run 状态和事件；不是公司知识                  |
| 客户／商机记忆 | 需求、异议、明确承诺、下一步                 | 从原消息／活动派生；保留来源、作者、日期和争议状态       |
| 组织知识       | 产品、定价、服务范围、交期规则、通用异议回答 | 有负责人和版本的批准来源；检索按权限和时效约束           |
| 可复用操作方法 | 如何核对价格、如何请求内部确认、停止条件     | 受版本控制的 Skill／playbook；不允许客户文本修改执行权限 |

现有客户 checkpoint 已有 `commitments`、`objections`、`next_action` 和 `rolling_summary`。它们现在主要是字符串，缺少逐条承诺对应的来源消息、责任方、期限和核验状态。下一步是为现有派生摘要补证据结构，而不是再做一个与 CRM 竞争的自由文本记忆库。[S12](#s12)

**应先修的读取一致性**：普通 inbound 路径把母文档＋active entries 注入系统上下文；Workbench 起跑用 Agent system prompt，`crm_get_org_memory` 只返回 entries。至少这两个显式路径目前不等价。建议复用同一个版本化 resolver，并加“规则只存在于母文档时，两种入口均能发现”的离线回归。[S13](#s13)

不要把“这个客户预算 1 万”保存为“公司统一报价 1 万”。客户记录更正时要更新派生摘要的状态，保留旧引用以供审计；客户删除／匿名化应传播到派生记忆。自动学习先成为有来源的候选更新，由有权限的人批准；不能靠模型自评高分自动发布公司政策。

## LLM Wiki 的具体下一步

当前 Wiki 是真实 RAG 来源类型，已有按来源的索引版本和组织隔离；但“上传 Markdown”还不等于拥有可维护的业务 Wiki。[S7](#s7)

一个实用闭环应是：

1. 原始材料保留来源身份和不可变版本。
2. 提取原文片段，生成候选事实／异议页／产品页。
3. 候选页链接到精确来源，不丢掉限制条件；变化产生 diff。
4. 资料负责人核准可发布版本，标明适用对象、生效时间和复核日期。
5. 查询先做组织、人员、Agent 来源集合、客户范围和版本有效性的授权过滤，再做相关性检索。
6. 答复把“来源支持的事实”“推断”“缺失材料”分开；报价等高影响内容在提交审批前重查版本。
7. 用户纠正产生修订候选；不得悄悄把旧引用改指向最新内容。

### 从当前代码能直接定位的改进

- `KnowledgeLocator` 已允许 revision 和 uri；`crm_search_knowledge` 当前映射只填写 provider 与 sourceId。把数据库已有索引版本、chunk 位置／哈希与安全的来源定位带到规范化证据层，并在 UI 展示。[S14](#s14)
- Markdown 提取器会移除 frontmatter；文档分块只保留 source_type、文件名和扩展名。因此把 ACL、有效期写进 YAML 并不会自动产生可执行授权或时效过滤。需要服务端结构化字段和实际读取逻辑。[S15](#s15)
- 内置 Agent 的来源集合来自本组织 active sources。客户私有谈判记录不能仅靠“属于同一租户”就上传为所有内置 Agent 可读的组织 Wiki。先沿用 CRM 对象范围，待细粒度来源授权落地再考虑统一索引。[S16](#s16)
- 索引版本与业务版本不是同一概念：重新嵌入不等于价格批准；indexed_at 不等于 valid_from；检索分数不等于事实可信度。
- 新版本构建失败保留旧可用索引是现有优点。未来还应把发布指针切换做成明确原子边界，评估当前多次写入切换路径的故障窗口，并用失败注入测试验证。[S7](#s7)

参看可读的[虚构 Wiki 示例](llm-wiki-example/README.md)。它包含产品／报价页、交期与异议页、客户承诺页、逐条原始来源和检索验收样例。这些只是设计材料，没有注册到应用、调用模型或修改数据库；不能声称 ACL、刷新或 Wiki 自动编译已上线。

## 建议拆成三个可验收增量

### 第一批 让销售能安全走完一条路径

- 聊天式 Workbench 展示，保留真实 API、审批、取消和恢复行为。
- Inbox 草稿按 conversation 隔离；提交时核对目标；统一关键状态文案。
- 在现有客户／会话页带范围进入助手；修复中等宽度 CRM 入口。
- 先明确角色矩阵，日常销售与经理批准分开，不借 UI 改造扩大权限。

验收：销售能从一条待办找到依据、编辑草稿、向正确客户发出一次，并知道下一步归谁；刷新、换客户、重复点击、旧草稿和暂停均有正确结果。不是“页面看起来像聊天”就完成。

### 第二批 让知识可信且一致

- 共用版本化组织记忆 resolver。
- 知识证据补 revision、来源定位和 chunk 身份；显示缺失／过期／已替代。
- 客户承诺增加来源和确认状态；保持组织政策与客户事实分离。
- 小规模人工审核 Wiki 更新，先覆盖最常见产品、价格和交期问题。

验收：旧价和新价同时存在时引用正确适用版本；来源撤权后不能检索或外显旧摘要；同一文档不同段落不误报冲突；客户的愿望不会变成我方承诺。

### 第三批 用结果决定自动化深度

- 对真实销售任务比较单 Agent 与受控专家的收益、时延和成本。
- 如需 Mission 并行，再实现可结算的预算预留。
- 完善等待内部资料、发送异常、到期与交接的统一待办。
- 扩展独立结果证据，保留人工验收和部分失败；真实渠道联调用单独授权的测试客户。

验收：每个自动动作有可审计范围；无法核对的发送不自动重试；停止后旧 worker 不能继续写入；知识更新能找到受影响的草稿和待办。

## 评测先覆盖这些场景

现有 Eval 已能检查结构化来源是否真的被观察、部分字段是否匹配、工具失败、策略顺序和任务终态。继续在此基础上增加业务场景，而不是让另一个模型简单打分。[S17](#s17)

| 场景                     | 必须成立的结果                                     |
| ------------------------ | -------------------------------------------------- |
| A 客户有未发送附件，切 B | B 无 A 草稿与附件，发送目标不可串换                |
| 先编辑草稿，再批准       | 批准绑定最终编辑版本；旧正文／旧 revision 不被发送 |
| 审批前客户新增回复       | 旧上下文失效并解释原因，不能静默发送               |
| 同客户多个商机           | 显式选择范围或转人工，不猜归属                     |
| 旧价仍能检索到           | 使用当前适用批准价；旧价显示已替代                 |
| 公司规则仅在母文档       | inbound 与 Workbench 都能读取相同规则及版本        |
| 不同段落来自同一 Wiki    | 不因 excerpt 不同而断言业务矛盾                    |
| 两份有效政策冲突         | 显示冲突和负责人，不能凭相似度决定价格             |
| 客户说“收到”             | 只能记回复，不能标接受报价                         |
| 同事给出暂定日期         | 显示暂定及来源，不自动向客户承诺                   |
| 发出后 worker 崩溃       | 用账本核对，最多一次外部副作用                     |
| 暂停与旧 worker 竞争     | 旧执行无写权；已在途消息明确提示无法保证召回       |
| 跨组织／撤权来源         | 服务端阻断检索和证据展示，不仅隐藏按钮             |
| 预算耗尽／价格未知       | 部分结果或人工接手，不显示成功也不无限重试         |

离线 fixture、组件测试、临时数据库故障注入先行；随后是有授权的合成租户浏览器端到端，再做真实渠道验收。禁止把离线通过宣传为真实客户已完成闭环。

建议记录：完成一次“准备并审阅回复”所需时间、草稿人工修改比例、来源可打开率、错误承诺率、错收件人／重复发送数、过期草稿拦截数、漏掉到期承诺数、单任务时延和模型成本。先建立基线再定目标，不能凭空许诺转化率提升。

## 代码依据

以下链接固定在审阅提交。文档状态与代码不一致时，以本次读到的具体实现为准。

<a id="s1"></a>**S1 客户沟通**：[`ReplyReviewPanel.tsx` 97–179](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/components/inbox/composer/ReplyReviewPanel.tsx#L97-L179)、[`InboxLayout.tsx`](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/components/inbox/InboxLayout.tsx)。

<a id="s2"></a>**S2 专家边界与选择**：[`collaboration.ts` 1–189](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/agents/collaboration.ts#L1-L189)、[`collaboration-runtime.ts` 153–300](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/agents/collaboration-runtime.ts#L153-L300)。

<a id="s3"></a>**S3 执行恢复与重放**：[`workbench-start-job.ts` 44–200](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/agents/workbench-start-job.ts#L44-L200)、[`events/route.ts` 11–69](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/app/api/v1/ai/workbench/runs/%5Bid%5D/events/route.ts#L11-L69)、[`tool-effects.ts` 11–35](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/agents/tool-effects.ts#L11-L35)。

<a id="s4"></a>**S4 批准与补偿**：[`decision/route.ts` 45–100 与 207–259](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/app/api/v1/ai/workbench/runs/%5Bid%5D/proposals/%5BproposalId%5D/decision/route.ts#L45-L259)、[`reversible-lead-update.ts` 3–69](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/agents/reversible-lead-update.ts#L3-L69)。

<a id="s5"></a>**S5 Mission 与飞书**：[`mission-state.md`](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/docs/architecture/mission-state.md)、[`feishu-binding.ts` 34–195](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/internal-collaboration/feishu-binding.ts#L34-L195)、[`_feishu-binding.tsx` 20–99](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/app/app/settings/profile/_feishu-binding.tsx#L20-L99)。注意 Mission 文档仍有“缺少身份绑定流程”的旧描述；配对实现和 UI 已存在，不能据旧描述再宣称没有。

<a id="s6"></a>**S6 业务证据边界**：[`mission-explicit-offer-evidence.ts` 6–21、59–69](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/evals/mission-explicit-offer-evidence.ts#L6-L69)、[`mission-explicit-offer.md` 3–15](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/docs/architecture/mission-explicit-offer.md#L3-L15)、[`mission-delivery-evidence.ts` 63–97](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/evals/mission-delivery-evidence.ts#L63-L97)。

<a id="s7"></a>**S7 知识索引**：[`busca.ts` 62–109、127–166](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/knowledge/busca.ts#L62-L166)、[`version.ts` 34–197](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/rag/version.ts#L34-L197)、[`rag-indexer.ts` 375–455](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/workers/rag-indexer.ts#L375-L455)。

<a id="s8"></a>**S8 Inbox 上下文**：[`InboxLayout.tsx` 279–284、460–540](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/components/inbox/InboxLayout.tsx#L279-L540)、[`Composer.tsx` 85–93](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/components/inbox/Composer.tsx#L85-L93)。

<a id="s9"></a>**S9 Workbench 角色**：[`page.tsx` 14–16](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/app/app/ai/workbench/page.tsx#L14-L16)、[`runs/route.ts` 48–67](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/app/api/v1/ai/workbench/runs/route.ts#L48-L67)。

<a id="s10"></a>**S10 Mission 预算**：[`mission-budget.ts` 19–87](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/agents/mission-budget.ts#L19-L87)。

<a id="s11"></a>**S11 分歧判断**：[`collaboration-runtime.ts` 57–150](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/agents/collaboration-runtime.ts#L57-L150)。

<a id="s12"></a>**S12 客户 checkpoint**：[`checkpoint-contract.ts` 8–45](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/agent-engine/agent/checkpoint-contract.ts#L8-L45)。

<a id="s13"></a>**S13 两条记忆路径**：[`org-memory.ts`](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/agent-engine/agent/org-memory.ts)、[`inbound-turn.ts` 1581–1591](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/agent-engine/agent/inbound-turn.ts#L1581-L1591)、[`workbench-start-job.ts` 422–430](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/agents/workbench-start-job.ts#L422-L430)、[`evolucao.ts` 194–213](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/mcp/tools/evolucao.ts#L194-L213)。

<a id="s14"></a>**S14 证据定位字段**：[`contracts.ts` 35–51](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/knowledge/contracts.ts#L35-L51)、[`evolucao.ts` 93–114](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/mcp/tools/evolucao.ts#L93-L114)。

<a id="s15"></a>**S15 元数据不是执行策略**：[`markdown.ts` 33–60](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/rag/extractors/markdown.ts#L33-L60)、[`rag-indexer.ts` 204–221](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/workers/rag-indexer.ts#L204-L221)。

<a id="s16"></a>**S16 内置来源集合**：[`ensure-builtins.ts` 29–37、165–176](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/agents/ensure-builtins.ts#L29-L176)。

<a id="s17"></a>**S17 结构化结果与评测**：[`workbench-result-submission.ts` 14–34、66–78](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/agents/workbench-result-submission.ts#L14-L78)、[`evaluate-run.ts` 94–182](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/lib/ai/evals/evaluate-run.ts#L94-L182)。

<a id="s18"></a>**S18 跟进的客户关联**：[`FormularioDeTarefa.tsx` 31–40、102–109](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/app/app/tasks/_components/FormularioDeTarefa.tsx#L31-L109)、[`TarefasClient.tsx` 183–189](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/app/app/tasks/_components/TarefasClient.tsx#L183-L189)、[`ListaDeTarefas.tsx` 96–128](https://github.com/luckiest-draw/AiNativeCrm/blob/fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674/app/app/tasks/_components/ListaDeTarefas.tsx#L96-L128)。
