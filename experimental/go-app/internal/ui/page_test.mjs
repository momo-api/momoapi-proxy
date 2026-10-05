// Run the shipped page script in a dependency-free, simulated DOM/fetch harness.
// Native WebView separately tests DOM button handlers; this is not visual proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const script = source.split('<script>')[1].split('</script>')[0];
const nodes = new Map();
let focused;
const element=()=>({disabled:false,textContent:'',value:'',checked:false,hidden:false,dataset:{},children:[],append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items;this.value=items[0]?.value||''},removeAttribute(name){delete this[name]}});
for (const [,id] of source.matchAll(/\bid="([^"]+)"/g)) {
  assert.equal(nodes.has(id),false,`Duplicate HTML id: ${id}`);
  const attributes=new Map();
  nodes.set(id, {...element(),
    setAttribute:(name,value)=>attributes.set(name,value),getAttribute:name=>attributes.get(name),
    focus:()=>{focused=id}});
}
const initial = {Configured:false,Running:false,Active:0,Endpoint:'',Version:'0.4.0-preview',LocalEndpoint:'http://127.0.0.1:12345'};
let state = {...initial}, calls=[], handler;
let allowConfirm=true;
const response = (status, value=state) => ({ok:status===200,status,json:async()=>({...value})});
const pending = () => {let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const timers=[], intervals=[], listeners=new Map();
const context = vm.createContext({
  document:{hidden:false,getElementById:id=>nodes.get(id),createElement:()=>element()},
  Option:function(text,value){Object.assign(this,element(),{textContent:text,value})},
  window:{addEventListener:(name,fn)=>listeners.set(name,fn)},
  bridgeNonce:'synthetic-page-capability',AbortController,confirm:()=>allowConfirm,
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
assert.equal(calls.filter(c=>c.url==='/app/codex-catalog').length,0);
assert.equal(calls.filter(c=>c.url.startsWith('/app/images/')).length,0);
assert.equal(nodes.get('image-catalog').disabled,true);
assert.equal(nodes.get('image-mcp-copy').disabled,true);
assert.equal(nodes.get('video-mcp-copy').disabled,true);
assert.equal(calls.filter(c=>c.url==='/app/image-mcp-config').length,0);
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
assert.equal((source.match(/>未迁移</g)||[]).length,0);
assert.ok(source.includes('部分支持 · 手动导出'));
assert.ok(source.includes('部分支持 · 内存快照'));
assert.ok(source.includes('X-MOMO-Attachments:inline'));
assert.ok(source.includes('删除附件不撤回已存历史'));
assert.ok(source.includes('目录优先的图片生成'));
assert.ok(source.includes('可能计费'));
assert.ok(source.includes('图片工作台支持明确生成'));
assert.ok(source.includes('独立显式图片 MCP（可复制配置连接当前本地网关，客户端显式设置本地 Key）'));
assert.ok(source.includes('无编辑或磁盘保存'));
assert.ok(source.includes('两种 APIMart API 子集（视频工作台 + API + 独立 MCP 子集）'));
assert.ok(!source.includes('图片视频生成仍未迁移'));
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
assert.equal(nodes.get('view-images').hidden,false);
assert.equal(focused,'nav-images');
nodes.get('nav-images').onkeydown({key:'ArrowRight',preventDefault:()=>{}});
assert.equal(nodes.get('view-videos').hidden,false);
assert.equal(focused,'nav-videos');
nodes.get('nav-videos').onkeydown({key:'ArrowRight',preventDefault:()=>{}});
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
assert.equal(nodes.get('codex-catalog-copy').disabled,true);
const beforeCatalog=calls.filter(c=>c.url==='/app/codex-catalog').length;
assert.equal(await nodes.get('codex-catalog-copy').onclick(),false);
assert.equal(calls.filter(c=>c.url==='/app/codex-catalog').length,beforeCatalog);
assert.equal(nodes.get('quit').disabled,false);
assert.equal(await nodes.get('quota-refresh').onclick(),false);
await run("action('stop')");blockedQuota.resolve(response(503));await querying;
assert.match(nodes.get('quota-note').textContent,/未知额度/);
handler=()=>response(200,state);
await nodes.get('skill-copy').onclick();assert.match(nodes.get('notice').textContent,/SKILL.md/);
await nodes.get('mcp-copy').onclick();assert.match(nodes.get('notice').textContent,/MCP 配置/);
await nodes.get('codex-copy').onclick();assert.match(nodes.get('notice').textContent,/Codex Provider/);
assert.equal(calls.filter(c=>c.url==='/app/codex-config').length,1);
assert.equal(calls.find(c=>c.url==='/app/codex-config').options.body,undefined);
await nodes.get('codex-catalog-copy').onclick();assert.match(nodes.get('notice').textContent,/客户端目录 JSON/);
assert.equal(calls.filter(c=>c.url==='/app/codex-catalog').length,1);
assert.equal(calls.find(c=>c.url==='/app/codex-catalog').options.body,undefined);
assert.equal(calls.find(c=>c.url==='/app/codex-catalog').options.headers['X-MOMO-Bridge'],'synthetic-page-capability');
assert.ok(source.includes('保存为新文件'));
assert.ok(source.includes('model_catalog_json'));
assert.ok(source.includes('aria-label="手动接入步骤"'));
assert.equal((source.match(/<li><strong>/g)||[]).length,3);
handler=()=>response(503);await nodes.get('codex-catalog-copy').onclick();assert.ok(!nodes.get('notice').textContent.includes('已复制'));
handler=()=>response(200,state);
assert.ok(source.includes('MOMO_LOCAL_API_KEY'));
assert.ok(source.includes('不能直接覆盖原文件'));
state={...initial};
await run("action('state')");

// Profile saving waits: no duplicate mutations, polling/Stop/Quit still work.
// Real shipped image handlers: explicit catalog/selection/confirmation, bounded
// pending operations, manual task, no URL load or stale post-Stop rendering.
state={...initial,Configured:true,Running:true,Endpoint:'https://mock.example'};
handler=()=>response(200);await run("action('state')");
assert.equal(nodes.get('image-mcp-copy').disabled,false);
await nodes.get('image-mcp-copy').onclick();assert.match(nodes.get('notice').textContent,/图片 MCP/);
assert.equal(nodes.get('video-mcp-copy').disabled,false);
await nodes.get('video-mcp-copy').onclick();assert.equal(calls.at(-1).url,'/app/video-mcp-config');assert.equal(calls.at(-1).options.headers['X-MOMO-Bridge'],'synthetic-page-capability');assert.match(nodes.get('notice').textContent,/视频 MCP/);
assert.equal(calls.filter(c=>c.url==='/app/image-mcp-config').length,1);
assert.equal(calls.find(c=>c.url==='/app/image-mcp-config').options.body,undefined);
assert.equal(calls.find(c=>c.url==='/app/image-mcp-config').options.headers['X-MOMO-Bridge'],'synthetic-page-capability');
const catalog={models:[{id:'image-test',available:true,parameters:['prompt','n','quality'],allowed_n:[1,2]}],expires_at:new Date(Date.now()+300000).toISOString()};
handler=url=>url==='/app/images/catalog'?response(200,catalog):response(200);
await nodes.get('image-catalog').onclick();
assert.equal(nodes.get('image-model').value,'');assert.equal(nodes.get('image-generate').disabled,true);
nodes.get('image-model').value='image-test';nodes.get('image-model').onchange();nodes.get('image-prompt').value='中文🙂';nodes.get('image-consent').checked=true;nodes.get('image-options').value='{}';nodes.get('image-consent').oninput();
assert.equal(nodes.get('image-n').value,'1');assert.equal(nodes.get('image-generate').disabled,false);
allowConfirm=false;assert.equal(await nodes.get('image-generate').onclick(),false);assert.equal(calls.filter(c=>c.url==='/app/images/generate').length,0);allowConfirm=true;
nodes.get('image-options').value='{"model":"hidden-substitution"}';assert.equal(await nodes.get('image-generate').onclick(),false);assert.equal(calls.filter(c=>c.url==='/app/images/generate').length,0);nodes.get('image-options').value='{"quality":"high"}';
handler=url=>url==='/app/images/generate'?response(200,{images:[],task_id:'task_gui',raw_status:'submitted',terminal:false}):response(200);
assert.equal(await nodes.get('image-generate').onclick(),true);assert.equal(nodes.get('image-consent').checked,false);assert.equal(nodes.get('image-generate').disabled,true);assert.equal(nodes.get('image-task').disabled,false);
const imageRequest=JSON.parse(calls.find(c=>c.url==='/app/images/generate').options.body);assert.equal(imageRequest.confirmed,true);assert.deepEqual(imageRequest.request,{quality:'high',model:'image-test',prompt:'中文🙂',n:1});assert.equal(calls.find(c=>c.url==='/app/images/generate').options.headers['X-MOMO-Bridge'],'synthetic-page-capability');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
handler=url=>url==='/app/images/task'?response(200,{images:[{url:'https://images.example/a',b64_json:png,mime_type:'image/png'}],task_id:'task_gui',raw_status:'completed',terminal:true}):response(200);
await nodes.get('image-task').onclick();assert.equal(nodes.get('image-task').disabled,true);assert.equal(nodes.get('image-preview').src,undefined);
const card=nodes.get('image-results').children[0];assert.equal(card.children[1].textContent,'https://images.example/a');assert.equal(card.children[1].href,undefined);card.children[2].onclick();assert.equal(nodes.get('image-preview').src,'data:image/png;base64,'+png);
assert.equal(calls.filter(c=>c.url==='/app/images/task').length,1);
nodes.get('image-consent').checked=true;nodes.get('image-consent').oninput();const blockedImage=pending();handler=url=>url==='/app/images/generate'?blockedImage.promise:response(200);const generating=nodes.get('image-generate').onclick();await flush();assert.equal(nodes.get('configure').disabled,true);assert.equal(nodes.get('stop').disabled,false);assert.equal(nodes.get('quit').disabled,false);assert.equal(await nodes.get('image-generate').onclick(),false);
const genOptions=calls.at(-1).options;timers.at(-1)();assert.equal(genOptions.signal.aborted,true);
state={...state,Running:false};await nodes.get('stop').onclick();blockedImage.resolve(response(200,{images:[{url:'https://images.example/stale'}],terminal:true}));await generating;assert.equal(nodes.get('image-results').children.length,0);assert.equal(nodes.get('image-preview').src,undefined);assert.equal(run('imageCatalog'),null);
state={...state,Running:true};handler=url=>url==='/app/images/catalog'?response(200,{...catalog,expires_at:new Date(Date.now()-1000).toISOString()}):response(200);await run("action('state')");await nodes.get('image-catalog').onclick();assert.equal(nodes.get('image-generate').disabled,true);assert.equal(nodes.get('image-model').disabled,true);
for(const status of [401,404,409,502]){handler=()=>response(status);await nodes.get('image-catalog').onclick();assert.equal(run('imageCatalog'),null);assert.equal(nodes.get('image-model').disabled,true);assert.equal(nodes.get('image-generate').disabled,true)}
handler=()=>response(200,{models:[{id:'bad',available:true,allowed_n:[1]}],expires_at:catalog.expires_at});await nodes.get('image-catalog').onclick();assert.equal(run('imageCatalog'),null);
// Shipped video DOM actions: explicit controls and consent, no playback/download,
// exact native bridge only, Stop fences a late response while staying available.
const videoCatalog={models:[{id:'seedance-2.5',available:true,durations:[4,5,6],resolutions:['480p','720p','1080p'],aspect_ratios:['16:9','adaptive'],max_reference_images:30}],expires_at:new Date(Date.now()+300000).toISOString()};
state={...state,Configured:true,Running:true};handler=()=>response(200);await run("action('state')");
nodes.get('nav-videos').onclick();assert.equal(nodes.get('view-videos').hidden,false);assert.equal(nodes.get('page-title').textContent,'视频工作台');
handler=url=>url==='/app/videos/catalog'?response(200,videoCatalog):response(200);
await nodes.get('video-catalog').onclick();assert.equal(nodes.get('video-model').value,'');assert.equal(nodes.get('video-generate').disabled,true);
nodes.get('video-model').value='seedance-2.5';nodes.get('video-model').onchange();
assert.equal(nodes.get('video-duration').value,'');assert.equal(nodes.get('video-resolution').value,'');assert.equal(nodes.get('video-ratio').value,'');
nodes.get('video-duration').value='5';nodes.get('video-resolution').value='720p';nodes.get('video-ratio').value='adaptive';nodes.get('video-prompt').value=' 中文🙂 ';nodes.get('video-options').value='{}';nodes.get('video-consent').checked=true;nodes.get('video-consent').oninput();
assert.equal(nodes.get('video-generate').disabled,false);allowConfirm=false;let videoBefore=calls.length;await nodes.get('video-generate').onclick();assert.equal(calls.length,videoBefore);allowConfirm=true;
nodes.get('video-options').value='{"model":"overwrite"}';await nodes.get('video-generate').onclick();assert.equal(calls.length,videoBefore);
nodes.get('video-options').value='{"reference_images":["https://images.example/a"],"first_frame_image":"https://images.example/b"}';await nodes.get('video-generate').onclick();assert.equal(calls.length,videoBefore);
nodes.get('video-options').value='{}';
handler=url=>url==='/app/videos/generate'?response(200,{task_id:'task_video',status:'queued',terminal:false}):response(200);
await nodes.get('video-generate').onclick();let videoSend=calls.at(-1);
assert.equal(videoSend.url,'/app/videos/generate');assert.equal(videoSend.options.headers['X-MOMO-Bridge'],'synthetic-page-capability');
assert.equal(videoSend.options.headers.authorization,undefined);
assert.deepEqual(JSON.parse(videoSend.options.body),{confirmed:true,request:{model:'seedance-2.5',prompt:' 中文🙂 ',duration:5,resolution:'720p',aspect_ratio:'adaptive'}});
assert.equal(nodes.get('video-consent').checked,false);assert.equal(nodes.get('video-task').disabled,false);
handler=url=>url==='/app/videos/task'?response(200,{task_id:'task_video',status:'completed',terminal:true,remote_url:'https://video.example/result.mp4',progress:100}):response(200);
await nodes.get('video-task').onclick();assert.deepEqual(JSON.parse(calls.at(-1).options.body),{task_id:'task_video'});
assert.equal(nodes.get('video-result-state').textContent,'视频已完成');assert.equal(nodes.get('video-task').disabled,true);
assert.equal(nodes.get('video-results').children[0].textContent,'https://video.example/result.mp4');
assert.equal(nodes.get('video-results').children[0].src,undefined);assert.equal(nodes.get('video-results').children[0].href,undefined);
assert.doesNotMatch(source,/<video\b|<iframe\b/i);
nodes.get('video-consent').checked=true;nodes.get('video-consent').oninput();const blockedVideo=pending();handler=url=>url==='/app/videos/generate'?blockedVideo.promise:response(200);
const videoGenerating=nodes.get('video-generate').onclick();await flush();assert.equal(nodes.get('stop').disabled,false);assert.equal(nodes.get('quit').disabled,false);assert.equal(nodes.get('image-catalog').disabled,true);assert.equal(await nodes.get('video-generate').onclick(),false);
const videoOptions=calls.at(-1).options;timers.at(-1)();assert.equal(videoOptions.signal.aborted,true);
state={...state,Running:false};await nodes.get('stop').onclick();blockedVideo.resolve(response(200,{task_id:'task_late',status:'completed',terminal:true,remote_url:'https://video.example/late.mp4'}));await videoGenerating;
assert.equal(run('videoCatalog'),null);assert.equal(run('videoTaskID'),'');assert.equal(nodes.get('video-results').children.length,0);
state={...state,Running:true};handler=()=>response(200,state);await run("action('state')");
handler=()=>response(200,{...videoCatalog,expires_at:new Date(Date.now()-1000).toISOString()});await nodes.get('video-catalog').onclick();assert.equal(nodes.get('video-model').disabled,true);assert.equal(nodes.get('video-generate').disabled,true);
for(const status of [401,404,409,502]){handler=()=>response(status);await nodes.get('video-catalog').onclick();assert.equal(run('videoCatalog'),null)}
handler=()=>response(200,{models:[{id:'bad',available:true}],expires_at:videoCatalog.expires_at});await nodes.get('video-catalog').onclick();assert.equal(run('videoCatalog'),null);
for(const models of [[videoCatalog.models[0],videoCatalog.models[0]],[{...videoCatalog.models[0],max_reference_images:999}],[{...videoCatalog.models[0],durations:[4,4]}],[{...videoCatalog.models[0],durations:[31]}],[{...videoCatalog.models[0],resolutions:['480P']}],[null]]){
 handler=()=>response(200,{...videoCatalog,models});await nodes.get('video-catalog').onclick();assert.equal(run('videoCatalog'),null);assert.equal(nodes.get('video-generate').disabled,true);
}
state={...initial};handler=()=>response(200);await run("action('state')");

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

// A stalled native Start/clipboard bridge must not leave all actions locked.
{
 const stalled=pending();handler=()=>stalled.promise;
 const starting=run("action('start')");await flush();
 const options=calls.at(-1).options;
 assert.ok(options.signal,'short native action lacks abort deadline');
 timers.at(-1)();assert.equal(options.signal.aborted,true);
 stalled.resolve(response(503));await starting;
 assert.equal(run('mutationPending'),false);assert.equal(nodes.get('quit').disabled,false);
}
// Polls are single-flight and have an abort deadline; body key is explicit only.
const wait=pending();handler=()=>wait.promise;
const one=run("action('state')");await flush();
assert.equal(await run("action('state')"),false);
const options=calls.at(-1).options;
timers.at(-1)();assert.equal(options.signal.aborted,true);
wait.resolve(response(200));await one;
assert.equal(run('statePending'),false);
assert.equal(calls.filter(c=>c.options.body?.includes('synthetic-page-input-only')).length,1);
console.log('PASS shipped page: navigation/keyboard/status/capability gaps/Load/pending controls/Stop/Quit/key clear/persistent warnings/stale-response ordering/polling/focus/timeout + image catalog/selection/confirmation/manual task/data-only opt-in preview/Stop epoch + video explicit controls/confirmation/manual task/URL text/shared busy/Stop epoch');
