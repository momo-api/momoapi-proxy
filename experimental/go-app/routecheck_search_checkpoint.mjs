import assert from 'node:assert/strict';
import {createMomoSwitch} from '../../src/server.mjs';
const frame=o=>'data: '+JSON.stringify(o)+'\n\n';
const specs=[
 {model:'gpt-5.5',path:'/v1/chat/completions',text:frame({choices:[{index:0,delta:{content:'checkpoint-resumed'},finish_reason:'stop'}]})+'data: [DONE]\n\n'},
 {model:'claude-sonnet-4-6',path:'/v1/messages',text:frame({type:'message_start',message:{id:'checkpoint_msg',type:'message',role:'assistant',content:[],usage:{input_tokens:3,output_tokens:1}}})+frame({type:'content_block_start',index:0,content_block:{type:'text',text:'checkpoint-resumed'}})+frame({type:'content_block_stop',index:0})+frame({type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}})+frame({type:'message_stop'})},
 {model:'gemini-2.5-flash',path:'/v1beta/models/gemini-2.5-flash:streamGenerateContent',text:frame({candidates:[{index:0,content:{role:'model',parts:[{text:'checkpoint-resumed'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:5,totalTokenCount:8}})},
];
export async function searchCheckpointBlackbox(launch,invoke){
 let cases=0;
 for(const spec of specs)for(const variant of ['loaded','empty','additional'])for(const stream of [true,false]){
  const {child,handoff}=await launch({path:spec.path,stream:spec.text});let server;
  try{
   const env={MOMO_PROXY_HOME:'unused-search-checkpoint-profile',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,compactionMode:'local',requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},{env,loggingRuntime:{env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})},assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,'mock.example');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));
   const nodeURL='http://127.0.0.1:'+server.address().port,goURL=handoff.base_url.slice(0,-3);
   const search={type:'tool_search',execution:'client',parameters:{type:'object',properties:{goal:{type:'string'}},required:['goal'],additionalProperties:false}};
   const def={type:'namespace',name:'pad',tools:[{type:'function',name:'read',defer_loading:variant!=='additional',strict:true,parameters:{type:'object',properties:{n:{type:'integer',minimum:0}},required:['n'],additionalProperties:false}}]};
   const discovery=variant==='additional'?[{type:'additional_tools',role:'developer',tools:[def]}]:[{type:'tool_search_call',execution:'client',call_id:'checkpoint_search',arguments:{goal:'read'}},{type:'tool_search_output',execution:'client',call_id:'checkpoint_search',tools:variant==='empty'?[]:[def]}];
   const input=[{role:'developer',content:'exact constraint 中文🙂'},{role:'user',content:'old task'},{role:'assistant',content:'old ordinary prose '.repeat(300)},{role:'user',content:'discover exact'},{role:'assistant',content:'before discovery '.repeat(100)},...discovery,{role:'assistant',content:'search interpretation exact '.repeat(100)},...(variant==='empty'?[]:[{role:'user',content:'read exact'},{type:'function_call',namespace:'pad',name:'read',call_id:'checkpoint_read',arguments:'{"n":9007199254740993}'},{type:'function_call_output',call_id:'checkpoint_read',output:'client result exact'},{role:'assistant',content:'read interpretation exact '.repeat(100)}]),{role:'user',content:'CURRENT checkpoint exact 中文🙂'}];
   const p={model:spec.model,stream:false,momo_tool_loading:'client-search',parallel_tool_calls:false,tools:variant==='additional'?[search]:[search,def],input};
   const n=await invoke(nodeURL,'synthetic-node-only',p,'/v1/responses/compact'),g=await invoke(goURL,handoff.api_key,p,'/v1/responses/compact');
   assert.equal(n.status,200);assert.equal(g.status,200);
   const nf=JSON.parse(n.body),gf=JSON.parse(g.body);
   assert.equal(gf.output.length,input.length);assert.ok(g.body.length<JSON.stringify(p).length);assert.ok(!g.body.includes('encrypted_content'));
   for(let i=0;i<input.length;i++)if(i!==2)assert.deepEqual(gf.output[i],input[i]);
   assert.match(gf.output[2].content[0].text,/^\[MOMO explicit lossy checkpoint;/);
   assert.equal(nf.output.filter(i=>i.type==='tool_search_call'||i.type==='tool_search_output').length,0,'Node local policy drops search lifecycle; not equivalent');
   if(variant==='additional')assert.deepEqual(nf.output.find(i=>i.type==='additional_tools'),discovery[0]);
   assert.equal((await(await fetch(handoff.mock_url+'/capture')).json()).length,0,'both local checkpoints zero upstream');
   // Replay IDENTICAL explicit canonical checkpoint to both; do not compare
   // continuations fed divergent Node/Go outputs and pretend inputs matched.
   const resume={...p,stream,input:gf.output};
   const nr=await invoke(nodeURL,'synthetic-node-only',resume),gr=await invoke(goURL,handoff.api_key,resume);
   assert.equal(nr.status,200);assert.equal(gr.status,200);assert.ok(nr.completed);assert.ok(gr.completed);assert.equal(gr.output[0].content[0].text,'checkpoint-resumed');
   const captures=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captures.length,2,'one physical resume each');
   const raw=await(await fetch(handoff.mock_url+'/capture-raw')).json();assert.equal(raw.length,2);
   for(const [index,wire] of captures.entries()){
    const ds=spec.model.startsWith('gemini')?wire.tools[0].functionDeclarations:wire.tools;
    const names=ds.map(d=>spec.model==='gpt-5.5'?d.function.name:d.name);
    // Node omits the search declaration and exposes deferred schemas even for
    // empty results; Go exposes only the validated ordered active set.
    assert.deepEqual(names,index===0?['pad__read']:(variant==='empty'?['momo__client_tool_search']:['momo__client_tool_search','pad__read']));
    if(variant!=='empty'){
     const expected=index===0&&spec.model!=='gpt-5.5'?'9007199254740992':'9007199254740993';
     assert.ok(raw[index].includes(expected),'independent raw argument precision, parsed JSON cannot verify bigint');
     assert.ok(JSON.stringify(wire).includes('client result exact'));
    }
    assert.ok(JSON.stringify(wire).includes('CURRENT checkpoint exact'));
   }
   const pending=structuredClone(p);pending.input=pending.input.filter(i=>i.type!=='tool_search_output');
   if(variant!=='additional'){const bad=await invoke(goURL,handoff.api_key,pending,'/v1/responses/compact');assert.equal(bad.status,422);assert.equal((await(await fetch(handoff.mock_url+'/capture')).json()).length,2);}
   console.log('PASS shared search checkpoint '+spec.model+' '+variant+' '+(stream?'SSE':'JSON')+'; identical input/resources/mock, Node discovery loss independently asserted, same explicit canonical replay, no auto integration/semantic summary');cases++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
 }return cases;
}
