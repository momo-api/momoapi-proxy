import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createMomoSwitch} from '../../src/server.mjs';
const ns='n'.repeat(64),name='t'.repeat(64),flat=ns+'__'+name;
const alias='mta_'+name.slice(-16)+'_'+createHash('sha256').update(JSON.stringify([ns,name])).digest('base64url');
const nl='\n';
const chat=d=>'data: '+JSON.stringify({choices:[{index:0,delta:d,finish_reason:d.tool_calls?'tool_calls':'stop'}]})+nl+nl+'data: [DONE]'+nl+nl;
const cf=(type,f={})=>'event: '+type+nl+'data: '+JSON.stringify({type,...f})+nl+nl;
const claude=(wire,args)=>cf('message_start',{message:{id:'msg_alias',type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],usage:{input_tokens:3,output_tokens:1}}})+cf('content_block_start',{index:0,content_block:wire?{type:'tool_use',id:'call_alias',name:wire,input:{}}:{type:'text',text:''}})+cf('content_block_delta',{index:0,delta:wire?{type:'input_json_delta',partial_json:JSON.stringify(args)}:{type:'text_delta',text:'alias-done'}})+cf('content_block_stop',{index:0})+cf('message_delta',{delta:{stop_reason:wire?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:5}})+cf('message_stop');
const gemini=parts=>'data: '+JSON.stringify({candidates:[{index:0,content:{role:'model',parts},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:5,totalTokenCount:8}})+nl+nl;
const specs=[{model:'gpt-5.5',path:'/v1/chat/completions',call:(wire,args)=>chat({tool_calls:[{index:0,id:'call_alias',type:'function',function:{name:wire,arguments:JSON.stringify(args)}}]}),text:chat({content:'alias-done'})},{model:'claude-sonnet-4-6',path:'/v1/messages',call:claude,text:claude()},{model:'gemini-2.5-flash',path:'/v1beta/models/gemini-2.5-flash:streamGenerateContent',call:(wire,args)=>gemini([{functionCall:{id:'call_alias',name:wire,args}}]),text:gemini([{text:'alias-done'}])}];
export async function toolAliasBlackbox(launch,invoke){
 let count=0;
 for(const spec of specs)for(const stream of [true,false])for(const kind of ['function','custom']){
  const args=kind==='custom'?{input:'raw 中文🙂'}:{x:1};
  const {child,handoff}=await launch({paths:Array(4).fill(spec.path),streams:[spec.call(flat,args),spec.call(alias,args),spec.text,spec.text]});let server;
  try{
   const env={MOMO_PROXY_HOME:'unused-alias-profile',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},{env,loggingRuntime:{env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})},assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,'mock.example');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));const nodeURL='http://127.0.0.1:'+server.address().port,goURL=handoff.base_url.slice(0,-3);
   const p={model:spec.model,stream,input:[{role:'user',content:'long-alias-turn'}],tools:[{type:'namespace',name:ns,tools:[{type:kind,name}]}],tool_choice:{type:kind,name,namespace:ns}};
   const n=await invoke(nodeURL,'synthetic-node-only',p),g=await invoke(goURL,handoff.api_key,p);assert.equal(n.status,200);assert.equal(g.status,200);assert.ok(n.completed&&g.completed);const normalized=structuredClone(n.output);if(kind==='custom'){assert.equal(g.output[0].input,args.input);assert.equal(n.output[0].input,'await tools.exec_command({ cmd: '+JSON.stringify(args.input)+' });','Node raw custom wrapper independently asserted');normalized[0].input=args.input}assert.equal(n.output[0].namespace,undefined,'Node converted namespace loss independently asserted');normalized[0].namespace=ns;assert.deepEqual(g.output,normalized);assert.equal(g.output[0].namespace,ns);assert.equal(g.output[0].name,name);assert.equal(g.output[0].call_id,'call_alias');assert.ok(!JSON.stringify(g.output).includes(alias));
   const follow={...p,tool_choice:'auto',input:[...p.input,...g.output,{type:kind==='custom'?'custom_tool_call_output':'function_call_output',call_id:'call_alias',output:'paired-alias-result'}]};
   const n2=await invoke(nodeURL,'synthetic-node-only',follow),g2=await invoke(goURL,handoff.api_key,follow);assert.equal(n2.status,200);assert.equal(g2.status,200);assert.ok(n2.completed&&g2.completed);assert.deepEqual(g2.output,n2.output);
   const captures=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captures.length,4);
   const declarations=c=>spec.model.startsWith('gemini')?c.tools[0].functionDeclarations.map(t=>t.name):c.tools.map(t=>spec.model.startsWith('claude')?t.name:t.function.name);
   assert.deepEqual(declarations(captures[0]),[flat]);assert.deepEqual(declarations(captures[1]),[alias]);assert.deepEqual(declarations(captures[2]),[flat]);assert.deepEqual(declarations(captures[3]),[alias]);
   const gHistory=JSON.stringify(captures[3]);assert.ok(gHistory.includes(alias)&&gHistory.includes('call_alias')&&gHistory.includes('paired-alias-result'));assert.ok(!gHistory.includes(flat));
   if(spec.model==='gpt-5.5'){assert.equal(captures[1].tool_choice.function.name,alias);assert.equal(captures[3].messages[1].tool_calls[0].function.name,alias)}else if(spec.model.startsWith('claude')){assert.equal(captures[1].tool_choice.name,alias);assert.equal(captures[3].messages[1].content[0].name,alias)}else{assert.deepEqual(captures[1].toolConfig.functionCallingConfig.allowedFunctionNames,[alias]);assert.equal(captures[3].contents[1].parts[0].functionCall.name,alias)}
   console.log('PASS shared long tool identity '+spec.model+' '+kind+' '+(stream?'SSE':'JSON')+'; identical input/resources, Node 130-byte wire vs Go deterministic 64-byte wire independently asserted, canonical identity/pairing restored; permissive mock not proof Node wire accepted by real provider');count++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
 }return count;
}
