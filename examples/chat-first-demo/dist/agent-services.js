/* Source-aligned, in-memory UI scenarios. No vendor/API calls or credential storage. */
(function () {
  'use strict';
  const ref = '12749abaa8aa98f7bee988f69fb4aa23e9d5ff29';
  const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const source = (path, label) => `<a href="https://github.com/luckiest-draw/AiNativeCrm/blob/${ref}/${path}" target="_blank" rel="noopener noreferrer">${h(label)}</a>`;
  const providers = [
    {id:'mem0',name:'Mem0',purpose:'负责人确认的客户偏好、事实与沟通背景',fields:'organization_id · base_url · api_key'},
    {id:'weknora',name:'WeKnora',purpose:'组织授权的公司与产品 Wiki',fields:'organization_id · base_url · api_key · knowledge_base_ids · visibility=organization'},
    {id:'langfuse',name:'Langfuse',purpose:'真实 Pi 模型 / 工具测量与 CRM Eval 投影',fields:'organization_id · base_url · public_key · secret_key'}
  ];
  const tabs = [['setup','配置状态'],['memory','客户记忆'],['wiki','产品 Wiki'],['trace','Trace / Eval'],['real','真实录制 · 10/03']];
  const initial = () => ({tab:'setup',contact:'c1',memory:{},wiki:{loaded:false,name:'产品资料（合成）',kb:'',confirmed:false,registered:false,published:false,status:'current',open:false},trace:{kind:'model',status:'running',saved:false},notice:''});
  let ui = initial();
  let realRun = 1;
  const button = (id,label,disabled=false,extra='') => `<button class="btn small" type="button" data-service="${id}" ${disabled?'disabled':''} ${extra}>${h(label)}</button>`;
  const kv = (label,value) => `<div class="inspection-kv"><span>${h(label)}</span><strong>${h(value)}</strong></div>`;
  const boundary = '<p class="services-boundary">本站为静态交互预览；交互案例仅在本页内存演练，刷新即重置。“真实录制”展示已保存的脱敏历史，不发起模型请求。网页未连接 CRM 后端或外部服务；请勿输入真实客户信息或密钥。</p>';
  const serviceLink = (tab,label) => `<button class="btn small" type="button" data-open-services="${tab}">${h(label)}</button>`;
  function providerCards() {
    return `<div class="services-grid">${providers.map(p=>`<article class="service-card" data-provider="${p.id}"><div class="row between wrap"><h3>${p.name}</h3><span class="badge" data-provider-off>OFF · 未启用</span></div><p>${p.purpose}</p><div class="service-status">NOT CONNECTED · 未连接</div>${kv('服务端配置','未配置')}${kv('连通性','未验证')}${kv('目的地','未设置')}${kv('设置 revision','0')}<div class="row wrap">${button('enable-'+p.id,'启用',true)}${p.id!=='weknora'?button('retry-'+p.id,'重试失败投递',true):''}</div><details><summary>正式部署所需字段</summary><p class="service-code">${p.fields}</p><label class="field">服务凭据（本站不可填写）<input disabled autocomplete="off" aria-label="${p.name} 服务凭据" placeholder="请在真实 CRM 部署的密钥管理中配置"></label></details></article>`).join('')}</div>`;
  }
  function setup() {
    return `<h3>Agent 服务接入</h3><p>接入代码已加入 CRM。三项服务分别配置、默认关闭；配置齐全也不代表连通性已验证。</p>${providerCards()}<div class="inspection-notice"><strong>在真实部署中完成连接</strong><ol><li>准备 Next.js CRM、Supabase / PostgreSQL、迁移 0405–0407 和独立 ai-integration-drain。</li><li>由部署管理员在服务端设置 AI_INTEGRATION_BINDINGS，缺省值为 []。密钥不能放入 NEXT_PUBLIC_* 或浏览器。</li><li>核对每个组织的服务目的地、访问范围与保留 / 删除流程，再由组织管理员显式启用。</li><li>以合成客户事实和公开产品资料验证真实连接；发布 Site 不会启动这些服务。</li></ol></div>${kv('Trace 真实投递','没有连接，无法读取队列')}${kv('已删除客户的清理','没有连接，无法读取清理凭据')}<p>Mem0 原请求的结果不明时，必须先在服务端确认已结束，再核对结果，不能盲目重复 ADD。Langfuse 投递回执也不等于数据已在仪表盘可见。</p><div class="service-links">${source('components/ai/AgentIntegrationsPanel.tsx','真实接入界面')} · ${source('app/api/v1/ai/integrations/route.ts','配置与权限接口')} · ${source('docs/integrations/agent-services.md','部署与安全说明')}</div>`;
  }
  function memoryState(id) { return ui.memory[id] ||= {body:'客户希望先收到书面说明，再预约沟通。',category:'preference',rows:[],seq:0}; }
  function memory(id=ui.contact) {
    const m=memoryState(id), person=state.contacts.find(x=>x.id===id);
    return `<section class="service-memory" data-service-contact="${h(id)}"><h3>客户记忆 · ${h(person?.name||'合成客户')}</h3><p>只保存负责人确认的客户偏好、事实和沟通背景。产品政策、价格批准和承诺仍归知识库与 CRM 审批。</p><span class="badge">Mem0 OFF · NOT CONNECTED</span><form id="service-memory-form" data-contact-id="${h(id)}"><label class="field">记忆类型<select id="service-memory-category"><option value="preference" ${m.category==='preference'?'selected':''}>客户偏好</option><option value="confirmed_fact" ${m.category==='confirmed_fact'?'selected':''}>已确认事实</option><option value="communication_context" ${m.category==='communication_context'?'selected':''}>沟通背景</option></select></label><label class="field">已确认的记忆内容（只用虚构信息）<textarea id="service-memory-body" maxlength="2000" rows="3">${h(m.body)}</textarea></label><button class="btn primary" type="submit" ${!m.body.trim()?'disabled':''}>确认并保存（本地演练）</button></form><p class="inspection-metadata">真实接口要求 manager、confirmed: true 和固定 request_key。同内容安全重试复用原请求；模型不会自动提取所有聊天。</p>${m.rows.length?m.rows.map(row=>`<article class="inspection-card" data-memory-row="${h(row.id)}"><strong>${row.deleted?'已停止使用此记忆':h(row.body)}</strong><p class="service-code">${h(row.sync)} · ${h(row.outcome)} · 合成状态</p>${row.deleted?'<p>外部清理待验证（模拟）；不代表备份已擦除</p>':'<p>已由演示操作者确认 · 实际外部写入次数：0</p>'}<div class="row wrap">${!row.deleted?button('delete-memory','删除此记忆（本地演练）',false,`data-row="${row.id}"`):''}${row.sync==='pending'?button('sync-memory','演练收到同步回执',false,`data-row="${row.id}"`)+button('unknown-memory','演练写入结果不明',false,`data-row="${row.id}"`):''}</div>${['unknown','in_flight'].includes(row.outcome)?`<label class="service-check"><input type="checkbox" data-memory-settled="${row.id}" ${row.settled?'checked':''}>案例中已在 Mem0 确认原请求结束，且已过安全等待窗口</label>${button('reconcile-memory','核对结果，不重复写入（演练）',!row.settled,`data-row="${row.id}"`)}<p class="inspection-metadata">真实操作需先在服务端核实，并受一分钟安全窗口约束。这里只演练找到唯一回执的情况。</p>`:''}</article>`).join(''):'<div class="service-empty">本页尚无已确认的记忆</div>'}<div class="service-links">${source('components/ai/CustomerMemoryPanel.tsx','真实联系人面板')} · ${source('lib/ai/integrations/mem0.ts','同步 / 对账 / 删除实现')}</div></section>`;
  }
  function wiki() {
    const w=ui.wiki;
    return `<h3>WeKnora · 产品 Wiki</h3><span class="badge">OFF · NOT CONNECTED</span><p>真实配置仅列出服务端授权的知识库。必须确认整个知识库都对本组织可见，加入来源后还须选择 Agent 知识范围并发布版本。</p>${!w.loaded?`<div class="service-empty">当前没有已配置的知识库，不能绑定来源</div>${button('load-wiki','载入独立的合成授权案例')}`:`<div class="inspection-notice">以下是独立流程案例；demo-products 是虚构 allow-list，未建立实际授权或外部连接。</div><form id="service-wiki-form"><label class="field">Wiki 来源名称<input id="service-wiki-name" maxlength="120" value="${h(w.name)}"></label><label class="field">已获授权的公司产品知识库<select id="service-wiki-kb"><option value="">请选择</option><option value="demo-products" ${w.kb==='demo-products'?'selected':''}>demo-products（合成，组织可见）</option></select></label><label class="service-check"><input id="service-wiki-confirmed" type="checkbox" ${w.confirmed?'checked':''}>案例中整个知识库均可供本组织使用，不含混合权限材料</label><button class="btn" type="submit" ${w.registered||w.name.trim().length<2||!w.kb||!w.confirmed?'disabled':''}>加入 Agent 知识来源（演练）</button></form>${w.registered?`<article class="inspection-card"><h4>${h(w.name)}</h4><p>已加入本页合成来源。下一步：在 Agent 的知识范围选择并发布版本。</p>${button('publish-wiki','演练选择来源并发布 Agent',w.published)}${w.published?`<label class="field">案例来源状态<select id="service-wiki-status"><option value="current" ${w.status==='current'?'selected':''}>当前且已授权</option><option value="stale" ${w.status==='stale'?'selected':''}>来源更新，派生页已过期</option><option value="revoked" ${w.status==='revoked'?'selected':''}>来源权限已撤回</option></select></label>${w.status==='current'?`<div data-wiki-evidence><h4>产品实施范围 · 合成 Wiki 页面</h4><p>标准实施包包含需求梳理与交付文档。报价和交期需按现有审批确认。</p>${kv('页面版本','demo-page-v3')}${kv('来源 / chunk','demo-public-product / demo-chunk-2')}${button('read-wiki','查看来源清单（合成）')}${w.open?'<pre class="service-code" data-wiki-manifest>page: demo-page-v3\nknowledge_base: demo-products\nsource: demo-public-product\nsource_status: active / parsed\nchunk_reference: demo-chunk-2\nmanifest: observed-page / synthetic</pre>':''}</div>`:'<p class="inspection-notice" role="status">不展示此证据：当前来源不可核验。已隐藏历史摘录、来源链接与清单。</p>'}`:''}</article>`:''}`}
    <p class="inspection-metadata">真实读取校验 KB、文档状态与更新时间；保存的是观察到的 Wiki 页面和来源版本清单，不是全部原始文档快照。知识库内容不能批准报价或商业承诺。</p><div class="service-links">${source('lib/ai/integrations/weknora.ts','真实 Wiki 读取与来源核验')} · ${source('app/api/v1/ai/integrations/wiki/sources/route.ts','整库授权绑定')}</div>`;
  }
  function trace() {
    const t=ui.trace, map={model:['Pi streamFn 的实际 generation observation','crm.model','model / provider · timing · usage · status'],tool:['实际执行的工具函数','crm.tool','工具名称 · timing · status'],run:['SQL Run 生命周期与专家父子关系','crm.run / crm.specialist / crm.call','脱敏组织 / Run / attempt 关联'],eval:['已保存的 CRM Eval 报告','crm.* score-create','七个维度 / overall · fingerprint · profile / rubric revision']}[t.kind];
    return `<h3>Langfuse · 真实事件映射</h3><span class="badge">OFF · NOT CONNECTED</span><p>这里展示代码映射，不生成模型调用或伪造真实 trace。原有实验室 Trace 和历史模型报告继续单独保留。</p><label class="field">查看接线<select id="service-trace-kind">${[['model','模型边界'],['tool','工具边界'],['run','Run 与调用'],['eval','Eval 分数']].map(([id,name])=>`<option value="${id}" ${t.kind===id?'selected':''}>${name}</option>`).join('')}</select></label><article class="inspection-card">${kv('真实输入',map[0])}${kv('投影名称',map[1])}<p>${map[2]}</p>${kv('测量值 / token','本站未测量，不显示合成数值')}${kv('远端投递','未发生')}<p class="inspection-metadata">不包含 prompt、输出、客户消息、工具参数 / 结果、隐藏推理、密钥或个人身份。投递由隔离 outbox 处理，重试保留原 observation ID 与时间。</p></article><h3>确定性 Eval 保存入口</h3><label class="field">独立合成 Run 状态<select id="service-trace-status"><option value="running" ${t.status==='running'?'selected':''}>运行中，不允许保存</option><option value="completed" ${t.status==='completed'?'selected':''}>已结束，可演练保存</option></select></label>${button('save-eval','保存并投递确定性 Eval（演练）',t.status!=='completed'||t.saved)}${t.saved?'<p class="inspection-notice" role="status" data-eval-saved>本页已标记保存。真实 SQL 保存 / 队列投递：未执行。Langfuse 未启用，不声称远端可见；没有调用额外模型。</p>':''}<p class="inspection-metadata">真实 Workbench 只允许 completed / partial / failed / cancelled 状态保存。GET Eval 仍然只读；语义 Judge 需要单独显式触发。</p><div class="service-links">${source('lib/ai/integrations/langfuse.ts','OTLP 与 score 投影实现')} · ${source('app/app/ai/workbench/_components/AgentCrmWorkbench.tsx','真实 Eval 操作')} · ${source('docs/testing/agent-services-2026-10-02.md','已完成与未验证阶段')}</div>`;
  }
  function servicesPanel() {
    return `<button class="agent-panel-scrim" data-action="close-agent-panel" aria-label="关闭服务接入"></button><aside class="agent-sidepanel inspection-panel services-panel" role="dialog" aria-modal="true" aria-labelledby="services-title"><div class="agent-panel-head"><div><span class="inspection-eyebrow">代码基线 ${ref.slice(0,7)}</span><h2 id="services-title">Agent 服务 · 接入预览</h2></div><button class="btn ghost" data-action="close-agent-panel" aria-label="关闭服务接入">×</button></div>${boundary}<div class="inspection-tabs" role="tablist" aria-label="Agent 服务接入">${tabs.map(([id,label])=>`<button type="button" role="tab" id="service-tab-${id}" data-service-tab="${id}" aria-selected="${ui.tab===id}" aria-controls="service-content" tabindex="${ui.tab===id?0:-1}">${label}</button>`).join('')}</div><div class="agent-panel-body" id="service-content" role="tabpanel" aria-labelledby="service-tab-${ui.tab}" tabindex="0">${({setup,memory,wiki,trace,real:realRecording})[ui.tab]()}</div></aside>`;
  }
  function realRecording() {
    const recordings = window.CRM_REAL_RECORDINGS || [];
    const r = recordings[realRun] || recordings[0];
    if (!r) return '<p role="status">真实录制尚未载入；不生成替代 trace。</p>';
    const memoryRead = r.tools.find(t => t.name === 'crm_get_contact')?.observation.confirmedCustomerMemory;
    return `<section data-real-recording><h3>真实模型 · CRM 合成数据</h3><p class="inspection-notice">本机真实 Pi / OpenCode 运行的脱敏录制，不是当前网页实时调用。回放不执行工具、不消费模型额度。未接入 Mem0、WeKnora、Langfuse；不代表第三方服务验证成功。</p><label class="field">对比录制<select id="service-real-run">${recordings.map((item,index)=>`<option value="${index}" ${index===realRun?'selected':''}>${index===0?'修复前：记忆遗漏':'修复后：本地确认记忆可见'}</option>`).join('')}</select></label>${kv('原始 Run',r.runId)}${kv('运行终态',r.status+'（不是完整业务验收）')}${kv('真实模型调用',r.modelCalls.length+' 次 · opencode / space-bunny-free')}${kv('独立 SQL 记忆存在性',r.independentConfirmedMemoryCount+' 条')}${kv('工具读到的确认记忆',(memoryRead?.confirmedCount??0)+' 条 · '+(memoryRead?.coverage??'unknown'))}<p>本地事实归 CRM 保存；Mem0 OFF 不应阻止读取。partial / unavailable / not_returned 均不能当成不存在。</p>${memoryRead?.facts?.map(f=>`<blockquote>${h(f.body)}</blockquote>`).join('')||''}<details><summary>真实任务输入</summary><pre class="service-code">${h(r.task)}</pre></details><h4>Tool Calling · 脱敏输入 / 观察</h4>${r.tools.map((t,index)=>`<details data-real-tool><summary>${index+1}. ${h(t.name)} · ${h(t.observation.status)}</summary><pre class="service-code">${h(JSON.stringify({input:t.input,observation:t.observation},null,2))}</pre></details>`).join('')}<h4>真实 Eval</h4>${r.evaluations.map(e=>`<article class="inspection-card">${kv('整体门禁',e.verdict+' · '+e.score)}${kv('profile',e.profileKey+' revision '+e.profileRevision)}${kv('语义 Judge',e.semanticJudge.status+(e.semanticJudge.score==null?'':' · '+e.semanticJudge.verdict+' / '+e.semanticJudge.score))}<p>${e.dimensions.flatMap(d=>d.findings).map(h).join(' · ')||'无额外发现'} </p><p>语义分数不能覆盖确定性失败；读取覆盖不等于所有自然语言事实已验证。</p></article>`).join('')||'<p>这份录制没有保存评测，不补造分数。</p>'}<details><summary>模型计量（真实 SQL 记录）</summary><pre class="service-code">${h(JSON.stringify(r.modelCalls,null,2))}</pre></details><details><summary>持久化事件 · ${r.events.length} 步</summary><ol>${r.events.map(e=>`<li>${e.sequence} · ${h(e.type)} ${h(e.tool||'')} · ${h(e.at)}</li>`).join('')}</ol></details><details><summary>真实最终输出（已脱敏）</summary><pre class="service-code">${h(r.finalAnswer)}</pre></details>${button('export-real','下载这次真实录制（JSON）')}<p>不含密钥、隐藏推理、原始系统 Prompt、电话、邮箱和完整工具正文；保留合成事实及实际输入输出摘要。</p></section>`;
  }
  function open(tab='setup') {ui.tab=tabs.some(x=>x[0]===tab)?tab:'setup';if(state.drawer)state.drawer=null;if(state.page!=='/app/ai/workbench')navigate('/app/ai/workbench');openAgentPanel('services');}
  const priorPanel=agentSidePanel;agentSidePanel=function(){return state.agentPanel==='services'?servicesPanel():priorPanel();};
  const priorProviders=providersView;providersView=function(){return `<section class="services-inline panel panel-pad"><div class="row between wrap"><h2>Agent 服务接入</h2>${serviceLink('setup','配置说明与流程演练')}</div>${boundary}${providerCards()}</section>`+priorProviders();};
  const priorRender=render;render=function(){
    priorRender();
    const header=document.querySelector('.agent-header-actions');if(header)header.insertAdjacentHTML('beforeend',serviceLink('setup','服务接入')+serviceLink('real','真实模型录制'));
    const welcome=document.querySelector('.agent-welcome');if(welcome){const node=document.createElement('div');node.className='inspection-welcome services-welcome';node.innerHTML='<strong>Mem0 · WeKnora · Langfuse</strong><p>接入代码已加入，服务默认关闭。查看配置状态与可操作的合成流程。</p>'+serviceLink('setup','查看服务接入');welcome.prepend(node);}
    if(state.drawer?.kind==='contact'){const body=document.querySelector('.drawer-body');if(body){const node=document.createElement('section');node.className='services-inline';node.innerHTML=boundary+memory(state.drawer.id);body.prepend(node);}}
  };
  const currentMemory=()=>{const id=document.querySelector('[data-service-contact]')?.dataset.serviceContact;return id?memoryState(id):null;};
  document.addEventListener('click',e=>{
    const launch=e.target.closest('[data-open-services]');if(launch){open(launch.dataset.openServices);return;}
    const tab=e.target.closest('[data-service-tab]');if(tab){ui.tab=tab.dataset.serviceTab;render();document.getElementById('service-tab-'+ui.tab)?.focus();return;}
    if(e.target.closest('[data-action="reset"]')){ui=initial();render();return;}
    const action=e.target.closest('[data-service]');if(!action||action.disabled)return;
    const id=action.dataset.service,m=currentMemory(),row=m?.rows.find(x=>x.id===action.dataset.row);
    if(id==='export-real'){const r=(window.CRM_REAL_RECORDINGS||[])[realRun];if(!r)return;const blob=new Blob([JSON.stringify(r,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='real-agent-'+r.runId+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),0);return;}
    if(id==='sync-memory'&&row?.sync==='pending'){row.sync='synced';row.outcome='confirmed';}
    if(id==='unknown-memory'&&row?.sync==='pending'){row.sync='reconcile';row.outcome='unknown';}
    if(id==='delete-memory'&&row){row.body='';row.deleted=true;row.sync='deleted';}
    if(id==='reconcile-memory'&&row?.settled&&['unknown','in_flight'].includes(row.outcome)){row.outcome='confirmed';row.sync=row.deleted?'deleted':'synced';row.settled=false;}
    if(id==='load-wiki')ui.wiki.loaded=true;
    if(id==='publish-wiki'&&ui.wiki.registered)ui.wiki.published=true;
    if(id==='read-wiki'&&ui.wiki.status==='current')ui.wiki.open=!ui.wiki.open;
    if(id==='save-eval'&&ui.trace.status==='completed')ui.trace.saved=true;
    render();
  });
  document.addEventListener('submit',e=>{
    if(e.target.id==='service-memory-form'){e.preventDefault();const m=memoryState(e.target.dataset.contactId);if(!m.body.trim())return;m.rows.push({id:'demo-memory-'+(++m.seq),body:m.body.trim(),category:m.category,sync:'pending',outcome:'never_started',deleted:false,settled:false});m.body='';render();}
    if(e.target.id==='service-wiki-form'){e.preventDefault();const w=ui.wiki;if(w.loaded&&w.name.trim().length>=2&&w.kb==='demo-products'&&w.confirmed)w.registered=true;render();}
  });
  document.addEventListener('input',e=>{if(e.target.id==='service-memory-body'){const m=currentMemory();if(m){m.body=e.target.value;document.querySelector('#service-memory-form button').disabled=!m.body.trim();}}if(e.target.id==='service-wiki-name'){ui.wiki.name=e.target.value;const w=ui.wiki;document.querySelector('#service-wiki-form button').disabled=w.registered||w.name.trim().length<2||!w.kb||!w.confirmed;}});
  document.addEventListener('change',e=>{
    const id=e.target.id;
    if(id==='service-real-run'){realRun=Number(e.target.value);render();document.getElementById(id)?.focus();return;}
    if(id==='service-memory-category'){const m=currentMemory();if(m)m.category=e.target.value;return;}
    if(e.target.dataset.memorySettled){const row=currentMemory()?.rows.find(x=>x.id===e.target.dataset.memorySettled);if(row)row.settled=e.target.checked;render();return;}
    if(id==='service-wiki-kb'){ui.wiki.kb=e.target.value;ui.wiki.registered=false;ui.wiki.published=false;}
    if(id==='service-wiki-confirmed')ui.wiki.confirmed=e.target.checked;
    if(id==='service-wiki-status'){ui.wiki.status=e.target.value;ui.wiki.open=false;}
    if(id==='service-trace-kind')ui.trace.kind=e.target.value;
    if(id==='service-trace-status')ui.trace.status=e.target.value;
    if(id.startsWith('service-')){render();document.getElementById(id)?.focus();}
  });
  document.addEventListener('keydown',e=>{if(!e.target.matches?.('[data-service-tab]')||!['ArrowRight','ArrowLeft','Home','End'].includes(e.key))return;e.preventDefault();let i=tabs.findIndex(x=>x[0]===ui.tab);i=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;ui.tab=tabs[i][0];render();document.getElementById('service-tab-'+ui.tab)?.focus();});
  window.CRM_SERVICES={open,sourceRef:ref};
  render();
})();
