/* Isolated no-key laboratory. Existing CRM navigation and chat remain intact. */
(function () {
  'use strict';
  const F = window.CRM_LAB_FIXTURES;
  let storage;
  try { storage = window.localStorage; } catch { /* graceful memory-only fallback */ }
  const engine = window.CRM_DEMO_ENGINE.createEngine({ storage });
  const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const labels = { idle:'待开始', running:'可执行下一步', paused:'已暂停', waiting_approval:'等待人工批准', blocked:'知识缺口阻塞', retryable_failure:'临时故障 · 可重试', completed:'运行已结束' };
  let opened = false, tab = 'wiki', replay = null, returnFocus = null, resetConfirm = false;
  const button = (action, label, primary = false, disabled = false) => `<button type="button" class="btn ${primary?'primary':''}" data-lab="${action}" ${disabled?'disabled':''}>${label}</button>`;
  const sourceLink = (url, label) => `<a href="${html(url)}" target="_blank" rel="noopener noreferrer">${html(label)} ↗</a>`;
  const json = value => `<pre>${html(JSON.stringify(value,null,2))}</pre>`;
  const pill = (text, status = '') => `<span class="lab-pill ${status}">${html(text)}</span>`;
  function open(opener) {
    if (opened) return;
    returnFocus = opener || document.activeElement; opened = true;
    document.getElementById('app').setAttribute('inert','');
    draw(); document.querySelector('[data-lab="close"]')?.focus();
  }
  function close() {
    opened = false; document.getElementById('runtime-lab')?.remove(); document.getElementById('app').removeAttribute('inert');
    if (returnFocus?.isConnected) returnFocus.focus(); else document.querySelector('[data-open-lab]')?.focus();
  }
  function stateControls(s) {
    if (s.status === 'idle') return `<label class="lab-scenario-label">对照场景<select id="lab-scenario"><option value="standard">完整链路：审批 + 失败重试</option><option value="missing_wiki">缺少 Wiki：先阻塞再补资料</option><option value="bad_claim">错误主张：让 Eval 拦截</option></select></label><label class="sr-only" for="lab-goal">本次实验任务</label><textarea id="lab-goal" rows="2" maxlength="1000">${html(F.goal)}</textarea><div class="lab-actions">${button('start','开始实验',true)}<small>固定报价审核流程；文字作为任务背景保存，不由模型理解</small></div>`;
    const controls = [];
    if (s.status === 'running') controls.push(button('step','执行下一步',true),button('run','运行至下一关卡'),button('pause','暂停'));
    if (s.status === 'paused') controls.push(button('resume','恢复运行',true));
    if (s.status === 'waiting_approval') controls.push(button('approve','批准本地跟进任务',true));
    if (s.status === 'retryable_failure') controls.push(button('retry','重试失败步骤',true));
    if (s.status === 'blocked') controls.push(button('publish','启用演示 Wiki 并重试',true));
    if (s.status === 'completed') controls.push(button('accept',s.mission.status==='accepted'?'已模拟验收':'模拟业务验收',true,s.mission.status==='accepted'||!s.checks.every(c=>c.pass)));
    return `<div class="lab-next"><span>${nextAction(s)}</span></div><div class="lab-actions">${controls.join('')}</div>`;
  }
  function nextAction(s) {
    return ({ running:`Checkpoint ${s.cursor}/9 · 单步查看输入/输出，或运行到需要你决定的地方`, paused:'本地 checkpoint 已保存。刷新后仍暂停，点击恢复继续。', waiting_approval:'审阅右侧任务与来源。批准仅影响虚构任务，不发送消息。', retryable_failure:'第一轮失败为显式注入。重试保留批准与幂等键，不重复创建任务。', blocked:'没有已发布来源，不能猜答案。启用本地虚构 Wiki 后重新检索。', completed:s.mission.status==='accepted'?'模拟验收已记录；这不是一次真实客户验收。':s.checks.some(x=>!x.pass)?'存在失败断言，业务验收被阻止。查看 Eval 证据。':'运行通过本地断言。业务任务仍待真实业务条件成立，此处可以模拟验收。' })[s.status] || '';
  }
  function wikiPanel(s) {
    return `<div class="lab-panel-title"><h3>来源与检索</h3>${pill(s.retrieval.length+' 个命中')}</div><p class="lab-muted">关键词排序实际在此页执行。版本、发布状态与组织过滤是本地 fixture 规则；不是生产向量检索。</p>${s.retrieval.length?`<div class="lab-mini-result">当前价 CNY 12,000 → 客户请求 CNY 10,000<br><strong>降幅 ${((1-10000/12000)*100).toFixed(2)}% · 需商务批准</strong></div>`:''}${F.wiki.filter(d=>d.tenantId===F.tenantId).map(d=>`<details class="lab-doc" ${d.active?'open':''} id="lab-source-${d.id}"><summary><span>${html(d.title)}</span>${pill('v'+d.revision,d.active?'good':'muted')}</summary><p>${html(d.content)}</p><div class="lab-doc-meta">${html(d.id)} · ${s.wikiEnabled&&d.published?'已发布':'未启用'} · ${d.active?'当前有效':'已被替代，不进入检索'}</div>${s.retrieval.find(x=>x.id===d.id)?`<small>关键词命中 ${s.retrieval.find(x=>x.id===d.id).score} · 来源：${html(d.section)}</small>`:''}</details>`).join('')}<h3 class="lab-section-title">客户范围的材料</h3>${F.customerSources.map(d=>`<details class="lab-doc" id="lab-source-${d.id}"><summary>${html(d.id)} · ${html(d.classification)}</summary><p>${html(d.content)}</p><small>仅客户上下文 · 不提升为组织政策</small></details>`).join('')}<p class="lab-muted">星桥商贸、价格、日期、审批规则均为虚构样例。它们与同一分支的 docs/design/llm-wiki-example 对齐。</p>`;
  }
  function memoryPanel(s) {
    return `<div class="lab-panel-title"><h3>版本化记忆</h3>${pill('当前 v'+s.memoryVersion,'good')}</div><p class="lab-muted">客户范围的实验快照。生产已有组织记忆版本与指针；这里的 expectedVersion 乐观冲突拒绝仅是演示保护。</p>${s.memories.map(m=>`<article class="lab-memory ${m.version===s.memoryVersion?'current':''}"><div class="lab-panel-title"><strong>v${m.version}</strong>${pill(m.version===s.memoryVersion?'当前指针':'保留历史')}</div><p>${html(m.body)}</p><small>来源 ${html(m.sourceId)}</small></article>`).join('')}${s.conflict?`<div class="lab-alert"><strong>DEMO_VERSION_CONFLICT</strong><p>写者预期 v${s.conflict.expectedVersion}，当前是 v${s.conflict.actualVersion}。${s.conflict.resolved?'已保留 v2，拒绝无证据主张。':'等待重新读取并解决。'}</p>${json(s.conflict)}</div>`:'<p class="lab-muted">执行到第 4 步会故意提交一个过期 v1 写入，验证 v2 不被覆盖。</p>'}`;
  }
  function taskPanel(s) {
    return `<div class="lab-panel-title"><h3>任务与业务结果</h3>${pill(labels[s.status])}</div><ol class="lab-state-flow"><li class="done">queued</li><li class="${s.runId?'done':''}">running</li><li class="${s.approved?'done':''}">waiting_approval</li><li class="${s.attempt?'done':''}">retryable_failure</li><li class="${s.status==='completed'?'done':''}">completed</li></ol>${s.task?`<article class="lab-memory"><h3>${html(s.task.title)}</h3><p>${html(s.task.target)} · ${pill(s.task.status)}</p><dl><dt>截止（虚构）</dt><dd>2026-10-02 15:00 +08:00</dd><dt>幂等键</dt><dd>${html(s.task.idempotencyKey)}</dd><dt>提交次数</dt><dd>${s.attempt} · 已创建任务 ${s.task.committed?1:0}</dd><dt>批准</dt><dd>${s.approved?'已由你在实验内批准':'尚未批准'}</dd></dl></article>`:'<p class="lab-muted">核对来源与记忆后，才准备内部跟进任务。</p>'}<article class="lab-memory"><h3>业务验收单独记录</h3><p>${html(s.mission.acceptance)}</p>${pill(s.mission.status==='accepted'?'已模拟验收':s.mission.status==='awaiting_acceptance'?'等待业务验收':'未完成业务结果','warn')}<p class="lab-muted">没有真实发送、定价批准或客户确认。即使模拟验收也不把商机直接改成 won。</p></article><div class="lab-alert"><strong>浏览器持久化边界</strong><p>仅 localStorage；刷新可恢复。清除浏览器数据会丢失，不跨设备，不证明服务端队列、worker lease 或崩溃恢复。</p></div>`;
  }
  function evalPanel(s) {
    return `<div class="lab-panel-title"><h3>本次确定性 Eval</h3>${pill(s.checks.length?(s.checks.every(x=>x.pass)?'PASS':'FAIL'):'尚未执行',s.checks.length&&s.checks.every(x=>x.pass)?'good':'warn')}</div><p class="lab-muted">offline_lab_v1 · 根据本次内存与事件实际求值。不是生产 evaluator 或语义 Judge；没有“模型质量分数”。</p>${s.checks.length?s.checks.map(c=>`<article class="lab-check ${c.pass?'pass':'fail'}"><span aria-label="${c.pass?'通过':'失败'}">${c.pass?'✓':'✕'}</span><div><strong>${html(c.label)}</strong><small>${html(c.id)}</small>${c.evidence?`<button class="lab-textbtn" data-lab-trace="${html(c.evidence)}">查看证据 ${html(c.evidence)} →</button>`:''}</div></article>`).join(''):'<p class="lab-muted">完成运行后评测 7 条规则。试试“错误主张”场景：商机读到 open，却声明 won，事实一致性必须失败。</p>'}${s.draft?`<h3 class="lab-section-title">待审草稿 · 未发送</h3><article class="lab-draft"><p>${html(s.draft.text)}</p><div class="lab-citations">${s.draft.citations.map(id=>`<button data-lab-source="${html(id)}">${html(id)} ↗</button>`).join('')}</div><small>结构化主张：lead.status = ${html(s.draft.assertedLeadStatus)}<br>CRM 读取事实：lead.status = ${html(s.customer.status)}</small></article>`:''}`;
  }
  function tracePanel(s) {
    const list = replay===null?s.events:s.events.slice(0,replay);
    return `<div class="lab-panel-title"><h3>本次执行 Trace</h3>${pill('LOCAL · 非 LLM')}</div><p class="lab-muted">本机实际调用、参数、结果和耗时。时间戳为运行时采集；数据来自虚构 fixture。展开可审阅，不含内部推理。</p><div class="lab-metrics"><div><strong>${s.events.length}</strong><small>本地事件</small></div><div><strong>0</strong><small>模型调用</small></div><div><strong>$0</strong><small>模型 / 服务费用</small></div></div><p class="lab-muted">Tokens: 不适用 · model: null · 不推算基础设施或浏览器成本</p><div class="lab-actions">${button('replay','从头回放',false,!s.events.length)}${replay!==null?button('replay-next','下一条 '+replay+'/'+s.events.length,false,replay>=s.events.length)+button('replay-end','退出回放'):''}${button('export','导出本地 Trace',false,!s.events.length)}</div>${replay!==null?'<p class="lab-notice">只读回放已记录事件，不重新执行、不改任务状态。</p>':''}${list.map(e=>`<details class="lab-trace-item" data-lab-event="${html(e.id)}"><summary><span class="lab-event-number">${e.sequence}</span><span><strong>${html(e.tool)}</strong><small>${html(e.timestamp)} · ${e.durationMs} ms</small></span>${e.output.ok===false?pill('可见失败','warn'):pill('已记录')}</summary><p>${html(e.explanation)}</p><h4>输入</h4>${json(e.input)}<h4>输出</h4>${json(e.output)}<small>${html(e.kind)} · provider/model: null · tokens: N/A · cost: USD 0</small></details>`).join('')}${!list.length?'<p class="lab-muted">开始后这里显示真实的本地执行记录。</p>':''}`;
  }
  function historicalPanel() {
    const h=F.historical,a=h.aggregate,j=h.judge;
    return `<div class="lab-panel-title"><h3>仓库历史模型证据</h3>${pill('历史报告摘录')}</div><div class="lab-alert"><strong>真实报告 ≠ 本次新运行</strong><p>${html(h.limitations)}</p></div><dl><dt>记录日期</dt><dd>${h.capturedDate}</dd><dt>Provider / Model</dt><dd>${h.provider} / ${h.model}</dd><dt>Run</dt><dd>${h.reportRunId}</dd><dt>模式</dt><dd>${h.mode} · 只读</dd><dt>来源提交</dt><dd>${h.sourceRef.slice(0,12)}</dd></dl>${sourceLink(h.sourceUrl,'打开已提交验收报告')}<div class="lab-metrics"><div><strong>${a.completedTools} / ${a.toolErrors}</strong><small>工具完成 / 错误</small></div><div><strong>${a.structuredClaims}</strong><small>结构化 claims</small></div><div><strong>${a.groundedWikiEvidence}</strong><small>Wiki 证据</small></div></div>${h.specialists.map(x=>`<details class="lab-trace-item"><summary><span><strong>${x.name}</strong><small>${x.toolCalls} tools · ${x.claims} claims</small></span>${pill(x.status,x.status==='partial'?'warn':'good')}</summary><p>${html(x.outputSummary)}</p><h4>报告列出的工具</h4><ul>${x.tools.map(t=>`<li>${html(t)}</li>`).join('')}</ul><p class="lab-muted">原始逐条参数和输出未随报告提交，不能从此摘要还原。</p></details>`).join('')}<h3 class="lab-section-title">Eval 与成本证据</h3><div class="lab-check fail"><span>!</span><div><strong>最终 needs_review · 87</strong><p>确定性 profile revision 5：needs_review / 87。语义 Judge：pass / 88。语义评分没有覆盖“无 Wiki 证据、partial specialist”的确定性门禁。</p></div></div><dl><dt>Judge 调用耗时</dt><dd>${j.durationMs.toLocaleString()} ms</dd><dt>输入 / 输出 tokens</dt><dd>${j.inputTokens.toLocaleString()} / ${j.outputTokens.toLocaleString()}</dd><dt>Cache-read tokens</dt><dd>${j.cacheReadTokens.toLocaleString()}</dd><dt>历史货币成本</dt><dd>未记录</dd></dl><p class="lab-muted">${html(h.costNote)}这些 tokens 仅属于报告中的 Judge 调用，不是整条运行总量。</p>`;
  }
  function sourcesPanel() { return `<h3>原实现与本实验的边界</h3><p class="lab-muted">源代码阅读基线 ${F.sourceRef.slice(0,12)}。本实验是独立的浏览器实现；没有部署真实 Supabase/worker 栈。</p>${F.capabilities.map(c=>`<article class="lab-doc"><h4>${html(c.name)}</h4><p>${html(c.boundary)}</p>${sourceLink(c.url,c.path)}</article>`).join('')}<div class="lab-alert"><strong>不开外部连接</strong><p>无模型密钥、模型 API、WhatsApp、飞书、数据库或外发消息。只有你主动点击源码链接才会打开 GitHub。</p></div>`; }
  function draw() {
    if (!opened) return;
    const previous = document.getElementById('runtime-lab'), focused = document.activeElement?.id, focusedAction = document.activeElement?.dataset?.lab;
    const openEvents = [...(previous?.querySelectorAll('[data-lab-event][open]')||[])].map(e=>e.dataset.labEvent);
    const scroll=previous?.querySelector('.lab-evidence-body')?.scrollTop || 0;
    const s=engine.getState(),p=engine.getPersistence();
    const el=previous||document.createElement('section');el.id='runtime-lab';el.className='lab-layer';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-labelledby','lab-title');
    const tabs=[['wiki','Wiki / 来源'],['memory','记忆'],['task','任务'],['eval','Eval'],['trace','本次 Trace'],['history','历史模型证据'],['sources','实现依据']];
    const panels={wiki:()=>wikiPanel(s),memory:()=>memoryPanel(s),task:()=>taskPanel(s),eval:()=>evalPanel(s),trace:()=>tracePanel(s),history:historicalPanel,sources:sourcesPanel};
    el.innerHTML=`<header class="lab-header"><div><div class="lab-eyebrow">PI NATIVE CRM / RUNTIME LAB</div><h2 id="lab-title">零密钥能力实验室</h2></div><div class="lab-actions">${button('reset','重置')}${button('close','返回 CRM ×')}</div></header><div class="lab-safety"><span class="lab-online-dot"></span>本地确定性执行 · 虚构客户 · 非 LLM <span class="lab-persistence">${p.mode==='localStorage'?'进度保存于此浏览器':'仅本页保留'}</span></div>${p.warning?`<p class="lab-storage-warning" role="alert">${html(p.warning)}</p>`:''}${resetConfirm?`<div class="lab-reset" role="alert"><span>清除实验室的本地进度与 trace？其他 CRM 页面不受影响。</span>${button('confirm-reset','确认重置')}${button('cancel-reset','保留进度')}</div>`:''}<div class="lab-workspace"><section class="lab-chat"><div class="lab-chat-heading"><div><strong>星桥商贸 · 报价与交付审核</strong><small>客户请求 → 证据 → 记忆 → 审批 → Eval</small></div>${pill(labels[s.status],s.status==='completed'?'good':'')}</div><div class="lab-chat-log" role="log" aria-live="polite" aria-label="实验执行消息">${s.status==='idle'?`<div class="lab-welcome"><div class="lab-welcome-symbol">◈</div><h3>看清一次任务怎样推进</h3><p>同一虚构客户，贯穿 Wiki 检索、记忆版本冲突和可恢复任务。每一步都能查看参数、结果和依据。</p><ol><li>核对当前价格与承诺边界</li><li>拒绝过期记忆写入</li><li>在批准处暂停，刷新后恢复</li><li>重试失败步骤，检查 Eval</li></ol><button class="lab-textbtn" data-lab-tab="history">先看仓库中的历史真实模型报告 →</button></div>`:`<div class="lab-user-message">${html(s.goal)}</div>${s.messages.map((m,i)=>`<article class="lab-message"><span class="lab-message-mark">${i+1}</span><div><small>本地执行器</small><p>${html(m.text)}</p>${m.evidence?`<button class="lab-textbtn" data-lab-trace="${html(m.evidence)}">${html(m.evidence)} · 查看输入/输出 ↗</button>`:''}</div></article>`).join('')}`}</div><div class="lab-composer">${stateControls(s)}<p>没有客户发送。运行完成与业务验收分别记录。</p></div></section><aside class="lab-evidence"><div class="lab-tabs" role="tablist" aria-label="实验依据">${tabs.map(([id,label])=>`<button role="tab" id="lab-tab-${id}" aria-controls="lab-panel" aria-selected="${id===tab}" data-lab-tab="${id}" tabindex="${id===tab?0:-1}">${label}</button>`).join('')}</div><div class="lab-evidence-body" id="lab-panel" role="tabpanel" aria-labelledby="lab-tab-${tab}" tabindex="0">${panels[tab]()}</div></aside></div>`;
    if (!previous) document.body.appendChild(el);
    for(const item of el.querySelectorAll('[data-lab-event]')) if(openEvents.includes(item.dataset.labEvent))item.open=true;
    el.querySelector('.lab-evidence-body').scrollTop=scroll;
    el.querySelector('.lab-chat-log').scrollTop=el.querySelector('.lab-chat-log').scrollHeight;
    if(focused)document.getElementById(focused)?.focus();
    else if(focusedAction){const same=el.querySelector('[data-lab="'+focusedAction+'"]:not([disabled])');(same||el.querySelector('.lab-composer button:not([disabled])'))?.focus();}
  }
  function showEvidence(id, type) {
    tab=type==='trace'?'trace':'wiki'; replay=null;draw();
    const target=type==='trace'?document.querySelector(`[data-lab-event="${id}"]`):document.getElementById('lab-source-'+id);
    if(target){target.open=true;target.scrollIntoView?.({block:'nearest'});target.querySelector('summary')?.focus();}
  }
  function act(action) {
    if(action==='close')return close();
    if(action==='reset'){resetConfirm=true;draw();document.querySelector('[data-lab="confirm-reset"]')?.focus();return;}
    if(action==='cancel-reset'){resetConfirm=false;draw();return;}
    if(action==='confirm-reset'){engine.reset();resetConfirm=false;replay=null;tab='wiki';draw();document.getElementById('lab-goal')?.focus();return;}
    if(action==='start'){engine.start(document.getElementById('lab-scenario').value,document.getElementById('lab-goal').value);engine.step();}
    if(action==='step')engine.step();
    if(action==='run')engine.run();
    if(action==='pause')engine.pause();
    if(action==='resume')engine.resume();
    if(action==='approve'){engine.approve();tab='task';}
    if(action==='retry'){engine.retry();engine.step();}
    if(action==='publish'){engine.publishWiki();engine.step();}
    if(action==='accept')engine.accept();
    if(action==='replay'){tab='trace';replay=0;}
    if(action==='replay-next')replay=Math.min(engine.getState().events.length,replay+1);
    if(action==='replay-end')replay=null;
    if(action==='export'){
      const payload={provenance:{kind:'executed_local_fixture',scenario:F.scenarioId,sourceRef:F.sourceRef,model:null,notProductionTrace:true},state:engine.getState()};
      const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='crm-local-fixture-trace.json';a.click();URL.revokeObjectURL(url);
    }
    if(engine.getState().status==='completed'&&action!=='replay'&&action!=='replay-next'&&action!=='replay-end'&&action!=='export')tab='eval';
    draw();
  }
  document.addEventListener('click',e=>{
    const opener=e.target.closest('[data-open-lab]');if(opener){open(opener);return;}
    if(!opened)return;
    const target=e.target.closest('[data-lab],[data-lab-tab],[data-lab-trace],[data-lab-source]');if(!target)return;
    if(target.dataset.lab)return act(target.dataset.lab);
    if(target.dataset.labTab){tab=target.dataset.labTab;draw();document.getElementById('lab-tab-'+tab)?.focus();return;}
    if(target.dataset.labTrace)return showEvidence(target.dataset.labTrace,'trace');
    if(target.dataset.labSource)return showEvidence(target.dataset.labSource,'source');
  });
  document.addEventListener('keydown',e=>{
    if(!opened)return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();return;}
    if(e.target.matches('[role="tab"][data-lab-tab]')&&['ArrowRight','ArrowLeft','Home','End'].includes(e.key)){
      e.preventDefault();const tabs=[...document.querySelectorAll('[role="tab"][data-lab-tab]')];let index=tabs.indexOf(e.target);index=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tab=tabs[index].dataset.labTab;draw();document.getElementById('lab-tab-'+tab)?.focus();return;
    }
    if(e.key==='Tab'){
      const focusables=[...document.querySelectorAll('#runtime-lab button:not([disabled]),#runtime-lab a[href],#runtime-lab textarea,#runtime-lab select,#runtime-lab summary,#runtime-lab [tabindex="0"]')].filter(x=>x.getAttribute('tabindex')!=='-1');
      const first=focusables[0],last=focusables.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
    }
  },true);
  const previousRender=render;
  render=function(){previousRender();const bar=document.querySelector('.topbar .row');if(bar){const b=document.createElement('button');b.className='btn lab-launch';b.type='button';b.dataset.openLab='';b.textContent='◈ 能力实验室';bar.appendChild(b);}const welcome=document.querySelector('.agent-welcome');if(welcome){const b=document.createElement('button');b.className='btn lab-launch';b.type='button';b.dataset.openLab='';b.textContent='打开零密钥能力实验室 →';welcome.appendChild(b);}if(opened)document.getElementById('app').setAttribute('inert','');};
  window.CRM_DEMO_LAB={engine,open,close};
  render();
})();
