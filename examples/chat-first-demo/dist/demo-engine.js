/* Deterministic local execution. No model client, remote transport, or server durability. */
(function (root) {
  'use strict';
  const F = typeof module !== 'undefined' && module.exports ? require('./demo-fixtures.js') : root.CRM_LAB_FIXTURES;
  const clone = value => JSON.parse(JSON.stringify(value));
  const STORAGE_KEY = 'pinative.runtime-lab.v1';
  function createEngine(options = {}) {
    const now = options.now || (() => new Date().toISOString());
    const timer = options.timer || (() => typeof performance !== 'undefined' ? performance.now() : Date.now());
    const storage = options.storage;
    let persistence = 'memory-only', warning = '', state = empty();
    function empty() {
      return { schemaVersion: 1, fixtureId: F.scenarioId, runId: null, startedAt: null, status: 'idle', cursor: 0,
        goal: F.goal, scenario: 'standard', customer: clone(F.customer), wikiEnabled: true, retrieval: [],
        memories: [{ version: 1, body: '客户希望 CNY 10,000 与 10 月 9 日上线，仍需核验审批与排期。', sourceId: 'SRC-CUSTOMER-017' }], memoryVersion: 1,
        conflict: null, task: null, approved: false, attempt: 0, events: [], messages: [], checks: [], draft: null,
        mission: { status: 'not_started', acceptance: '负责人完成价格与交期核验，客户确认正式方案；运行结束不等于成交。' } };
    }
    function save() {
      if (!storage) return;
      try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); persistence = 'localStorage'; warning = ''; }
      catch { persistence = 'memory-only'; warning = '浏览器存储不可用，本次进度仅在此页内保留。'; }
    }
    function restore() {
      if (!storage) return;
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) { persistence = 'localStorage'; return; }
        const stored = JSON.parse(raw);
        if (stored.schemaVersion !== 1 || stored.fixtureId !== F.scenarioId || !Array.isArray(stored.events) || !Array.isArray(stored.memories) || !Number.isInteger(stored.cursor) || stored.cursor < 0 || stored.cursor > 9 || !['idle','running','paused','waiting_approval','blocked','retryable_failure','completed'].includes(stored.status)) throw new Error('Invalid checkpoint');
        state = stored; persistence = 'localStorage';
      } catch { state = empty(); warning = '上次实验存档无法读取，已使用干净的虚构场景；可以重置。'; }
    }
    function event(tool, input, fn, explanation) {
      const started = timer(), timestamp = now();
      const output = fn();
      const item = { id: 'local-' + String(state.events.length + 1).padStart(3, '0'), sequence: state.events.length + 1,
        kind: 'executed_local_fixture', tool, timestamp, durationMs: Math.max(0, +(timer() - started).toFixed(3)),
        input: clone(input), output: clone(output), explanation, model: null, provider: null, tokens: null,
        cost: { amount: 0, currency: 'USD', basis: 'No model or external service invoked' } };
      state.events.push(item); return output;
    }
    function message(text) { state.messages.push({ text, evidence: state.events.at(-1)?.id || null }); }
    function retrieve(query) {
      const q = query.toLowerCase();
      return F.wiki.filter(d => d.tenantId === F.tenantId && d.published && d.active && state.wikiEnabled)
        .map(d => ({ ...clone(d), score: d.terms.filter(t => q.includes(t.toLowerCase())).length }))
        .filter(d => d.score > 0).sort((a,b) => b.score - a.score || a.id.localeCompare(b.id));
    }
    function publishMemory(expectedVersion, body, sourceId) {
      if (expectedVersion !== state.memoryVersion) return { ok: false, code: 'DEMO_VERSION_CONFLICT', expectedVersion, actualVersion: state.memoryVersion, changed: false };
      const version = state.memoryVersion + 1;
      state.memories.push({ version, body, sourceId }); state.memoryVersion = version;
      return { ok: true, version, body, sourceId };
    }
    function start(scenario = 'standard', goal = F.goal) {
      if (state.status !== 'idle') return false;
      state.scenario = ['standard','missing_wiki','bad_claim'].includes(scenario) ? scenario : 'standard';
      state.goal = String(goal).trim().slice(0, 1000) || F.goal;
      state.runId = 'local-' + now(); state.startedAt = now(); state.wikiEnabled = state.scenario !== 'missing_wiki';
      state.status = 'running'; state.mission.status = 'in_progress';
      event('fixture.load_context', { scenario: state.scenario, tenantId: F.tenantId }, () => ({ customer: state.customer, customerSources: F.customerSources, scope: 'fictional_customer', model: null }), '从内置虚构 fixture 读取客户要求与承诺。');
      message('客户希望 CNY 10,000、10 月 9 日上线。这是请求，不是已批准价格或交期。先核对已发布 Wiki。'); save(); return true;
    }
    function step() {
      if (state.status !== 'running') return false;
      switch (state.cursor) {
        case 0: {
          const result = event('local.search_published_wiki', { query: '标准实施包 报价 折扣 交期 上线', requestedTask: state.goal, tenantId: F.tenantId, method: 'deterministic_keyword_overlap', maxResults: 4 }, () => {
            state.retrieval = retrieve('标准实施包 报价 折扣 交期 上线');
            return { status: state.retrieval.length ? 'grounded_fixture' : 'unavailable', evidence: state.retrieval, excluded: ['superseded_revision', 'other_tenant'] };
          }, '真实执行本地过滤和排序；不是 embedding 或生产 RAG 调用。');
          if (!result.evidence.length) { state.status = 'blocked'; message('没有可引用的 Wiki。任务已阻塞，不能猜价格或审批规则。发布演示资料后从本 checkpoint 重试。'); save(); return true; }
          message('检索命中当前价格 v3 和交期规则 v2。10,000 相对 12,000 降价 16.67%，需要商务负责人逐单批准。历史价与其他组织内容已排除。'); break;
        }
        case 1:
          event('local.read_memory', { scope: 'customer', customerId: state.customer.id }, () => ({ version: state.memoryVersion, memory: state.memories.at(-1) }), '读取当前快照。');
          message('记忆 v1 保留客户愿望和来源，尚未把愿望改写成我方承诺。'); break;
        case 2:
          event('local.publish_memory', { expectedVersion: 1, scope: 'customer' }, () => publishMemory(1, '客户请求 CNY 10,000；当前标准价 CNY 12,000。折扣待商务批准，交期待交付负责人确认，不对外承诺。', 'SRC-PRICE-003 + SRC-DELIVERY-002'), '创建 v2，保留 v1。冲突比较是本地实验契约。');
          message('记忆已更新为 v2：引用当前政策并保留两个待确认项。旧版本仍可查看。'); break;
        case 3:
          event('local.publish_memory', { expectedVersion: 1, body: '已批准 CNY 10,000 和 10 月 9 日上线', injectedStaleWrite: true }, () => {
            state.conflict = publishMemory(1, '已批准 CNY 10,000 和 10 月 9 日上线', 'stale-writer'); return state.conflict;
          }, '故意输入一个过期写者，验证不会覆盖较新版本。');
          message('过期写者携带 v1 试图覆盖 v2，被 DEMO_VERSION_CONFLICT 拒绝；没有静默覆盖记忆。'); break;
        case 4:
          event('local.resolve_conflict', { strategy: 'keep_latest', sourceRevision: 2 }, () => { state.conflict.resolved = true; return { version: state.memoryVersion, resolution: 'keep_v2', discardedUnsupportedClaim: true }; }, '读取当前版本，保留已核对内容；没有将冲突当成功。');
          message('冲突已解决：保留 v2，丢弃没有批准证据的旧写入。'); break;
        case 5:
          event('local.checkpoint_task', { next: 'create_internal_followup', requires: 'human_approval' }, () => {
            state.task = { id: 'demo-followup-starbridge', status: 'awaiting_approval', target: state.customer.leadId, title: '核验折扣与交期后更新客户', due: '2026-10-02T07:00:00Z', committed: false, idempotencyKey: 'starbridge-followup-v1' };
            state.status = 'waiting_approval'; return { task: state.task, checkpoint: 6, nextAction: 'approve or remain paused' };
          }, '保存后暂停。刷新页面仍需人工批准，不能自动跨过此门。');
          message('已保存 checkpoint。请审阅内部跟进任务并批准继续；不会向客户发送消息。'); break;
        case 6:
          event('local.commit_followup', { idempotencyKey: state.task.idempotencyKey, attempt: state.attempt + 1, target: 'browser_fixture_store' }, () => {
            state.attempt++;
            if (state.attempt === 1) { state.status = 'retryable_failure'; state.task.status = 'retryable_failure'; return { ok: false, code: 'INJECTED_TRANSIENT_FAILURE', retryable: true, committed: false }; }
            state.task.committed = true; state.task.status = 'open'; return { ok: true, task: state.task, uniqueTaskCount: 1 };
          }, '第一轮故障是明示注入的演示故障；重试复用同一个任务 ID。没有真实网络请求。');
          if (state.status === 'retryable_failure') { message('首次本地任务提交触发预设临时故障。checkpoint 和批准保留，可以重试，不会再建一个任务。'); save(); return true; }
          message('重试成功，同一幂等键只提交了一个内部任务。业务结果仍未验收。'); break;
        case 7:
          event('local.compose_cited_draft', { template: 'policy-grounded-zh-v1', evidenceIds: state.retrieval.map(x => x.id), memoryVersion: state.memoryVersion }, () => {
            state.draft = { text: '标准实施包当前含税价 CNY 12,000 [SRC-PRICE-003 v3]。您提出的 CNY 10,000 需要商务负责人批准；10 月 9 日尚未确认，交期须核验资料与排期 [SRC-DELIVERY-002 v2]。我们会按约定在 10 月 2 日 15:00 前更新确认进展 [SRC-REP-019]。', citations: ['SRC-PRICE-003','SRC-DELIVERY-002','SRC-REP-019'], assertedLeadStatus: state.scenario === 'bad_claim' ? 'won' : 'open', sent: false, generatedBy: 'deterministic_template' };
            return state.draft;
          }, '模板组合已核对证据；不是模型生成。错误主张场景故意把 open 改成 won。');
          message('草稿已准备，引用来源可展开。' + (state.scenario === 'bad_claim' ? '此对照场景注入了“商机已成交”的错误结构化主张，交给 Eval 拦截。' : '它区分客户请求、政策和已作出的进展更新承诺。')); break;
        case 8:
          event('local.evaluate', { profile: 'offline_lab_v1', productionEvaluator: false }, () => { state.checks = evaluate(); state.status = 'completed'; state.mission.status = 'awaiting_acceptance'; return { verdict: state.checks.every(x => x.pass) ? 'pass' : 'fail', checks: state.checks, semanticJudge: 'not_run', businessAcceptance: false }; }, '逐条运行确定性断言，结果来自当前状态和事件，不是预填分数。');
          message(state.checks.every(x => x.pass) ? '本地断言全部通过。运行结束；业务任务仍等待核验与客户确认，不能自动标记成交。' : 'Eval 拦截了错误主张。运行已结束，但不满足业务验收，不能把它展示成成功。'); break;
        default: return false;
      }
      state.cursor++; save(); return true;
    }
    function evaluate() {
      const eventId = tool => state.events.find(x => x.tool === tool)?.id || null;
      return [
        { id: 'grounded', label: '引用只来自当前已发布来源', pass: state.retrieval.length >= 2 && state.retrieval.every(x => x.tenantId === F.tenantId && x.active && x.published), evidence: eventId('local.search_published_wiki') },
        { id: 'version', label: '过期写入被拒绝，v1/v2 都保留', pass: state.memoryVersion === 2 && state.memories.length === 2 && state.conflict?.code === 'DEMO_VERSION_CONFLICT' && state.conflict.resolved === true, evidence: state.events.find(x => x.output.code === 'DEMO_VERSION_CONFLICT')?.id || null },
        { id: 'approval', label: '提交任务前有明确人工批准', pass: state.approved && state.events.findIndex(x => x.tool === 'human.approve') < state.events.findIndex(x => x.tool === 'local.commit_followup'), evidence: eventId('human.approve') },
        { id: 'retry', label: '重试复用任务 ID，不产生重复任务', pass: state.attempt === 2 && state.task?.committed && state.task.id === 'demo-followup-starbridge', evidence: state.events.filter(x => x.tool === 'local.commit_followup').at(-1)?.id || null },
        { id: 'fact', label: '结构化主张与读取的商机状态一致', pass: state.draft?.assertedLeadStatus === state.customer.status, evidence: eventId('local.compose_cited_draft') },
        { id: 'boundary', label: '没有发送客户消息或调用模型', pass: state.draft?.sent === false && state.events.every(x => x.model === null && x.cost.amount === 0), evidence: eventId('local.compose_cited_draft') },
        { id: 'mission', label: '运行完成不等于业务验收', pass: state.mission.status !== 'accepted', evidence: eventId('local.checkpoint_task') }
      ];
    }
    function run() { if (state.status === 'idle') start(); for (let limit = 0; limit < 12 && state.status === 'running'; limit++) step(); }
    function pause() { if (state.status !== 'running') return false; event('human.pause', {}, () => { state.status = 'paused'; return { checkpoint: state.cursor }; }, '手动暂停'); message('已暂停。你可以刷新页面，再从这个 checkpoint 继续。'); save(); return true; }
    function resume() { if (state.status !== 'paused') return false; event('human.resume', { checkpoint: state.cursor }, () => { state.status = 'running'; return { nextStep: state.cursor }; }, '从本地 checkpoint 继续'); message('已恢复，完成的步骤不重做。'); save(); return true; }
    function approve() { if (state.status !== 'waiting_approval') return false; event('human.approve', { taskId: state.task.id }, () => { state.approved = true; state.status = 'running'; state.task.status = 'approved'; return { approved: true, externalSend: false }; }, '用户批准的只是本地实验任务'); message('已批准内部任务。下一步提交到本地 fixture store。'); save(); return true; }
    function retry() { if (state.status !== 'retryable_failure') return false; event('human.retry', { checkpoint: state.cursor, existingTaskId: state.task.id }, () => { state.status = 'running'; return { retryScheduled: true, nextAttempt: state.attempt + 1 }; }, '重试故障步骤，保留此前批准'); save(); return true; }
    function publishWiki() { if (state.status !== 'blocked') return false; event('human.publish_fixture', { sources: ['SRC-PRICE-003','SRC-DELIVERY-002'] }, () => { state.wikiEnabled = true; state.status = 'running'; return { published: true, nextStep: state.cursor }; }, '仅启用本地演示资料'); message('演示资料已启用，再运行检索；之前的缺口仍保留在 trace 中。'); save(); return true; }
    function accept() { if (state.status !== 'completed' || !state.checks.every(x => x.pass) || state.mission.status === 'accepted') return false; event('human.accept_fixture_outcome', { simulatedConfirmation: true }, () => { state.mission.status = 'accepted'; state.task.status = 'done'; return { accepted: true, actualCustomerConfirmation: false, leadStatus: state.customer.status }; }, '用户手动模拟验收，不声称真实客户确认，也不改变商机成交状态'); message('已记录模拟验收。真实系统还需要真实批准、交付与客户证据。'); save(); return true; }
    function reset() { state = empty(); try { storage?.removeItem(STORAGE_KEY); } catch { warning = '无法删除浏览器存档；本页已重置。'; } }
    restore();
    return { getState: () => clone(state), getPersistence: () => ({ mode: persistence, warning }), start, step, run, pause, resume, approve, retry, publishWiki, accept, reset, retrieve, evaluate, storageKey: STORAGE_KEY };
  }
  const api = { createEngine, STORAGE_KEY, fixtures: F };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CRM_DEMO_ENGINE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
