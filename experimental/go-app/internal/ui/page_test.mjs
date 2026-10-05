// Run the shipped page script in a dependency-free, simulated DOM/fetch harness.
// Native WebView separately tests DOM button handlers; this is not visual proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const script = source.split('<script>')[1].split('</script>')[0];
const nodes = new Map();
let focused;
for (const [,id] of source.matchAll(/\bid="([^"]+)"/g)) {
  assert.equal(nodes.has(id),false,`Duplicate HTML id: ${id}`);
  const attributes=new Map();
  nodes.set(id, {disabled:false,textContent:'',value:'',checked:false,hidden:false,dataset:{},
    setAttribute:(name,value)=>attributes.set(name,value),getAttribute:name=>attributes.get(name),
    focus:()=>{focused=id}});
}
const initial = {Configured:false,Running:false,Active:0,Endpoint:'',Version:'0.4.0-preview',LocalEndpoint:'http://127.0.0.1:12345'};
let state = {...initial}, calls=[], handler;
const response = (status, value=state) => ({ok:status===200,status,json:async()=>({...value})});
const pending = () => {let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const timers=[], intervals=[], listeners=new Map();
const context = vm.createContext({
  document:{hidden:false,getElementById:id=>nodes.get(id)},
  window:{addEventListener:(name,fn)=>listeners.set(name,fn)},
  bridgeNonce:'synthetic-page-capability',AbortController,confirm:()=>true,
  setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout:()=>{},
  setInterval:fn=>{intervals.push(fn)},
  fetch:async(url,options)=>{calls.push({url,options});return handler?handler(url,options):response(200)}
});
vm.runInContext(script,context);
const run = code => vm.runInContext(code,context);
const flush = async()=>{for(let i=0;i<6;i++)await Promise.resolve()};
await flush();
assert.equal(nodes.get('start').disabled,true);
assert.equal(nodes.get('configure').disabled,false);
assert.equal(nodes.get('quit').disabled,false);
assert.equal(nodes.get('quota-refresh').disabled,true);
assert.equal(calls.filter(c=>c.url==='/app/quota').length,0);
assert.equal(calls.filter(c=>c.url==='/app/models').length,0);
assert.equal(nodes.get('models-refresh').disabled,true);
assert.equal(nodes.get('service-state').textContent,'已停止');
assert.equal(nodes.get('active-count').textContent,'0');
assert.equal(nodes.get('local-url').textContent,initial.LocalEndpoint+'/v1');
assert.equal(nodes.get('build-version').textContent,initial.Version);
assert.equal(nodes.get('routing-state').textContent,'默认原协议透传');
assert.equal(nodes.get('compact-state').textContent,'默认关闭 · 501');
assert.match(source,/尚未对齐/);
assert.ok(source.includes('3 个上游接口 + 1 个本地 checkpoint'));
assert.match(source,/Muse 转换不在计划内/);
assert.match(source,/momo_tool_loading:client-search/);
assert.match(source,/不是原生延迟加载/);
assert.match(source,/strict 仅做有界本地校验/);
assert.match(source,/X-MOMO-Compact:native/);
assert.match(source,/能力未验证，不回退/);
assert.ok(source.includes('Chat / Claude / Gemini 子集 · 实验'));
assert.ok(source.includes('支持 SSE / 最终 JSON'));
assert.ok(source.includes('namespace 恢复、指定工具与 token usage'));
assert.ok(source.includes('false 或省略 stream 等有效终端才返回最终 JSON'));
assert.ok(source.includes('max_output_tokens 支持整数 1–1048576'));
assert.ok(source.includes('incomplete（不是 completed），不保存为可续接历史'));
assert.ok(source.includes('畸形半截工具参数仍拒绝'));
assert.ok(source.includes('/v1/responses/compact'));
assert.ok(source.includes('显式原生上游 / 本地 checkpoint'));
assert.ok(source.includes('返回 output 需客户端手动重放；cmp_ 不是续聊 anchor'));
assert.ok(source.includes('实验本地 checkpoint 保留完整工具/图片回合及解读、不含加密 envelope'));
assert.ok(source.includes('不自动触发或转换供应商状态'));
assert.equal((source.match(/class="protocol-card"/g)||[]).length,5);
assert.ok(source.includes('allowed_tools'));
assert.ok(source.includes('exec/apply_patch 支持纯文本 custom 输入'));
assert.ok(source.includes('unsupported_tool_format，不猜 shell 或改写 JS'));
assert.ok(source.includes('转换只发送本轮可调用声明，不承诺原生缓存优化'));
assert.ok(source.includes('<details id="routing-details" class="contract-details">'));
assert.ok(source.includes('详细模型规则与不支持的能力'));
assert.ok(source.includes('min-width:530px'));
assert.ok(source.includes('不代表真实上游非流式已验证'));
assert.ok(!source.includes('压缩、非流式'));
assert.ok(source.includes('不含 thinking/签名'));
assert.ok(source.includes('不含 thinking/签名/输出媒体'));
assert.ok(source.includes('保留文字/图片顺序及同模型历史'));
assert.ok(source.includes('不验证 DNS/重定向'));
assert.ok(source.includes('Gemini URL 必须显式 mime_type'));
assert.ok(source.includes('momo_tool_images:user-projection'));
assert.ok(source.includes('momo_tool_files:user-projection'));
assert.ok(source.includes('PDF input_file'));
assert.ok(source.includes('EOF framing'));
assert.ok(source.includes('不是原生角色/信任等价或注入防护'));
assert.ok(!source.includes('Gemini 尚未迁移'));
assert.doesNotMatch(source,/Gemini \/ Claude \/ Muse 尚未迁移/);
assert.equal((source.match(/>未迁移</g)||[]).length,2);
assert.ok(source.includes('部分支持 · 有界内存'));
assert.ok(source.includes('Stop 或重新配置即清空；store:false 不保存新响应'));
assert.doesNotMatch(source,/<(?:script|link|img)[^>]*(?:src|href)=/i);

// Real navigation handlers and accessible keyboard tabs, not fake feature controls.
nodes.get('nav-routing').onclick();
assert.equal(nodes.get('view-routing').hidden,false);
assert.equal(nodes.get('view-overview').hidden,true);
assert.equal(nodes.get('page-title').textContent,'路由能力');
assert.equal(nodes.get('nav-routing').getAttribute('aria-selected'),'true');
assert.equal(nodes.get('nav-routing').tabIndex,0);
let prevented=false;
nodes.get('nav-routing').onkeydown({key:'ArrowRight',preventDefault:()=>{prevented=true}});
assert.equal(prevented,true);
assert.equal(focused,'nav-integrations');
assert.equal(nodes.get('view-integrations').hidden,false);
nodes.get('nav-integrations').onkeydown({key:'ArrowRight',preventDefault:()=>{}});
assert.equal(nodes.get('view-settings').hidden,false);
nodes.get('nav-settings').onkeydown({key:'Home',preventDefault:()=>{}});
assert.equal(focused,'nav-overview');
assert.equal(nodes.get('view-overview').hidden,false);
nodes.get('nav-overview').onkeydown({key:'ArrowLeft',preventDefault:()=>{}});
assert.equal(focused,'nav-settings');
nodes.get('nav-settings').onkeydown({key:'End',preventDefault:()=>{}});
assert.equal(focused,'nav-settings');

// Explicit Load returns to the connection form, without exposing its key.
state={...initial,Configured:true,Endpoint:'https://mock.example'};
await nodes.get('load').onclick();
assert.equal(nodes.get('view-overview').hidden,false);
assert.equal(nodes.get('endpoint').value,state.Endpoint);
assert.equal(nodes.get('key').value,'');
handler=url=>url==='/app/models'?response(200,{IDs:['<img src=x>','claude-test','gpt-test'],CheckedAt:1800000000}):response(200);
await nodes.get('models-refresh').onclick();
assert.equal(nodes.get('models-state').textContent,'列表权限已验证');
assert.equal(nodes.get('models-list').textContent,'<img src=x>\nclaude-test\ngpt-test');
assert.match(nodes.get('models-note').textContent,/不证明模型推理可用/);
assert.equal(calls.find(c=>c.url==='/app/models').options.body,undefined);
nodes.get('models-filter').value='GPT';nodes.get('models-filter').oninput();
assert.equal(nodes.get('models-list').textContent,'gpt-test');
nodes.get('models-filter').value='none';nodes.get('models-filter').oninput();
assert.equal(nodes.get('models-list').textContent,'没有匹配的模型');
handler=()=>response(200,{IDs:[],CheckedAt:1800000000});await nodes.get('models-refresh').onclick();
assert.equal(nodes.get('models-state').textContent,'已验证 · 空列表');
assert.equal(nodes.get('models-list').textContent,'上游返回空模型列表');
for(const status of [401,404,409,502]){handler=()=>response(status);await nodes.get('models-refresh').onclick();assert.equal(nodes.get('models-state').textContent,'尚未验证');assert.equal(nodes.get('models-filter').disabled,true)}
handler=()=>response(200,{IDs:null,CheckedAt:1800000000});await nodes.get('models-refresh').onclick();assert.equal(nodes.get('models-state').textContent,'尚未验证');
const blockedModels=pending();handler=url=>url==='/app/models'?blockedModels.promise:response(200);
const checking=nodes.get('models-refresh').onclick();await flush();
assert.equal(nodes.get('configure').disabled,true);assert.equal(nodes.get('quit').disabled,false);
assert.equal(await nodes.get('models-refresh').onclick(),false);
const modelOptions=calls.at(-1).options;timers.at(-1)();assert.equal(modelOptions.signal.aborted,true);
await run("action('stop')");blockedModels.resolve(response(503));await checking;
assert.equal(nodes.get('models-state').textContent,'尚未验证');
const quota={Available:12345,Used:55,Granted:12400,Unlimited:false,ExpiresAt:0,CheckedAt:1800000000};
handler=url=>url==='/app/quota'?response(200,quota):response(200);
await nodes.get('quota-refresh').onclick();
assert.match(nodes.get('quota-available').textContent,/12,345/);
assert.match(nodes.get('quota-note').textContent,/非账户钱包/);
assert.equal(run('lastState.Configured'),true);
assert.equal(calls.find(c=>c.url==='/app/quota').options.body,undefined);
handler=()=>response(404);await nodes.get('quota-refresh').onclick();
assert.equal(nodes.get('quota-available').textContent,'尚未查询');
assert.match(nodes.get('quota-note').textContent,/未提供/);
handler=()=>response(200,{...quota,Unlimited:true});await nodes.get('quota-refresh').onclick();
assert.match(nodes.get('quota-available').textContent,/未设额度上限/);
const blockedQuota=pending();handler=url=>url==='/app/quota'?blockedQuota.promise:response(200);
const querying=nodes.get('quota-refresh').onclick();await flush();
assert.equal(nodes.get('configure').disabled,true);
assert.equal(nodes.get('quit').disabled,false);
assert.equal(await nodes.get('quota-refresh').onclick(),false);
await run("action('stop')");blockedQuota.resolve(response(503));await querying;
assert.match(nodes.get('quota-note').textContent,/未知额度/);
handler=()=>response(200,state);
await nodes.get('skill-copy').onclick();assert.match(nodes.get('notice').textContent,/SKILL.md/);
await nodes.get('mcp-copy').onclick();assert.match(nodes.get('notice').textContent,/MCP 配置/);
state={...initial};
await run("action('state')");

// Profile saving waits: no duplicate mutations, polling/Stop/Quit still work.
const saved=pending();
handler=(url)=>url==='/app/configure'?saved.promise:response(200);
nodes.get('endpoint').value=' https://mock.example ';
nodes.get('key').value='synthetic-page-input-only';
nodes.get('remember').checked=true;
nodes.get('routing-mode').checked=true;
const applying=nodes.get('configure').onclick();
await flush();
assert.equal(nodes.get('key').value,'');
assert.equal(JSON.parse(calls.find(c=>c.url==='/app/configure').options.body).Mode,'momo-routing');
assert.equal(nodes.get('load').disabled,true);
assert.equal(nodes.get('quit').disabled,false);
assert.equal(await run("action('start')"),false);
assert.equal(await run("action('state')"),true);
assert.equal(await run("action('stop')"),true);
assert.equal(await run("action('quit')"),true);
assert.equal(calls.filter(c=>c.url==='/app/start').length,0);
state={...initial,Configured:true,Endpoint:'https://mock.example'};
saved.resolve(response(503));
await applying;
assert.equal(nodes.get('models-state').textContent,'尚未验证');
assert.equal(run('mutationPending'),false);
assert.match(nodes.get('notice').textContent,/安全保存失败/);
await run("action('state')");
assert.match(nodes.get('notice').textContent,/安全保存失败/);
assert.equal(nodes.get('start').disabled,false);

// Background responses cannot overwrite a more recent Stop response.
const old=pending();
handler=(url)=>url==='/app/state'?old.promise:response(200,state);
const polling=run("action('state')");
await flush();
await run("action('stop')");
old.resolve(response(200,{...state,Running:true}));
await polling;
assert.equal(run('lastState.Running'),false);

// Native/tray changes are picked up by visible polling and focus; errors persist.
// A poll launched DURING Start must not outrank Start's successful response.
// Its server snapshot can have been taken before Start changes native state.
for(const pollFirst of [true,false]){
 const starting=pending(),during=pending();
 handler=url=>url==='/app/start'?starting.promise:url==='/app/state'?during.promise:response(200,state);
 const mutation=run("action('start')");await flush();
 const concurrent=run("action('state')");await flush();
 if(pollFirst){during.resolve(response(200,{...state,Running:false}));await concurrent;starting.resolve(response(200,{...state,Running:true}));await mutation;}
 else{starting.resolve(response(200,{...state,Running:true}));await mutation;during.resolve(response(200,{...state,Running:false}));await concurrent;}
 assert.equal(run('lastState.Running'),true,'concurrent pre-Start poll replaced successful Start');
 assert.equal(nodes.get('service-state').textContent,'运行中');
 assert.equal(nodes.get('start').disabled,true);
 handler=()=>response(200,state);await run("action('stop')");
}
// Stop must also outrank an in-flight Start and a poll launched during Start.
{
 const starting=pending(),during=pending();
 handler=url=>url==='/app/start'?starting.promise:url==='/app/state'?during.promise:response(200,state);
 const mutation=run("action('start')");await flush();const concurrent=run("action('state')");await flush();
 await run("action('stop')");starting.resolve(response(200,{...state,Running:true}));await mutation;
 during.resolve(response(200,{...state,Running:true}));await concurrent;
 assert.equal(run('lastState.Running'),false);assert.equal(nodes.get('service-state').textContent,'已停止');
}
nodes.get('notice').textContent='安全保存失败';
handler=()=>response(200,{...state,Running:true});
intervals[0]();await flush();
assert.equal(nodes.get('configure').disabled,true);
assert.equal(nodes.get('routing-mode').disabled,true);
assert.equal(nodes.get('stop').disabled,false);
assert.equal(nodes.get('service-state').textContent,'运行中');
assert.equal(nodes.get('status-badge').dataset.tone,'good');
handler=()=>response(200,state);
listeners.get('focus')();await flush();
assert.equal(nodes.get('configure').disabled,false);
assert.match(nodes.get('notice').textContent,/安全保存失败/);
assert.equal(nodes.get('status-label').textContent,'已停止');
context.document.hidden=true;
const before=calls.length;intervals[0]();await flush();
assert.equal(calls.length,before);

// Polls are single-flight and have an abort deadline; body key is explicit only.
const wait=pending();handler=()=>wait.promise;
const one=run("action('state')");await flush();
assert.equal(await run("action('state')"),false);
const options=calls.at(-1).options;
timers.at(-1)();assert.equal(options.signal.aborted,true);
wait.resolve(response(200));await one;
assert.equal(run('statePending'),false);
assert.equal(calls.filter(c=>c.options.body?.includes('synthetic-page-input-only')).length,1);
console.log('PASS shipped page: navigation/keyboard/status/capability gaps/Load/pending controls/Stop/Quit/key clear/persistent warnings/stale-response ordering/polling/focus/timeout');
