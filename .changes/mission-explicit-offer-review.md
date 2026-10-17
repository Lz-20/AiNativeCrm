---
impacto: capacidade_nova
secao: adicionado
titulo: 结构化报价确认（评审切片）
---

- 负责人在持续商机任务中固定项目、币种、金额、交期与一对一客户会话；幂等请求只产生一版带关联码的报价正文，不自动发送。
- 现有 Agent 发送提案、负责人逐字审批与发送账本保持必经路径。只在核对同一版原文发送及同渠道、同客户、到期前的整条确认回复后，报告 `structuredTermsAccepted`。
- Agent 自述、普通“收到”、商机阶段和语义 Judge 不能替代这条证据；`businessOutcomeVerified` 保持 `false`。
- 已通过本地单元测试、数据库安装/升级不变量与生产构建；真实 WhatsApp 客户渠道联调、法律身份核验和任意自由文本业务条件仍未完成。
