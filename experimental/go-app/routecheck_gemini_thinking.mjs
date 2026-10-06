import assert from 'node:assert/strict';
import {createMomoSwitch} from '../../src/server.mjs';

const model='gemini-3.1-pro-preview',path='/v1beta/models/'+model+':streamGenerateContent';
const wire='data: '+JSON.stringify({candidates:[{index:0,content:{role:'model',parts:[{text:'answer'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:5,totalTokenCount:8}})+'\r\n\r\n';
const native=config=>({momo_gemini_thinking:config});
const cases=[
 ['include true',native({includeThoughts:true}),{includeThoughts:true}],
 ['include false',native({includeThoughts:false}),{includeThoughts:false}],
 ['minimal native',native({thinkingLevel:'MINIMAL'}),{thinkingLevel:'MINIMAL'}],
 ['low native',native({thinkingLevel:'LOW'}),{thinkingLevel:'LOW'}],
 ['medium native',native({thinkingLevel:'MEDIUM'}),{thinkingLevel:'MEDIUM'}],
 ['high native',native({thinkingLevel:'HIGH'}),{thinkingLevel:'HIGH'}],
 ['budget zero',native({thinkingBudget:0}),{thinkingBudget:0}],
 ['budget automatic',native({thinkingBudget:-1,includeThoughts:true}),{thinkingBudget:-1,includeThoughts:true}],
 ['budget exact',native({thinkingBudget:1024}),{thinkingBudget:1024}],
 ['budget int32',native({thinkingBudget:2147483647}),{thinkingBudget:2147483647}],
 ['minimal effort',{reasoning_effort:'minimal'},{thinkingLevel:'MINIMAL'},{thinkingLevel:'LOW'}],
 ['low effort alias',{model_reasoning_effort:'low'},{thinkingLevel:'LOW'},{thinkingLevel:'LOW'}],
 ['medium effort object',{reasoning:{effort:'medium'}},{thinkingLevel:'MEDIUM'},{thinkingLevel:'MEDIUM'}],
 ['consistent high',{...native({thinkingLevel:'HIGH',includeThoughts:false}),reasoning_effort:'high',model_reasoning_effort:'HIGH',reasoning:{effort:'high'}},{thinkingLevel:'HIGH',includeThoughts:false},{thinkingLevel:'HIGH'}],
 ['xhigh rejects',{reasoning_effort:'xhigh'},null,{thinkingLevel:'HIGH'}],
 ['none rejects',{reasoning_effort:'none'},null,undefined],
 ['conflicting aliases',{reasoning_effort:'low',model_reasoning_effort:'high'},null,{thinkingLevel:'LOW'}],
 ['conflicting native',{...native({thinkingBudget:1024}),reasoning_effort:'high'},null,{thinkingLevel:'HIGH'}],
];

export async function geminiThinkingBlackbox(launch,invoke){
 let count=0;
 for(const [name,controls,expected,nodeExpected] of cases)for(const stream of [false,true]){
  const {child,handoff}=await launch({paths:[path,path],streams:[wire,wire]});let server;
  try{
   const env={MOMO_PROXY_HOME:'unused-gemini-thinking',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
   server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}}, {env,loggingRuntime,assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,'mock.example');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));
   const payload={model,stream,input:[{role:'user',content:'same thinking controls'}],max_output_tokens:2048,...controls};
   const n=await invoke('http://127.0.0.1:'+server.address().port,'synthetic-node-only',payload),g=await invoke(handoff.base_url.slice(0,-3),handoff.api_key,payload);
   assert.equal(n.status,200);assert.ok(n.completed);
   const captures=await(await fetch(handoff.mock_url+'/capture')).json();
   assert.deepEqual(captures[0].generationConfig?.thinkingConfig,nodeExpected,'Node control ignore/clamp independently asserted');
   assert.equal(captures[0].generationConfig?.maxOutputTokens,undefined,'Node omits max_output_tokens');
   if(expected===null){assert.equal(g.status,400);assert.equal(captures.length,1,'Go rejects before send; no retry')}
   else{
    assert.equal(g.status,200);assert.ok(g.completed);assert.equal(captures.length,2);
    assert.deepEqual(captures[1].contents,captures[0].contents);
    assert.deepEqual(captures[1].generationConfig,{maxOutputTokens:2048,thinkingConfig:expected});
   }
   console.log('PASS uniform Gemini thinking '+name+' '+(stream?'SSE':'JSON')+'; native/effort/max-token differences independently asserted');count++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))])}
 }
 return count;
}
