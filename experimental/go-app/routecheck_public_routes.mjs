import assert from 'node:assert/strict';
import {createMomoSwitch} from '../../src/server.mjs';
import {request as httpRequest} from 'node:http';

const chat='data: {"choices":[{"index":0,"delta":{"content":"route-ok"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
const native='event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
const claudeModel='claude-sonnet-4-6';
const cf=(type,fields={})=>'event: '+type+'\r\ndata: '+JSON.stringify({type,...fields})+'\r\n\r\n';
const claude=cf('message_start',{message:{id:'msg_route',type:'message',role:'assistant',model:claudeModel,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:1}}})+cf('content_block_start',{index:0,content_block:{type:'text',text:''}})+cf('content_block_delta',{index:0,delta:{type:'text_delta',text:'route-ok'}})+cf('content_block_stop',{index:0})+cf('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}})+cf('message_stop');
const gemini='data: '+JSON.stringify({candidates:[{index:0,content:{role:'model',parts:[{text:'route-ok'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:5,totalTokenCount:8}})+'\r\n\r\n';
const compact={id:'cmp_route',object:'response.compaction',output:[{type:'compaction',encrypted_content:'synthetic-opaque'}]};
const models=[
 ...['gpt-5.5','gpt-5.6-terra','gpt-5.4-mini','grok-4.5','cursor-auto','GEMINI-x'].map(model=>({model,kind:'chat',path:'/v1/chat/completions',wire:chat})),
 ...['gpt-5.6-sol','gpt-5.6-luna','mimo-a','x-sol','x-luna','x-responses'].map(model=>({model,kind:'responses',path:'/v1/responses',wire:native})),
 {model:claudeModel,kind:'claude',path:'/v1/messages',wire:claude},
 ...['gemini-3.5-flash','gemini-3.1-pro-preview'].map(model=>({model,kind:'gemini',path:'/v1beta/models/'+model+':streamGenerateContent',wire:gemini})),
];

export async function publicRoutesBlackbox(launch,invoke){
 let count=0;
 const fixtures=[
  ...models.flatMap(f=>['/v1/responses','/responses','/responses/','/v1/responses///'].map(entry=>({...f,entry,payload:{model:f.model,stream:true,input:[{role:'user',content:'same-route-input'}]}}))),
  ...['/v1/chat/completions','/chat/completions','/chat/completions/','/v1/chat/completions///'].map(entry=>({entry,kind:'chat-direct',path:'/v1/chat/completions',wire:chat,payload:{model:'claude-sonnet-4-6',stream:true,messages:[{role:'user',content:'chat stays chat regardless of model'}]}})),
  ...['/v1/responses/compact','/responses/compact','/responses/compact/','/v1/responses/compact///'].map(entry=>({entry,kind:'compact',path:'/v1/responses/compact',wire:JSON.stringify(compact),payload:{model:'gpt-5.6-sol',input:[{role:'user',content:'same compact'}]}})),
  ...['/v1/models','/models','/models/','/v1/models///'].map(entry=>({entry,kind:'models',path:'/v1/models'})),
 ];
 for(const f of fixtures){
  const {child,handoff}=await launch({path:f.path,stream:f.wire,upstreamJSON:f.kind==='compact',models:f.kind==='models'});let server;
  try{
   const env={MOMO_PROXY_HOME:'unused-public-routes',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
   const hostname=f.kind==='compact'?'api.openai.com':'mock.example';
   server=createMomoSwitch({endpoint:'https://'+hostname,apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,compactionMode:'native',requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{nativeCompactModels:['gpt-5.6-sol'],outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}}, {env,loggingRuntime,assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,hostname);assert.equal(u.pathname,f.path,'actual Node model target');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));
   const urls=['http://127.0.0.1:'+server.address().port,handoff.base_url.slice(0,-3)];
   if(f.kind==='models'){
    const results=[];
    for(let i=0;i<2;i++){
     const result=await new Promise((resolve,reject)=>{
      const req=httpRequest(urls[i]+f.entry,{method:'GET',headers:{Authorization:'Bearer '+(i?handoff.api_key:'synthetic-node-only')}},r=>{const chunks=[];r.on('data',b=>chunks.push(b));r.once('end',()=>resolve({status:r.statusCode,body:Buffer.concat(chunks).toString('utf8')}));r.once('error',reject)});
      req.setTimeout(10000,()=>req.destroy(Error('models timeout')));req.once('error',reject);req.end();
     });
     assert.equal(result.status,200);results.push(JSON.parse(result.body));
    }
    assert.deepEqual(results[0],results[1]);
   }else{
    const n=await invoke(urls[0],'synthetic-node-only',f.payload,f.entry);
    const g=await invoke(urls[1],handoff.api_key,f.payload,f.entry,f.kind==='compact'?{'X-MOMO-Compact':'native'}:{});
    assert.equal(n.status,200);assert.equal(g.status,200);
    if(f.kind==='compact'){assert.deepEqual(JSON.parse(n.body),compact);assert.equal(g.body,JSON.stringify(compact))}
    else if(f.kind==='chat-direct'){assert.ok(n.body.includes('route-ok'));assert.equal(g.body,chat)}
    else {assert.ok(n.completed&&g.completed)}
   }
   const captures=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captures.length,2,'each side exactly one send');
   if(f.kind==='models'){assert.deepEqual(captures,[{models_path:'/v1/models'},{models_path:'/v1/models'}])}
   else if(f.kind==='responses'){
    assert.deepEqual(captures[0],{...f.payload,input:[{type:'message',role:'user',content:[{type:'input_text',text:'same-route-input'}]}]},'Node canonicalizes native user input');
    assert.deepEqual(captures[1],f.payload,'Go native body remains byte-shape exact');
   }
   else if(['compact','chat-direct'].includes(f.kind)){assert.deepEqual(captures[0],f.payload);assert.deepEqual(captures[1],f.payload)}
   else if(f.kind==='gemini'){assert.deepEqual(captures[0].contents,captures[1].contents)}
   else {assert.equal(captures[0].model,f.model);assert.equal(captures[1].model,f.model);assert.deepEqual(captures[0].messages,captures[1].messages)}
   console.log('PASS uniform public route '+f.entry+' '+(f.model||f.kind)+' -> '+f.path+'; actual same mock/input/resources; exactly one upstream send per side');count++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))])}
 }
 return count;
}
