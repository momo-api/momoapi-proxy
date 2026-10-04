// Uniform semantic blackbox: real TCP requests to Node and Go, same mock
// upstream per case, same workload/concurrency and matched configurable budgets.
// Test-only binary; no profiles, credentials, production or benchmark claims.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {createMomoSwitch} from '../../src/server.mjs';
const binary=process.argv[2];assert.ok(binary);
const tool={type:'namespace',name:'pad',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{}}},{type:'custom',name:'write'}]};
const payload={model:'gpt-5.5',stream:true,instructions:'Be concise.',input:[{role:'user',content:[{type:'input_text',text:'中文🙂'}]}],tools:[tool]};
const chunk=(delta,finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
const sse=chunks=>chunks.map(c=>'data: '+JSON.stringify(c)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n';
const text=sse([chunk({content:'中文'}),chunk({content:'🙂'},'stop')]);
const calls=sse([
 chunk({tool_calls:[{index:0,id:'call_read',type:'function',function:{name:'pad__read',arguments:'{"x":'}}]}),
 chunk({tool_calls:[{index:0,function:{arguments:'1}'}},{index:1,id:'call_write',type:'function',function:{name:'pad__write',arguments:'{"input":"text(\'hi\')"}'}}]}),
 chunk({},'tool_calls')]);
const bare=sse([chunk({tool_calls:[{index:0,id:'call_read',type:'function',function:{name:'read',arguments:'{}'}}]},'tool_calls')]);
const cf=(type,fields={})=>'event: '+type+'\r\ndata: '+JSON.stringify({type,...fields})+'\r\n\r\n';
const cs=cf('message_start',{message:{id:'msg_mock',type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:1}}});
const ce=reason=>cf('message_delta',{delta:{stop_reason:reason,stop_sequence:null},usage:{output_tokens:5}})+cf('message_stop');
const ct=(index,text)=>cf('content_block_start',{index,content_block:{type:'text',text:''}})+cf('content_block_delta',{index,delta:{type:'text_delta',text}})+cf('content_block_stop',{index});
const ctool=(index,id,name,partial_json)=>cf('content_block_start',{index,content_block:{type:'tool_use',id,name,input:{}}})+cf('content_block_delta',{index,delta:{type:'input_json_delta',partial_json}})+cf('content_block_stop',{index});
const claudeText=cs+ct(0,'中文🙂')+ce('end_turn');
const claudeCalls=cs+ctool(0,'call_read','pad__read','{"x":1}')+ctool(1,'call_write','pad__write',JSON.stringify({input:"text('hi')"}))+ce('tool_use');
const cp={...payload,model:'claude-sonnet-4-6'};
const gp={...payload,model:'gemini-2.5-flash'};
const gpath='/v1beta/models/gemini-2.5-flash:streamGenerateContent';
const gu={promptTokenCount:3,candidatesTokenCount:5,totalTokenCount:10,cachedContentTokenCount:2,thoughtsTokenCount:2};
const gf=(parts,finishReason,usageMetadata)=>'data: '+JSON.stringify({...((parts||finishReason)?{candidates:[{index:0,...(parts?{content:{role:'model',parts}}:{}),...(finishReason?{finishReason}:{})}]}:{}),...(usageMetadata?{usageMetadata}:{})})+'\r\n\r\n';
const gt=gf([{text:'中文🙂'}])+gf(null,'STOP',gu);
const gc=gf([{functionCall:{id:'call_read',name:'pad__read',args:{x:1}}},{functionCall:{id:'call_write',name:'pad__write',args:{input:"text('hi')"}}}])+gf(null,'STOP',gu);
const cases=[
 {name:'text Unicode fragmented',stream:text,payload},
 {name:'function custom namespace fragmented',stream:calls,payload},
 {name:'history function/output',stream:text,payload:{...payload,tools:tool.tools,input:[...payload.input,{type:'function_call',call_id:'history_read',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'history_read',output:'done'},{role:'user',content:'continue'}]}},
 {name:'history assistant plus parallel calls',stream:text,payload:{...payload,tools:tool.tools,input:[...payload.input,{role:'assistant',content:'checking'},{type:'function_call',call_id:'a',name:'read',arguments:'{}'},{type:'custom_tool_call',call_id:'b',name:'write',input:"text('hello')"},{type:'custom_tool_call_output',call_id:'b',output:'written'},{type:'function_call_output',call_id:'a',output:'read'},{role:'user',content:'continue'}]}},
 {name:'Qwen system consolidation',stream:text,payload:{...payload,model:'qwen-test',input:[...payload.input,{role:'developer',content:'later instruction'}]}},
 {name:'four concurrent same-resource requests',stream:text,payload,concurrent:4},
 {name:'namespace absent from upstream delta',stream:bare,payload},
 ...[401,429,500].map(status=>({name:'upstream '+status,stream:'',status,payload})),
 {name:'truncated EOF safety difference',stream:'data: '+JSON.stringify(chunk({content:'partial'}))+'\n\n',payload,truncate:true},
 {name:'Claude Unicode fragmented',stream:claudeText,payload:cp,path:'/v1/messages'},
 {name:'Claude function/custom namespace',stream:claudeCalls,payload:cp,path:'/v1/messages'},
 {name:'Claude paired parallel history',stream:claudeText,payload:{...cp,input:[...cp.input,{role:'assistant',content:'checking'},{type:'function_call',call_id:'a',namespace:'pad',name:'read',arguments:'{}'},{type:'custom_tool_call',call_id:'b',namespace:'pad',name:'write',input:'hello'},{type:'function_call_output',call_id:'a',output:'read'},{type:'custom_tool_call_output',call_id:'b',output:'written'},{role:'user',content:'continue'}]},path:'/v1/messages',historyDifference:true},
 {name:'Claude four concurrent same-resource',stream:claudeText,payload:cp,path:'/v1/messages',concurrent:4},
 ...[401,429,500].map(status=>({name:'Claude upstream '+status,stream:'',status,payload:cp,path:'/v1/messages'})),
 {name:'Claude truncated EOF safety difference',stream:cs+ct(0,'partial'),payload:cp,path:'/v1/messages',truncate:true},
 {name:'Claude system/tool choice preservation',stream:claudeText,payload:{...cp,tool_choice:'required',input:[{role:'developer',content:'rules'},...cp.input]},path:'/v1/messages',systemDifference:true},
 {name:'Gemini Unicode fragmented',stream:gt,payload:gp,path:gpath},
 {name:'Gemini function/custom namespace',stream:gc,payload:gp,path:gpath},
 {name:'Gemini paired function history',stream:gt,payload:{...gp,input:[...gp.input,{role:'assistant',content:'checking'},{type:'function_call',call_id:'a',namespace:'pad',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'a',output:'read'},{role:'user',content:'continue'}]},path:gpath,geminiHistory:true},
 {name:'Gemini four concurrent same-resource',stream:gt,payload:gp,path:gpath,concurrent:4},
 ...[401,429,500].map(status=>({name:'Gemini upstream '+status,stream:'',status,payload:gp,path:gpath})),
 {name:'Gemini premature EOF safety difference',stream:gf([{text:'partial'}]),payload:gp,path:gpath,truncate:true},
 {name:'Gemini system/tool choice',stream:gt,payload:{...gp,tool_choice:'required',input:[{role:'developer',content:'rules'},...gp.input]},path:gpath},
 {name:'Gemini usage-only trailer',stream:gf([{text:'中文🙂'}],'STOP')+gf(null,null,gu),payload:gp,path:gpath},
];
async function launch(fixture){
 const child=spawn(binary,[],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let stderr='';child.stderr.on('data',b=>{stderr+=b});
 const handoff=await new Promise((resolve,reject)=>{
  let line='';const timer=setTimeout(()=>reject(Error('routecheck startup timeout')),10000);
  child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('routecheck exited before handoff'))});
  child.stdout.on('data',b=>{line+=b;if(line.includes('\n')){clearTimeout(timer);resolve(JSON.parse(line.split('\n')[0]))}});
  child.stdin.end(JSON.stringify({Stream:fixture.stream,Status:fixture.status||200,Path:fixture.path}));
 });
 return {child,handoff};
}
function items(body){
 const events=body.split(/\r?\n\r?\n/).flatMap(block=>{const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!data||data==='[DONE]')return [];try{return [JSON.parse(data)]}catch{return []}});
 const completed=events.find(e=>e.type==='response.completed');
 return {events,completed,output:completed?.response?.output?.map(({id,status,...item})=>item)||[]};
}
async function invoke(url,token,p){
 return new Promise((resolve,reject)=>{
  const data=JSON.stringify(p);
  const req=httpRequest(url+'/v1/responses',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','content-length':Buffer.byteLength(data)}},response=>{
   const chunks=[];let settled=false;
   const finish=truncated=>{if(settled)return;settled=true;const body=Buffer.concat(chunks).toString('utf8');resolve({status:response.statusCode,body,truncated,...items(body)})};
   response.on('data',b=>chunks.push(b));response.once('end',()=>finish(false));response.once('error',()=>finish(true));response.once('aborted',()=>finish(true));
  });req.setTimeout(10000,()=>req.destroy(Error('request timeout')));req.once('error',reject);req.end(data);
 });
}
for(const fixture of cases){
 const {child,handoff}=await launch(fixture);
 let server;
 try{
  const env={MOMO_PROXY_HOME:'unused-routecheck-profile',MOMO_PROXY_CONSOLE_MIRROR:'0'};
  const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
  server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,
   requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},
   {env,loggingRuntime,assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);return fetch(handoff.mock_url+u.pathname+u.search,init)}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const nodeURL='http://127.0.0.1:'+server.address().port;
  const goURL=handoff.base_url.replace(/\/v1$/,'');
  const count=fixture.concurrent||1;
  const nodeResults=await Promise.all(Array.from({length:count},()=>invoke(nodeURL,'synthetic-node-only',fixture.payload)));
  const goResults=await Promise.all(Array.from({length:count},()=>invoke(goURL,handoff.api_key,fixture.payload)));
  const captures=await(await fetch(handoff.mock_url+'/capture')).json();
  assert.equal(captures.length,count*2,fixture.name+' no duplicate fallback');
  for(let i=0;i<count;i++){
   const n=structuredClone(captures[i]),g=structuredClone(captures[count+i]);
   if(fixture.path==='/v1/messages'){
    assert.equal(g.tool_choice.type,fixture.systemDifference?'any':'auto');assert.equal(n.tool_choice,undefined);delete g.tool_choice;
    if(fixture.systemDifference){assert.equal(g.system,'Be concise.\n\nrules');assert.equal(n.system,'Be concise.');assert.equal(g.messages.length,1);assert.deepEqual(n.messages,[{role:'user',content:[{type:'text',text:'rules'},{type:'text',text:'中文🙂'}]}]);g.system=n.system;g.messages[0].content.unshift({type:'text',text:'rules'});console.log('DIFFERENCE Go keeps system instructions and tool choice; Node Claude maps developer to user and omits choice')}
    if(fixture.historyDifference){
     assert.equal(g.messages.length,3);assert.equal(n.messages.length,3);
     const gc=g.messages[1].content,nc=n.messages[1].content;
     assert.equal(gc[1].name,'pad__read');assert.equal(nc[1].name,'read');gc[1].name=nc[1].name;
     assert.equal(gc[2].name,'pad__write');assert.equal(nc[2].name,'write');gc[2].name=nc[2].name;
     assert.deepEqual(gc[2].input,{input:'hello'});assert.deepEqual(nc[2].input,{raw:'hello'});gc[2].input={raw:gc[2].input.input};
     console.log('DIFFERENCE Go Claude history uses declared namespace aliases and input schema; Node uses bare names/raw');
    }
   }
   if(fixture.path===gpath){
    assert.deepEqual(g.toolConfig,{functionCallingConfig:{mode:fixture.payload.tool_choice==='required'?'ANY':'AUTO'}});assert.equal(n.toolConfig,undefined);delete g.toolConfig;
    if(fixture.geminiHistory){
     assert.equal(g.contents.length,3);assert.equal(n.contents.length,3);
     const gcall=g.contents[1].parts[1].functionCall,ncall=n.contents[1].parts[1].functionCall;
     assert.equal(gcall.name,'pad__read');assert.equal(ncall.name,'read');gcall.name=ncall.name;
     const gres=g.contents[2].parts[0].functionResponse,nres=n.contents[2].parts[0].functionResponse;
     assert.equal(gres.name,'pad__read');assert.equal(nres.name,'read');gres.name=nres.name;
     console.log('DIFFERENCE Go Gemini history preserves declared tool alias; Node uses bare name');
    }
   }
   assert.deepEqual(g,n,fixture.name+' upstream request mismatch');
  }
  for(let i=0;i<count;i++){
   const n=nodeResults[i],g=goResults[i];assert.equal(g.status,n.status,fixture.name+' HTTP status');
   if(fixture.status){assert.equal(g.completed,undefined);assert.equal(n.completed,undefined)}
   else if(fixture.truncate){assert.equal(g.completed,undefined);assert.equal(g.truncated,true);assert.ok(n.completed);console.log('DIFFERENCE Node completes clean premature EOF; Go aborts without fabricated completion')}
   else {
    assert.ok(n.completed&&g.completed,fixture.name+' missing completion');
    // Legacy Node drops explicit namespaces on Chat calls; Go restores them.
    const normalized=g.output.map(({namespace,...item})=>item);
    assert.deepEqual(normalized,n.output,fixture.name+' Responses semantic output mismatch');
    if(fixture.stream===calls||fixture.stream===bare||fixture.stream===claudeCalls||fixture.stream===gc){for(let j=0;j<g.output.length;j++){assert.equal(g.output[j].namespace,'pad');assert.equal(n.output[j].namespace,undefined)}console.log('DIFFERENCE explicit namespace restored in Go; legacy Node output lacks it')}
    if(fixture.path==='/v1/messages'){assert.deepEqual(g.completed.response.usage,{input_tokens:3,output_tokens:5,total_tokens:8});assert.equal(n.completed.response.usage,undefined)}
    if(fixture.path===gpath){assert.deepEqual(g.completed.response.usage,{input_tokens:3,output_tokens:5,total_tokens:10,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:2}});assert.deepEqual(g.completed.response.usage,n.completed.response.usage)}
   }
  }
  console.log('PASS uniform blackbox '+fixture.name);
 }finally{
  if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});
  child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);
 }
}
console.log('PASS 30 shared mock/resource routing cases; explicit namespace/history/system/choice/usage/truncation differences, not full parity or performance proof');
