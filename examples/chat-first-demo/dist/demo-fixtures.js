/* Fictional fixtures, plus minimized excerpts of committed historical reports. */
(function (root) {
  'use strict';
  const ref = '12749abaa8aa98f7bee988f69fb4aa23e9d5ff29';
  const historicalRef = 'fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674';
  const source = path => 'https://github.com/luckiest-draw/AiNativeCrm/blob/' + ref + '/' + path;
  const fixtures = {
    schemaVersion: 1, sourceRef: ref, scenarioId: 'starbridge-policy-v1',
    tenantId: 'demo-org-starbridge',
    customer: { id: 'demo-contact-starbridge', name: '星桥商贸', leadId: 'demo-lead-standard', product: '标准实施包', requestedPriceCny: 10000, requestedDate: '2026-10-09', status: 'open' },
    goal: '核对星桥商贸的 10,000 元报价与 10 月 9 日交期，准备有引用的回复和待审批跟进任务。',
    wiki: [
      { id: 'SRC-PRICE-003', tenantId: 'demo-org-starbridge', revision: 3, title: '标准实施包 · 当前价格', published: true, active: true, scope: 'organization', terms: ['报价','价格','10000','10,000','标准实施包','折扣'], content: '2026-10-01 起新报价：一次性含税 CNY 12,000。包括基础配置、一次标准导入、两小时培训。销售不能自行折扣；5% 以内须经理逐单批准，超过 5% 须商务负责人逐单批准。', section: '当前价格与批准边界' },
      { id: 'SRC-DELIVERY-002', tenantId: 'demo-org-starbridge', revision: 2, title: '交付排期 · 承诺边界', published: true, active: true, scope: 'organization', terms: ['交期','交付','上线','日期','10 月','10月'], content: '上线日期须交付负责人确认最终范围、完整资料和排期后才能对客户承诺。客户希望的日期和内部暂定排期不是已批准交付日。', section: '对外承诺规则' },
      { id: 'SRC-PRICE-002', tenantId: 'demo-org-starbridge', revision: 2, title: '标准实施包 · 历史价格', published: true, active: false, scope: 'organization', terms: ['报价','价格','10000','10,000'], content: '历史 CNY 10,000 价格已被 v3 替代，不适用于 2026-10-01 起的新报价。', section: '已被替代' },
      { id: 'OTHER-TENANT-POLICY', tenantId: 'demo-org-other', revision: 1, title: '其他组织的演示政策', published: true, active: true, scope: 'organization', terms: ['报价','价格'], content: '其他组织的材料不得进入本组织检索结果。', section: '隔离测试' }
    ],
    customerSources: [
      { id: 'SRC-CUSTOMER-017', scope: 'customer', content: '预算希望控制在 CNY 10,000，目标 10 月 9 日上线；确认后再发正式方案。', classification: '客户请求，不是批准' },
      { id: 'SRC-REP-019', scope: 'customer', content: '销售承诺在 2026-10-02 15:00+08:00 更新价格与排期的确认进展。', classification: '待履行的进展更新承诺' },
      { id: 'SRC-INTERNAL-008', scope: 'customer', content: '内部暂定 10 月 12 日，依赖资料和最终范围，不要先向客户承诺。', classification: '内部意见，不是已批准交期' }
    ],
    capabilities: [
      { name: 'Wiki / RAG', path: 'lib/ai/knowledge/busca.ts', boundary: '生产：受权来源列表 + 组织范围 + embeddings/RPC；这里：执行本地关键词排序与来源过滤，不做向量搜索。' },
      { name: '组织记忆', path: 'lib/agent-engine/agent/org-memory.ts', boundary: '生产：初始/恢复/专家共享已发布母文档与 active entries，恢复重读当前版本；这里：本地 v1/v2 快照。expectedVersion 冲突拒绝是实验室保护，不代表现有发布 API 已实现此契约。' },
      { name: 'Durable runtime', path: 'tests/unit/workbench-durable-queue.test.ts', boundary: '生产：数据库任务队列、checkpoint、恢复；这里：localStorage 恢复，不是服务端持久队列或进程崩溃恢复测试。' },
      { name: 'Eval', path: 'lib/ai/evals/evaluate-run.ts', boundary: '生产：版本化 profile、确定性规则及可选语义 Judge；这里：显式本地断言，不能代替模型质量评估。' },
      { name: 'Golden corpus', path: 'tests/agent-runtime/fixtures/workbench-eval-golden.ts', boundary: '仓库包含真实运行派生的缩减 fixture 和合成回归 fixture。此页不把重建的事件当作原始完整 trace。' }
    ].map(x => ({ ...x, url: source(x.path) })),
    historical: {
      kind: 'committed_report_excerpt', capturedDate: '2026-09-28', provider: 'opencode', model: 'space-bunny-free',
      reportTitle: 'DuoAgent Runtime 与 Eval 真实模型验收', sourcePath: 'docs/testing/multi-agent-eval-real-run-2026-09-28.md',
      sourceUrl: 'https://github.com/luckiest-draw/AiNativeCrm/blob/' + historicalRef + '/docs/testing/multi-agent-eval-real-run-2026-09-28.md',
      reportRunId: 'b030b8d5-ba15-4168-8407-1ad886ce1743', mode: 'inspect', sourceRef: historicalRef,
      limitations: '仓库已提交验收报告的最小摘录；本次未重新调用模型、查询原数据库或验证报告所述运行。没有完整原始事件 JSON；不补造逐条工具输入/输出，不展示客户正文或内部推理。',
      specialists: [
        { name: 'customer_evidence', status: 'completed', toolCalls: 3, claims: 29, tools: ['crm_get_contact','crm_list_conversations','crm_get_conversation_history'], outputSummary: '报告记载：历史消息接口为空，客户沟通证据存在缺口。' },
        { name: 'opportunity_diagnosis', status: 'completed', toolCalls: 2, claims: 27, tools: ['crm_get_lead','crm_list_followups / pipeline context'], outputSummary: '报告记载：核对商机、负责人、跟进与 pipeline；没有在这里重建原始 payload。' },
        { name: 'policy_advisor', status: 'partial', toolCalls: 2, claims: 0, tools: ['crm_get_org_memory','crm_search_knowledge'], outputSummary: '报告记载：memory 空，knowledge retrieval unavailable，缺 published_knowledge_sources。' }
      ],
      aggregate: { completedTools: 8, toolErrors: 0, specialists: 3, structuredClaims: 56, groundedWikiEvidence: 0, deterministicRevision: 5, deterministicVerdict: 'needs_review', deterministicScore: 87 },
      judge: { id: 'workbench_semantic_v1:opencode:space-bunny-free', verdict: 'pass', score: 88, durationMs: 19894, inputTokens: 9861, outputTokens: 2114, cacheReadTokens: 5260, costUsd: null, finalVerdict: 'needs_review', finalScore: 87 },
      costNote: '报告未给出货币成本。model 名含 free 不足以证明历史账单为零；此处不估算或伪造成本。'
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = fixtures;
  else root.CRM_LAB_FIXTURES = fixtures;
})(typeof globalThis !== 'undefined' ? globalThis : this);
