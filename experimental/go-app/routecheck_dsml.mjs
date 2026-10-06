import assert from 'node:assert/strict';
import {createMomoSwitch} from '../../src/server.mjs';

const frame=(delta,finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
const stream=values=>values.map(v=>'data: '+JSON.stringify(v)+String.fromCharCode(10,10)).join('')+'data: [DONE]'+String.fromCharCode(10,10);
export async function dsmlBlackbox(launch,invoke){
 let count=0;
 const tools=[{type:'namespace',name:'pad',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{}}},{type:'custom',name:'write'}]}];
 for(const prefix of ['<','<||DSML||','<｜｜DSML｜｜'])for(const streaming of [true,false]){
  const close=prefix.replace('<','</');
  const markup=prefix+'tool_calls>'+prefix+'invoke name="pad__read">'+prefix+'parameter name="path" string="true">a & b < c'+close+'parameter>'+close+'invoke>'+prefix+'invoke name="pad__write">'+prefix+'parameter name="input">text("中文🙂")'+close+'parameter>'+close+'invoke>'+close+'tool_calls>';
  const sse=stream([...markup].map(c=>frame({content:c})).concat(frame({},'stop')));
  const {child,handoff}=await launch({stream:sse});let server;
  try{
   const env={MOMO_PROXY_HOME:'unused-dsml-routecheck',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
   server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},
    {env,loggingRuntime,assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,'mock.example');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));
   const payload={model:'gpt-5.5',stream:streaming,input:[{role:'user',content:'DSML synthetic'}],tools};
   const n=await invoke('http://127.0.0.1:'+server.address().port,'synthetic-node-only',payload);
   const g=await invoke(handoff.base_url.slice(0,-3),handoff.api_key,payload,'/v1/responses',{'X-MOMO-Tool-Text':'dsml-v1'});
   assert.equal(n.status,200);assert.equal(g.status,200);assert.ok(n.completed&&g.completed);
   const captured=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captured.length,2,'one send each/no retries');
   assert.deepEqual(captured[1].stream_options,{include_usage:true});delete captured[1].stream_options;assert.deepEqual(captured[1],captured[0]);
   const nc=n.output.filter(v=>['function_call','custom_tool_call'].includes(v.type)),gc=g.output.filter(v=>['function_call','custom_tool_call'].includes(v.type));
   assert.equal(nc.length,2);assert.equal(gc.length,2);assert.equal(g.output.length,2,'no partial markup text leaked');
   for(let i=0;i<2;i++){assert.equal(gc[i].namespace,'pad');assert.equal(nc[i].namespace,undefined);assert.equal(gc[i].name,nc[i].name);assert.equal(gc[i].type,nc[i].type)}
   assert.deepEqual(JSON.parse(gc[0].arguments),{path:'a & b < c'});assert.deepEqual(JSON.parse(gc[0].arguments),JSON.parse(nc[0].arguments));assert.equal(gc[1].input,'text("中文🙂")');assert.equal(gc[1].input,nc[1].input);
   // Legacy Node leaks marker prefixes under split chunks and may append a
   // duplicate cleaned prefix. Assert the limitation, do not normalize it away.
   const nodeText=n.output.filter(v=>v.type==='message').map(v=>v.content?.[0]?.text||'').join('');
   const leaked={'<':'<tool_calls','<||DSML||':'<||DSML|','<｜｜DSML｜｜':'<｜｜DSML｜'}[prefix]+(prefix==='<'?'':close+'invoke>'+close+'invoke>'+close+'tool_calls>');
   assert.equal(nodeText,leaked,'legacy Node split-marker leak changed');
   assert.equal(g.json,streaming?undefined:true);
   console.log('PASS shared DSML '+prefix+' '+(streaming?'SSE':'JSON')+'; Go explicit policy preserves namespace/raw values and holds split markers; Node automatic synthesis leaks prefixes; no tool execution/live model proof');count++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
 }
 return count;
}
