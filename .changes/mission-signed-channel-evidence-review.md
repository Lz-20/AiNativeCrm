---
impacto: nada_mudou
secao: corrigido
titulo: 客户确认必须有逐条验签的渠道证据
---

- 结构化报价确认不再把 CRM 入站 `external_id` 当作足够的客户来源证明。
- 已验签 WAHA 回调只绑定本次真实新增的 CRM 消息 ID；未签名回调、重复外部 ID、未绑定回调和撤回消息都不能得出确认结论。
- 默认 WAHA Core 未签名时只能给出待核验，需可签名的渠道或可信签名代理及真实客户联调。没有把合成数据库行称作客户验收。
