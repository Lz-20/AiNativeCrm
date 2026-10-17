/* Navigation faithfully mapped from AiNativeCrm catalogo.ts at a891934. */
const CRM_CATALOG = [
  {
    "href": "/app",
    "label": "首页",
    "description": "汇总运营、任务与 Agent 活动。",
    "icon": "Gauge",
    "group": "analise",
    "section": "概览",
    "sidebar": false
  },
  {
    "href": "/app/ai/workbench",
    "label": "Agent–CRM 工作台",
    "description": "让 Agent 读取 CRM、提出操作，并审查真实执行过程。",
    "icon": "Robot",
    "group": "ia",
    "minRole": "manager",
    "section": "Agent 操作 CRM",
    "sidebar": true
  },
  {
    "href": "/app/prospecting",
    "label": "客户拓展",
    "description": "搜索企业，并使用 AI 逐步开展触达。",
    "icon": "Funnel",
    "group": "crm",
    "minRole": "admin",
    "section": "销售日常",
    "sidebar": false
  },
  {
    "href": "/app/inbox",
    "label": "会话收件箱",
    "description": "与 AI 协同处理 WhatsApp 客户会话。",
    "icon": "Inbox",
    "group": "atendimento",
    "sidebar": true
  },
  {
    "href": "/app/radar",
    "label": "风险雷达",
    "description": "查看仍在跟进但热度下降的客户，避免因无人回复而流失。",
    "icon": "ClockCountdown",
    "group": "atendimento",
    "sidebar": true
  },
  {
    "href": "/app/agenda",
    "label": "日程",
    "description": "已预约的内容、与谁预约，以及由谁接待——您和团队的日程。",
    "icon": "CalendarBlank",
    "group": "atendimento",
    "sidebar": true
  },
  {
    "href": "/app/templates",
    "label": "快速回复",
    "description": "已保存的话术脚本，助您更快回复，个人或团队共享。",
    "icon": "FileText",
    "group": "atendimento",
    "sidebar": true
  },
  {
    "href": "/app/kanban",
    "label": "销售漏斗",
    "description": "您的销售漏斗——点击任意一个打开客户看板。",
    "icon": "Kanban",
    "group": "crm",
    "section": "销售日常",
    "sidebar": true
  },
  {
    "href": "/app/contacts",
    "label": "联系人",
    "description": "联系人及其沟通历史。",
    "icon": "Users",
    "group": "crm",
    "section": "销售日常",
    "sidebar": true
  },
  {
    "href": "/app/tasks",
    "label": "任务",
    "description": "约定好的事项，带截止日期——以及已逾期却无人处理的事项。",
    "icon": "ListChecks",
    "group": "crm",
    "section": "销售日常",
    "sidebar": true
  },
  {
    "href": "/app/calls",
    "label": "通话",
    "description": "带有转写记录的 AI 语音通话历史。",
    "icon": "Phone",
    "group": "crm",
    "section": "销售日常",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/products",
    "label": "产品",
    "description": "店铺商品目录，含 AI 客服回复的价格。",
    "icon": "Storefront",
    "group": "crm",
    "section": "准备销售",
    "sidebar": false
  },
  {
    "href": "/app/settings/tenant/agenda",
    "label": "日程类型",
    "description": "可以预约什么、持续多久、在哪里进行、由谁接待。",
    "icon": "CalendarBlank",
    "group": "organizacao",
    "section": "你的公司",
    "sidebar": false
  },
  {
    "href": "/app/comandas",
    "label": "服务单",
    "description": "记录完成了什么、由谁完成以及客户支付了多少。",
    "icon": "Receipt",
    "group": "crm",
    "section": "销售日常",
    "minRole": "viewer",
    "sidebar": false
  },
  {
    "href": "/app/settings/tenant/financeiro",
    "label": "财务",
    "description": "账户、付款方式以及每笔记录的分类。",
    "icon": "ChartBar",
    "group": "organizacao",
    "section": "你的公司",
    "minRole": "viewer",
    "sidebar": false
  },
  {
    "href": "/app/settings/tenant/pipelines",
    "label": "销售漏斗阶段",
    "description": "每个销售漏斗的阶段、商机术语以及丢单原因。",
    "icon": "Funnel",
    "group": "crm",
    "section": "准备销售",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/ai/agents",
    "label": "智能体",
    "description": "替您接待的智能体：指令、模型、工具与发布。",
    "icon": "Robot",
    "group": "ia",
    "section": "配置 Agent",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/ai/followups",
    "label": "跟进",
    "description": "设置智能体如何重新跟进沉寂的会话，避免客户流失。",
    "icon": "FlowArrow",
    "group": "ia",
    "section": "配置 Agent",
    "minRole": "manager",
    "sidebar": true
  },
  {
    "href": "/app/ai/routers",
    "label": "分配规则",
    "description": "哪个智能体接手哪条会话，以及何时转由人工接管。",
    "icon": "Signpost",
    "group": "ia",
    "section": "配置 Agent",
    "minRole": "manager",
    "sidebar": true
  },
  {
    "href": "/app/ai/credentials",
    "label": "凭证",
    "description": "智能体用于思考的 AI 提供商密钥。",
    "icon": "Key",
    "group": "ia",
    "section": "配置 Agent",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/ai/providers",
    "label": "提供商",
    "description": "为系统各部分选择 AI 服务，并设置服务失败后的处理方式。",
    "icon": "Plugs",
    "group": "ia",
    "section": "配置 Agent",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/ai/knowledge/sources",
    "label": "知识库",
    "description": "智能体在回答业务相关问题前查阅的资料。",
    "icon": "BookOpen",
    "group": "ia",
    "section": "Agent 的 CRM 上下文",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/ai/memory",
    "label": "记忆",
    "description": "智能体在业务处理中学到并可复用的信息。",
    "icon": "Brain",
    "group": "ia",
    "section": "Agent 的 CRM 上下文",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/ai/skills",
    "label": "技能",
    "description": "智能体在接待过程中可自主执行的操作。",
    "icon": "PuzzlePiece",
    "group": "ia",
    "section": "Agent 的 CRM 上下文",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/ai/cases",
    "label": "案例",
    "description": "智能体主导的客户接待，从开始到结束。",
    "icon": "ClipboardText",
    "group": "ia",
    "section": "审查 Agent 操作",
    "minRole": "agent",
    "sidebar": false
  },
  {
    "href": "/app/ai/inbox",
    "label": "提醒",
    "description": "AI 发现并需要您决策的事项。",
    "icon": "Flag",
    "group": "ia",
    "section": "审查 Agent 操作",
    "sidebar": false
  },
  {
    "href": "/app/ai/cases/avisos",
    "label": "WhatsApp 提醒",
    "description": "当智能助手创建案件时通过 WhatsApp 接收提醒。",
    "icon": "PaperPlaneTilt",
    "group": "ia",
    "section": "审查 Agent 操作",
    "minRole": "admin",
    "sidebar": false
  },
  {
    "href": "/app/ai/proposals",
    "label": "建议",
    "description": "AI 为自身提出的改进建议，等待您决策。",
    "icon": "Lightbulb",
    "group": "ia",
    "section": "审查 Agent 操作",
    "sidebar": false
  },
  {
    "href": "/app/ai/runs",
    "label": "执行",
    "description": "AI 做了什么——以及失败时发生了什么、该怎么办。",
    "icon": "ListChecks",
    "group": "ia",
    "section": "审查 Agent 操作",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/ai/usage",
    "label": "用量与预算",
    "description": "AI 消耗了多少，以及本月支出上限。",
    "icon": "Gauge",
    "group": "ia",
    "section": "审查 Agent 操作",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/connections",
    "label": "连接",
    "description": "通过扫码或 Meta 官方渠道接入 WhatsApp 号码，查看连接状态、重新连接及管理模板。",
    "icon": "PlugsConnected",
    "group": "canais",
    "minRole": "admin",
    "sidebar": true
  },
  {
    "href": "/app/integrations/nuvemshop",
    "label": "Nuvemshop",
    "description": "连接店铺，将订单和客户导入 CRM。",
    "icon": "Storefront",
    "group": "canais",
    "minRole": "admin",
    "sidebar": false
  },
  {
    "href": "/app/webhooks",
    "label": "Webhook 回调",
    "description": "当此处发生事件时通知其他系统。",
    "icon": "WebhooksLogo",
    "group": "canais",
    "minRole": "manager",
    "sidebar": true
  },
  {
    "href": "/app/faturamento",
    "label": "账单",
    "description": "收入金额、收款方式以及每个人应收的金额。",
    "icon": "ChartBar",
    "group": "analise",
    "section": "资金",
    "minRole": "viewer",
    "sidebar": false
  },
  {
    "href": "/app/metrics",
    "label": "绩效",
    "description": "过去 30 天各客服的销售漏斗与业绩表现。",
    "icon": "ChartBar",
    "group": "analise",
    "section": "本期数据",
    "sidebar": true
  },
  {
    "href": "/app/ads/meta",
    "label": "Meta Ads",
    "description": "查看获客广告每项成果的成本。",
    "icon": "Megaphone",
    "group": "analise",
    "section": "本期数据",
    "minRole": "manager",
    "sidebar": true
  },
  {
    "href": "/app/activities",
    "label": "活动",
    "description": "团队和智能体在该期间的工作报告：数量、人员和类型。",
    "icon": "ClockCounterClockwise",
    "group": "analise",
    "section": "本期数据",
    "sidebar": true
  },
  {
    "href": "/app/ai/evolution",
    "label": "AI 演进",
    "description": "智能体是否在进步、哪里出错、还需教什么。",
    "icon": "ChartLineUp",
    "group": "analise",
    "section": "可查询的历史记录",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/audit",
    "label": "审计日志",
    "description": "谁在何时做了什么——不可抹除的历史记录。",
    "icon": "ClockCounterClockwise",
    "group": "analise",
    "section": "可查询的历史记录",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/settings/profile",
    "label": "个人资料",
    "description": "您的姓名、语言、时区和头像。",
    "icon": "UserCircle",
    "group": "organizacao",
    "section": "你的账户",
    "sidebar": false
  },
  {
    "href": "/app/settings/security",
    "label": "安全",
    "description": "两步验证、恢复代码和会话。",
    "icon": "ShieldCheck",
    "group": "organizacao",
    "section": "你的账户",
    "sidebar": false
  },
  {
    "href": "/app/settings/notifications",
    "label": "通知",
    "description": "您希望通过哪些渠道、接收哪些通知。",
    "icon": "Bell",
    "group": "organizacao",
    "section": "你的账户",
    "sidebar": false
  },
  {
    "href": "/app/team",
    "label": "团队",
    "description": "谁在这里工作、担任什么角色，以及每人能承接多少会话。",
    "icon": "UsersThree",
    "group": "organizacao",
    "section": "你的公司",
    "sidebar": false
  },
  {
    "href": "/app/settings/atendimento",
    "label": "客服分配",
    "description": "谁接收每个新客户，以及每位客服能看到什么。",
    "icon": "UsersThree",
    "group": "organizacao",
    "section": "你的公司",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/settings/tags",
    "label": "标签",
    "description": "企业标签词汇：每个标签的使用位置，以及如何重命名、合并或删除。",
    "icon": "Tag",
    "group": "organizacao",
    "section": "你的公司",
    "minRole": "manager",
    "sidebar": false
  },
  {
    "href": "/app/settings/tenant",
    "label": "组织",
    "description": "公司数据、数据保留和 LGPD 负责人。",
    "icon": "Buildings",
    "group": "organizacao",
    "section": "你的公司",
    "minRole": "admin",
    "sidebar": false
  },
  {
    "href": "/app/settings/conversoes",
    "label": "转化",
    "description": "将广告带来的成交回传，并标记通过网站到达客户的来源。",
    "icon": "ChartLineUp",
    "group": "organizacao",
    "section": "你的公司",
    "minRole": "admin",
    "sidebar": false
  },
  {
    "href": "/app/settings/meta-ads",
    "label": "Meta Ads",
    "description": "连接广告账户，查看广告投放效果。",
    "icon": "Megaphone",
    "group": "organizacao",
    "section": "你的公司",
    "minRole": "admin",
    "sidebar": false
  },
  {
    "href": "/app/settings/marca",
    "label": "品牌",
    "description": "您的公司在系统内显示的名称和颜色。",
    "icon": "Palette",
    "group": "organizacao",
    "section": "你的公司",
    "minRole": "admin",
    "sidebar": false
  },
  {
    "href": "/app/settings/billing",
    "label": "账单",
    "description": "套餐和账单。",
    "icon": "Receipt",
    "group": "organizacao",
    "section": "你的公司",
    "minRole": "admin",
    "sidebar": false
  },
  {
    "href": "/app/lgpd/requests",
    "label": "LGPD",
    "description": "客户提出的数据导出和删除请求。",
    "icon": "ScalesSimple",
    "group": "organizacao",
    "section": "数据与访问",
    "minRole": "admin",
    "sidebar": false
  },
  {
    "href": "/app/settings/api-tokens",
    "label": "API 访问令牌",
    "description": "用于其他系统与您的 CRM 通信的密钥。",
    "icon": "Lock",
    "group": "organizacao",
    "section": "数据与访问",
    "minRole": "admin",
    "sidebar": false
  },
  {
    "href": "/app/settings/voip-trunk",
    "label": "SIP 中继",
    "description": "用于 AI 语音通话的 SIP 服务商凭据。",
    "icon": "Phone",
    "group": "organizacao",
    "section": "数据与访问",
    "minRole": "admin",
    "sidebar": false
  },
  {
    "href": "/app/extensions",
    "label": "扩展",
    "description": "已安装的 CRM 工作指南，可查看权限和状态。",
    "icon": "PuzzlePiece",
    "group": "organizacao",
    "section": "你的公司",
    "sidebar": false
  },
  {
    "href": "/app/integracao-dados",
    "label": "外部数据",
    "description": "连接其他系统的数据库，供智能体实时查询。",
    "icon": "PlugsConnected",
    "group": "organizacao",
    "section": "数据与访问",
    "sidebar": false
  }
];
