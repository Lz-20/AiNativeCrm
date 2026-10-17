/* Code-aligned inspection fixtures. This file never calls the CRM API or a model. */
(function () {
  'use strict';
  const ref = '12749abaa8aa98f7bee988f69fb4aa23e9d5ff29';
  const source = path => 'https://github.com/luckiest-draw/AiNativeCrm/blob/' + ref + '/' + path;
  const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const link = (path, label) => `<a href="${source(path)}" target="_blank" rel="noopener noreferrer">${h(label)}</a>`;
  const tabs = [['evidence','知识证据'],['memory','版本记忆'],['eval','Eval 理由'],['mission','客户发送'],['setup','代码与配置']];
  const ui = {tab:'evidence', source:'current', customer:'available', revision:3, eval:'review', reason:'', sourceOpen:false, sourceFocus:false};
  const badge = (text, warn = false) => `<span class="badge ${warn?'warn':''}">${h(text)}</span>`;
  const meta = (label,value) => `<div class="inspection-kv"><span>${h(label)}</span><strong>${h(value)}</strong></div>`;
  const button = (action, label, disabled = false) => `<button class="btn small" type="button" data-inspection="${action}" ${disabled?'disabled':''}>${h(label)}</button>`;
  function evidence() {
    return `<h3>成功工具观察的可读投影</h3><p>真实接口返回前，会重新核对组织、当前 Agent 的来源权限和来源可用性。只展示允许的知识片段。</p><label class="field">示例来源状态<select id="inspection-source"><option value="current" ${ui.source==='current'?'selected':''}>当前索引</option><option value="stale" ${ui.source==='stale'?'selected':''}>索引已经更新</option><option value="revoked" ${ui.source==='revoked'?'selected':''}>来源权限已撤回</option></select></label>${ui.source==='revoked'?'<div class="inspection-notice" role="status"><strong>该来源不再展示</strong><p>合成样例已隐藏历史摘录和来源链接。真实接口也会重新校验来源权限，不因旧 Run 读过就继续公开。</p></div>':`<article class="inspection-card" aria-label="合成知识证据"><div class="row between wrap"><h4>标准实施包 · 当前价格</h4>${badge(ui.source==='stale'?'索引已有更新，请重查':'current',ui.source==='stale')}</div><p>标准实施包含税价 CNY 12,000。折扣和交付日期需要各自负责人确认。</p><div class="inspection-metadata">全部字段与摘录为合成样例</div>${meta('来源 ID','demo-source-pricing')}${meta('读取索引','demo-index-v3')}${meta('当前索引',ui.source==='stale'?'demo-index-v4':'demo-index-v3')}${meta('片段 / 位置','demo-chunk-002 / 2')}${meta('内容指纹','demo-content-hash · 非真实哈希')}${button('source','查看精确来源样例')}${ui.sourceOpen?`<div class="inspection-source" id="inspection-source-detail" tabindex="-1"><h4>精确片段定位 · 合成 JSON</h4><pre>${h(JSON.stringify({source_id:'demo-source-pricing',index_version:'demo-index-v3',chunk_id:'demo-chunk-002',position:1,historical:ui.source==='stale',content:'标准实施包含税价 CNY 12,000；承诺前须核验批准。'},null,2))}</pre><p>生产来源链接使用对应 source / index / chunk 的本组织接口；这里没有可以请求的真实对象。</p></div>`:''}</article>`}<p class="inspection-notice">索引版本表示检索材料版本，不等于政策批准、生效时间或报价授权。</p>${link('lib/ai/agents/workbench-observed-evidence.ts','查看真实权限与证据投影实现')}`;
  }
  function memory() {
    return `<h3>已发布组织记忆</h3><p>初始轮、恢复轮和只读专家共用组织记忆解析器。恢复会重新读取当下的发布版本。</p><article class="inspection-card">${meta('合成母文档','demo-org-memory-v'+ui.revision)}${meta('快照指纹','demo-snapshot-'+ui.revision)}${meta('参与上下文','母文档 + active entries')}<p>${ui.revision===3?'示例 v3：报价和交期确认前，不得向客户作出承诺。':'示例 v4：保留批准边界，并要求在下一次跟进中说明未确认项。'}</p>${button('revision',ui.revision===3?'模拟恢复时读取 v4':'重置为示例 v3')}<p class="inspection-metadata">仅切换检查样例，不发布组织记忆。快照 hash 不是新建的发布 CAS 协议。</p></article><h3>当前会话客户 checkpoint</h3><label class="field">示例读取边界<select id="inspection-customer"><option value="available" ${ui.customer==='available'?'selected':''}>当前会话可用</option><option value="changed" ${ui.customer==='changed'?'selected':''}>服务边界已改变</option><option value="anonymized" ${ui.customer==='anonymized'?'selected':''}>联系人已匿名化 / 合并</option><option value="empty" ${ui.customer==='empty'?'selected':''}>当前范围没有 checkpoint</option></select></label>${ui.customer==='available'?`<article class="inspection-card" data-customer-checkpoint>${badge('read_only')}${meta('组织 / 联系人','demo-org / demo-contact')}${meta('会话 / 服务 revision','demo-conversation / 4')}${meta('需求 / revision','demo-demand / 2')}${meta('checkpoint seq','12')}${meta('记录时间（合成）','2026-10-01 08:30 UTC')}<h4>承诺</h4><p>10 月 2 日更新价格与排期核验进展。</p><h4>异议</h4><p>客户希望预算控制在 CNY 10,000。</p><h4>下一步</h4><p>核验折扣批准与交付负责人意见，再更新客户。</p></article>`:`<div class="inspection-notice" role="status"><strong>${ui.customer==='empty'?'empty':'unavailable'}</strong><p>${ui.customer==='changed'?'service_boundary_changed：读取前后的服务范围不同。':ui.customer==='anonymized'?'contact_memory_unavailable：不再展示残留的客户记忆。':'当前授权范围没有记录，不回退到该联系人的其他会话。'}</p></div>`}<p class="inspection-metadata">这是 conversation / service revision / demanda 范围内的只读数据，不支持任意客户记忆写入或 CAS。</p>${link('lib/agent-engine/agent/customer-memory.ts','查看真实客户 checkpoint 读取')} · ${link('lib/agent-engine/agent/org-memory.ts','查看共享组织记忆解析器')}`;
  }
  function evaluation() {
    const rows = [['任务完成','pass',[]],['答案质量','needs_review',[['structured_claims_not_independently_verified','结构化主张仍需独立核验；不是业务结果验收。']]],['知识与证据','needs_review',[['knowledge_evidence_empty','示例工具检索成功，但没有可引用的知识证据。']]],['工具可靠性','pass',[]],['策略合规','pass',[]],['执行效率','pass',[]],['多 Agent 协作','needs_review',[['demo_partial_specialist','合成样例中一个专家只有部分结果；此示例代码不是生产 finding。']]]];
    return `<h3>逐项查看判断理由</h3><p>以下为演示报告，未调用生产 evaluator。真实页面显示每个 dimension 的 verdict、finding message 和 code。</p><label class="field">示例评测状态<select id="inspection-eval"><option value="review" ${ui.eval==='review'?'selected':''}>需要复核 · 显示逐项理由</option><option value="unavailable" ${ui.eval==='unavailable'?'selected':''}>评测材料读取失败</option></select></label>${ui.eval==='unavailable'?'<div class="inspection-notice" role="alert"><strong>无法完成评测</strong><p>材料读取失败时拒绝生成评分；不能把缺失材料计为通过。</p><p>分数：未生成 · verdict：不可用</p></div>':`<div class="inspection-verdict">${badge('needs_review',true)}<span>合成结果 · 不设模型质量分数</span></div>${rows.map(([label,verdict,findings])=>`<article class="inspection-finding"><div class="row between wrap"><h4>${label}</h4>${badge(verdict,verdict==='needs_review')}</div>${findings.length?findings.map(([code,message])=>`<p>${message}<code>${code}</code></p>`).join(''):'<p class="inspection-metadata">此合成维度没有阻断 finding。</p>'}</article>`).join('')}`}<p class="inspection-notice">确定性检查不能确认自然语言事实、客户接受或商业目标。语义 Judge 需另行显式触发，可能消耗模型额度；本站没有触发入口。</p>${link('app/app/ai/workbench/_components/AgentCrmWorkbench.tsx','查看真实 Eval 详情界面')} · ${link('lib/ai/evals/evaluate-run.ts','查看实际评测规则')}`;
  }
  function mission() {
    const m = state.missions.find(x=>x.id===state.detail?.missionId) || state.missions[0];
    if(!m)return '<h3>没有可用的演示 Mission</h3>';
    const terminal=['已完成','已取消'].includes(m.status);
    return `<h3>Mission 客户发送控制</h3><article class="inspection-card" data-inspection-mission="${h(m.id)}"><h4>${h(m.goal)}</h4>${meta('业务状态',m.status)}${meta('客户发送',m.paused?'已暂停（模拟）':'允许进入后续审核（模拟）')}${meta('调查 / 证据读取','可以继续')}${terminal?'<p>已结束的 Mission 不再提供发送策略修改。</p>':`<label class="field">发送策略调整原因<textarea id="inspection-reason" rows="2" maxlength="2000" placeholder="至少 5 个字符">${h(ui.reason)}</textarea></label>${button('send-policy',m.paused?'恢复客户发送（模拟）':'暂停客户发送（模拟）',ui.reason.trim().length<5)}`}<p class="inspection-notice">仅控制此 Mission 的客户发送。调查可继续；在途消息可能已送达。恢复不会复活旧审批，仍须重新审核。</p><details class="inspection-audit" open><summary>本页策略记录</summary><ul>${m.history.map(line=>`<li>${h(line)}</li>`).join('')}</ul></details></article><p>此处只更新现有演示任务，刷新后重置。真实接口使用事务命令、原因和幂等 request key；没有暂停整个 Run。</p>${link('app/app/ai/workbench/_components/MissionSendControl.tsx','查看真实发送控制组件')}`;
  }
  function setup() {
    return `<h3>本次检查的源码</h3>${meta('分支','feat/chat-first-workbench-2026-10-01')}${meta('功能基线',ref)}<p>这个网址是静态交互预览，使用合成数据；发布它不会启动 Next.js、Supabase、Agent worker 或模型服务。</p><ol class="inspection-setup"><li>先让实际 CRM、数据库、事件 drainer / cron 和 worker 就绪。</li><li>配置组织模型凭据与支持工具调用的模型。不要在此页输入 Key。</li><li>单独准备 embeddings、已完成索引的知识来源和 Agent 允许读取的来源。聊天 Key 不自动提供这些能力。</li><li>发布组织记忆，以 manager 或更高角色在真实 Workbench 做只读测试。</li><li>核对证据、索引状态、Eval findings 和审批；客户发送还需要可用渠道、授权和正式校验。</li></ol><p class="inspection-notice">多轮聊天界面中的每次发送仍是独立 Run，不代表任意历史上下文自动共享。旧能力实验室的全流程暂停、客户记忆 CAS、故障注入和 JSON trace 属于实验设计。</p>${link('docs/design/crm-real-api-parity-2026-10-01.md','能力与配置边界')}<br>${link('docs/testing/crm-real-runtime-parity-2026-10-01.md','已提交的离线验证记录')}<br>${link('docs/architecture/chat-first-runtime-parity.architecture.json','真实功能连接图')}<p class="inspection-metadata">历史模型报告仍单独保留在能力实验室，沿用原始报告来源，不视为本次新运行。</p>`;
  }
  function panel() {
    return `<button class="agent-panel-scrim" data-action="close-agent-panel" aria-label="关闭更新检查"></button><aside class="agent-sidepanel inspection-panel" role="dialog" aria-modal="true" aria-labelledby="inspection-title"><div class="agent-panel-head"><div><span class="inspection-eyebrow">代码基线 ${ref.slice(0,7)}</span><h2 id="inspection-title">最新接线 · 检查样例</h2></div><button class="btn ghost" data-action="close-agent-panel" aria-label="关闭更新检查">×</button></div><div class="inspection-boundary">合成样例 · 非当前聊天的 Run 结果 · 无后端连接</div><div class="inspection-tabs" role="tablist" aria-label="更新检查">${tabs.map(([id,label])=>`<button type="button" role="tab" id="inspection-tab-${id}" data-inspection-tab="${id}" aria-selected="${ui.tab===id}" aria-controls="inspection-content" tabindex="${ui.tab===id?0:-1}">${label}</button>`).join('')}</div><div class="agent-panel-body" id="inspection-content" role="tabpanel" aria-labelledby="inspection-tab-${ui.tab}" tabindex="0">${({evidence,memory,eval:evaluation,mission,setup})[ui.tab]()}</div></aside>`;
  }
  const oldSidePanel = agentSidePanel;
  agentSidePanel = function(){return state.agentPanel==='inspection'?panel():oldSidePanel();};
  const oldRender = render;
  render = function(){
    oldRender();
    const bar=document.querySelector('.topbar .row');
    if(bar){const b=document.createElement('button');b.className='btn inspection-launch';b.type='button';b.dataset.openInspection='';b.textContent='更新检查 · '+ref.slice(0,7);bar.appendChild(b);}
    const header=document.querySelector('.agent-header-actions');
    if(header){const b=document.createElement('button');b.className='btn';b.type='button';b.dataset.openInspection='';b.textContent='证据与版本';header.appendChild(b);}
    const welcome=document.querySelector('.agent-welcome');
    if(welcome){const div=document.createElement('div');div.className='inspection-welcome';div.innerHTML='<strong>最新接线已加入检查样例</strong><p>知识证据、记忆版本、Eval 理由与客户发送控制</p><button type="button" class="btn" data-open-inspection>检查本次更新</button>';welcome.appendChild(div);}
    if(ui.sourceFocus){document.getElementById('inspection-source-detail')?.focus();ui.sourceFocus=false;}
  };
  function open(tab='evidence') {ui.tab=tab; if(state.drawer)state.drawer=null; if(state.page!=='/app/ai/workbench'&&state.page!=='workbench')navigate('/app/ai/workbench');openAgentPanel('inspection');}
  function selectTab(tab){ui.tab=tab;render();document.getElementById('inspection-tab-'+tab)?.focus();}
  document.addEventListener('click',e=>{
    if(e.target.closest('[data-open-inspection]')){open();return;}
    const tab=e.target.closest('[data-inspection-tab]');if(tab){selectTab(tab.dataset.inspectionTab);return;}
    const action=e.target.closest('[data-inspection]')?.dataset.inspection;if(!action)return;
    if(action==='source'){ui.sourceOpen=!ui.sourceOpen;ui.sourceFocus=ui.sourceOpen;}
    if(action==='revision')ui.revision=ui.revision===3?4:3;
    if(action==='send-policy'){
      const m=state.missions.find(x=>x.id===document.querySelector('[data-inspection-mission]')?.dataset.inspectionMission);
      if(!m||['已完成','已取消'].includes(m.status)||ui.reason.trim().length<5)return;
      m.paused=!m.paused;m.history.push('刚刚 · '+(m.paused?'暂停':'恢复')+'客户发送（本地模拟）：'+ui.reason.trim());
      if(m.paused)for(const r of state.runs)if(r.missionId===m.id&&['approved','pending'].includes(r.proposal))r.proposal='expired';
      ui.reason='';
    }
    render();
  });
  document.addEventListener('change',e=>{
    if(e.target.id==='inspection-source'){ui.source=e.target.value;ui.sourceOpen=false;render();document.getElementById('inspection-source')?.focus();}
    if(e.target.id==='inspection-customer'){ui.customer=e.target.value;render();document.getElementById('inspection-customer')?.focus();}
    if(e.target.id==='inspection-eval'){ui.eval=e.target.value;render();document.getElementById('inspection-eval')?.focus();}
  });
  document.addEventListener('input',e=>{if(e.target.id==='inspection-reason'){ui.reason=e.target.value;const b=document.querySelector('[data-inspection="send-policy"]');if(b)b.disabled=ui.reason.trim().length<5;}});
  document.addEventListener('keydown',e=>{if(!e.target.matches?.('[data-inspection-tab]')||!['ArrowRight','ArrowLeft','Home','End'].includes(e.key))return;e.preventDefault();let index=tabs.findIndex(([id])=>id===ui.tab);index=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;selectTab(tabs[index][0]);});
  window.CRM_INSPECTION={open,sourceRef:ref};
  render();
})();
