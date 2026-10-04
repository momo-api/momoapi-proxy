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
assert.equal(nodes.get('service-state').textContent,'已停止');
assert.equal(nodes.get('active-count').textContent,'0');
assert.equal(nodes.get('local-url').textContent,initial.LocalEndpoint+'/v1');
assert.equal(nodes.get('build-version').textContent,initial.Version);
assert.match(source,/尚未对齐/);
assert.match(source,/暂无自动转换/);
assert.equal((source.match(/>未迁移</g)||[]).length,5);
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
assert.equal(focused,'nav-settings');
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
state={...initial};
await run("action('state')");

// Profile saving waits: no duplicate mutations, polling/Stop/Quit still work.
const saved=pending();
handler=(url)=>url==='/app/configure'?saved.promise:response(200);
nodes.get('endpoint').value=' https://mock.example ';
nodes.get('key').value='synthetic-page-input-only';
nodes.get('remember').checked=true;
const applying=nodes.get('configure').onclick();
await flush();
assert.equal(nodes.get('key').value,'');
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
nodes.get('notice').textContent='安全保存失败';
handler=()=>response(200,{...state,Running:true});
intervals[0]();await flush();
assert.equal(nodes.get('configure').disabled,true);
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
