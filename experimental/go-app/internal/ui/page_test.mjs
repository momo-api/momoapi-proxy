// Run the shipped page script in a dependency-free, simulated DOM/fetch harness.
// Native WebView separately tests DOM button handlers; this is not visual proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./page.go', import.meta.url), 'utf8');
const script = source.split('<script>')[1].split('</script>')[0];
const nodes = new Map();
for (const id of ['state','notice','endpoint','key','remember','configure','start','stop','refresh','copy','quit','load','forget']) {
  nodes.set(id, {disabled:false,textContent:'',value:'',checked:false});
}
const initial = {Configured:false,Running:false,Active:0,Endpoint:''};
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
handler=()=>response(200,state);
listeners.get('focus')();await flush();
assert.equal(nodes.get('configure').disabled,false);
assert.match(nodes.get('notice').textContent,/安全保存失败/);
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
console.log('PASS shipped page: pending controls/Stop/Quit/key clear/persistent warnings/stale-response ordering/polling/focus/timeout');
