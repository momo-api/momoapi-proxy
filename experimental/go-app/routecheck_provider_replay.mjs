import assert from 'node:assert/strict';
import {createMomoSwitch} from '../../src/server.mjs';
const nl=String.fromCharCode(10);
const chat=delta=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+nl+nl+'data: [DONE]'+nl+nl;
const cf=(type,fields={})=>'event: '+type+nl+'data: '+JSON.stringify({type,...fields})+nl+nl;
const cs=cf('message_start',{message:{id:'msg_switch',type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],usage:{input_tokens:3,output_tokens:1}}});
const ce=reason=>cf('message_delta',{delta:{stop_reason:reason,stop_sequence:null},usage:{output_tokens:5}})+cf('message_stop');
const claude=(name,args)=>cs+cf('content_block_start',{index:0,content_block:name?{type:'tool_use',id:'call_switch',name,input:{}}:{type:'text',text:''}})+cf('content_block_delta',{index:0,delta:name?{type:'input_json_delta',partial_json:JSON.stringify(args)}:{type:'text_delta',text:'target-answer'}})+cf('content_block_stop',{index:0})+ce(name?'tool_use':'end_turn');
const gemini=parts=>'data: '+JSON.stringify({candidates:[{index:0,content:{role:'model',parts},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:5,totalTokenCount:8}})+nl+nl;
const specs=[{model:'gpt-5.5',path:'/v1/chat/completions',calls:chat({tool_calls:[{index:0,id:'call_switch',type:'function',function:{name:'pad__read',arguments:'{"x":1}'}}]}),text:chat({content:'target-answer'})},{model:'claude-sonnet-4-6',path:'/v1/messages',calls:claude('pad__read',{x:1}),text:claude()},{model:'gemini-2.5-flash',path:'/v1beta/models/gemini-2.5-flash:streamGenerateContent',calls:gemini([{functionCall:{id:'call_switch',name:'pad__read',args:{x:1}}}]),text:gemini([{text:'target-answer'}])}];
export async function providerReplayBlackbox(launch,invoke){
 let count=0;
 for(const source of specs)for(const target of specs){if(source===target)continue;for(const streaming of [true,false]){
  const {child,handoff}=await launch({paths:[source.path,source.path,target.path,target.path],streams:[source.calls,source.calls,target.text,target.text]});let server;
  try{
   const env={MOMO_PROXY_HOME:'unused-provider-replay',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
   server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}}, {env,loggingRuntime,assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,'mock.example');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));const nodeURL='http://127.0.0.1:'+server.address().port,goURL=handoff.base_url.slice(0,-3);
   const tools=[{type:'namespace',name:'pad',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{}}}]}];
   const initial={model:source.model,stream:false,input:[{role:'user',content:'source-turn'}],tools};
   const n1=await invoke(nodeURL,'synthetic-node-only',initial),g1=await invoke(goURL,handoff.api_key,initial);assert.equal(n1.status,200);assert.equal(g1.status,200);assert.ok(n1.completed&&g1.completed);assert.equal(g1.output.length,1);assert.equal(g1.output[0].namespace,'pad');
   // Both targets receive IDENTICAL full canonical transcript and previous ID.
   // Node converted routes ignore local anchor; Go validates/safely deduplicates.
   const switched={model:target.model,stream:streaming,previous_response_id:g1.completed.response.id,tools,input:[...initial.input,...g1.output,{type:'function_call_output',call_id:'call_switch',output:'paired-switch-result'},{role:'user',content:'target-turn'}]};
   assert.equal((await invoke(goURL,handoff.api_key,switched)).status,400,'default cross-model gate');
   const n2=await invoke(nodeURL,'synthetic-node-only',switched),g2=await invoke(goURL,handoff.api_key,switched,'/v1/responses',{'X-MOMO-History':'replay-v1'});assert.equal(n2.status,200);assert.equal(g2.status,200);assert.ok(n2.completed&&g2.completed);assert.deepEqual(g2.output,n2.output);assert.equal(g2.completed.response.model,target.model);assert.equal(g2.json,streaming?undefined:true);
   const captures=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captures.length,4,'one source and target per implementation; default rejection zero sends');
   for(const actual of captures.slice(2)){const serialized=JSON.stringify(actual);for(const token of ['source-turn','target-turn','paired-switch-result','call_switch','pad__read'])assert.ok(serialized.includes(token),token);assert.ok(!serialized.includes('previous_response_id'));assert.ok(!serialized.includes('X-MOMO-History'))}
   const [n,g]=captures.slice(2);
   if(target.path==='/v1/chat/completions'){assert.equal(g.messages[1].tool_calls[0].function.name,'pad__read');assert.equal(n.messages[1].tool_calls[0].function.name,'read');const nodeMessages=structuredClone(n.messages);nodeMessages[1].tool_calls[0].function.name='pad__read';assert.deepEqual(g.messages,nodeMessages);assert.deepEqual(g.tools,n.tools);assert.deepEqual(g.stream_options,{include_usage:true});assert.equal(n.stream_options,undefined)}
   else if(target.path==='/v1/messages'){assert.equal(g.messages.length,3);assert.equal(g.messages[1].content[0].id,'call_switch');assert.equal(g.messages[1].content[0].name,'pad__read');assert.deepEqual(g.messages[1].content[0].input,{x:1});assert.equal(g.messages[2].content[0].tool_use_id,'call_switch');assert.equal(g.messages[2].content[0].content,'paired-switch-result');assert.equal(n.messages[1].content[0].name,'pad__read');assert.equal(g.messages[2].content[1].text,'target-turn');assert.equal(g.max_tokens,n.max_tokens)}
   else{assert.equal(g.contents.length,3);assert.deepEqual(g.contents[1].parts[0].functionCall,{id:'call_switch',name:'pad__read',args:{x:1}});assert.equal(g.contents[2].parts[0].functionResponse.id,'call_switch');assert.equal(g.contents[2].parts[0].functionResponse.name,'pad__read');assert.deepEqual(g.contents[2].parts[0].functionResponse.response,{result:'paired-switch-result'});assert.equal(n.contents[1].parts[0].functionCall.name,'pad__read');assert.equal(g.contents[2].parts[1].text,'target-turn')}
   console.log('PASS shared converted provider replay '+source.model+' -> '+target.model+' '+(streaming?'SSE':'JSON')+'; identical full input, Go opt-in anchor validation/dedup and alias preservation vs Node ignored converted anchor; protocol-specific historical alias differences independently asserted; not opaque/signed or cross-account state');count++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
 }}
 return count;
}
