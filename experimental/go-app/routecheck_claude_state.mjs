import assert from 'node:assert/strict';
import {createMomoSwitch} from '../../src/server.mjs';

const model='claude-sonnet-4-6',sig='synthetic opaque signature 中文: not Base64',data='opaque ciphertext';
const f=(type,fields={})=>'event: '+type+'\r\ndata: '+JSON.stringify({type,...fields})+'\r\n\r\n';
const start=f('message_start',{message:{id:'msg_mock',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:1}}});
const end=reason=>f('message_delta',{delta:{stop_reason:reason,stop_sequence:null},usage:{output_tokens:5}})+f('message_stop');
const think=(index,text)=>f('content_block_start',{index,content_block:{type:'thinking',thinking:'',signature:''}})+f('content_block_delta',{index,delta:{type:'thinking_delta',thinking:text}})+f('content_block_delta',{index,delta:{type:'signature_delta',signature:sig}})+f('content_block_stop',{index});
const redact=index=>f('content_block_start',{index,content_block:{type:'redacted_thinking',data}})+f('content_block_stop',{index});
const text=index=>f('content_block_start',{index,content_block:{type:'text',text:''}})+f('content_block_delta',{index,delta:{type:'text_delta',text:'answer'}})+f('content_block_stop',{index});
const call=index=>f('content_block_start',{index,content_block:{type:'tool_use',id:'signed_call',name:'pad__read',input:{n:1}}})+f('content_block_stop',{index});
const tools=[{type:'namespace',name:'pad',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{n:{type:'number'}}}}]}];

export async function claudeStateBlackbox(launch,invoke){
 let count=0;
 for(const stream of [false,true])for(const full of [false,true])for(const omitted of [false,true]){
  const summary=omitted?'':'public summary\r\n';
  const wire=start+think(0,summary)+redact(1)+text(2)+call(3)+think(4,'')+end('tool_use');
  const {child,handoff}=await launch({paths:['/v1/messages','/v1/messages','/v1/messages','/v1/messages'],streams:[wire,wire,start+text(0)+end('end_turn'),start+text(0)+end('end_turn')]});let server;
  try{
   const env={MOMO_PROXY_HOME:'unused-claude-state',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
   server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},{env,loggingRuntime,assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,'mock.example');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));const nodeURL='http://127.0.0.1:'+server.address().port,goURL=handoff.base_url.slice(0,-3);
   const initial={model,stream,input:[{role:'user',content:'first signed turn'}],tools,momo_claude_thinking:{type:'adaptive',display:omitted?'omitted':'summarized'}};
   const n=await invoke(nodeURL,'synthetic-node-only',initial),g=await invoke(goURL,handoff.api_key,initial);
   assert.equal(n.status,200);assert.equal(g.status,200);assert.ok(n.completed&&g.completed);
   assert.equal(g.output.length,5);assert.deepEqual(g.output[0],{type:'reasoning',summary:[{type:'summary_text',text:summary}],momo_claude:{model,type:'thinking',signature:sig}});
   assert.deepEqual(g.output[1],{type:'reasoning',summary:[],momo_claude:{model,type:'redacted_thinking',data}});
   assert.equal(g.output[3].namespace,'pad');assert.equal(g.output[4].summary[0].text,'');
   assert.ok(!n.output.some(v=>v.type==='reasoning'));assert.equal(n.output.filter(v=>v.type==='message').flatMap(v=>v.content).map(v=>v.text).join(''),'answer');
   const result={type:'function_call_output',call_id:'signed_call',output:'paired result'};
   const next={...initial,previous_response_id:g.completed.response.id,input:full?[...initial.input,...g.output,result]:[result]};
   const n2=await invoke(nodeURL,'synthetic-node-only',next),g2=await invoke(goURL,handoff.api_key,next);
   assert.equal(n2.status,200);assert.equal(g2.status,200);assert.ok(n2.completed&&g2.completed);
   const captures=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captures.length,4);
   assert.equal(captures[0].thinking,undefined,'Node ignores explicit native thinking contract');assert.deepEqual(captures[1].thinking,initial.momo_claude_thinking);
   assert.deepEqual(captures[0].messages,captures[1].messages);
   const blocks=[{type:'thinking',thinking:summary,signature:sig},{type:'redacted_thinking',data},{type:'text',text:'answer'},{type:'tool_use',id:'signed_call',name:'pad__read',input:{n:1}},{type:'thinking',thinking:'',signature:sig}];
   assert.deepEqual(captures[3].messages[1].content,blocks,'Go preserves exact signed block order');
   assert.ok(!captures[2].messages.flatMap(v=>v.content).some(v=>v.type==='thinking'||v.type==='redacted_thinking'),'Node loses signed/redacted continuation');
   for(const body of captures.slice(2))assert.ok(body.messages.flatMap(v=>v.content).some(v=>v.type==='tool_result'&&v.tool_use_id==='signed_call'&&v.content==='paired result'));
   console.log('PASS uniform Claude signed/redacted '+(stream?'SSE':'JSON')+' '+(full?'full':'suffix')+' '+(omitted?'omitted':'public summary')+'; Node thinking-state loss independently asserted');count++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))])}
 }
 return count;
}
