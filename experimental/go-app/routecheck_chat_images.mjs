import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {createMomoSwitch} from '../../src/server.mjs';

export async function chatImageBlackbox(launch,invoke){
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
 const ref='data:image/png;base64,'+png,model='gemini-3.1-flash-image';
 const part=url=>({type:'image_url',image_url:{url}});
 const request={model,prompt:' 中文🙂 ',n:1,aspect_ratio:'4:3',resolution:'2k',reference_images:[ref]};
 const want={model,messages:[{role:'user',content:[{type:'text',text:'中文🙂'},part(ref)]}],modalities:['text','image'],extra_body:{google:{image_config:{aspect_ratio:'4:3',image_size:'2K'}}}};
 const catalog={models:[{id:model,modality:'image',available:true,operations:['generate','edit'],parameters:{max_reference_images:{maximum:1}},transports:{edit:'chat-completions-multimodal'}}]};
 let count=0;
 for(const shape of ['images','content','url','prose','length','refusal','duplicate','401','429','500']){
  const status=/^\d/.test(shape)?Number(shape):200;
  const message={role:'assistant',content:'synthetic-private-prose',images:[part(shape==='url'?'https://images.example/chat.png':ref)]};
  if(shape==='content'){delete message.images;message.content=[{type:'text',text:'synthetic-private-prose'},part(ref)]}
  if(shape==='prose'){delete message.images;message.content='not an image part: '+ref}
  if(shape==='refusal')message.refusal='synthetic refusal';
  const output={choices:[{index:0,message,finish_reason:shape==='length'?'length':'stop'}]};
  let stream=JSON.stringify(output);if(shape==='duplicate')stream='{"choices":[],"choices":'+JSON.stringify(output.choices)+'}';
  const {child,handoff}=await launch({path:'/v1/chat/completions',stream,upstreamJSON:true,status,image:true,imageCatalog:JSON.stringify(catalog)});let server;
  try{
   const stored=[],env={MOMO_PROXY_HOME:'unused-chatimage-routecheck',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},
    {env,loggingRuntime:{env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})},assetStore:{putBase64:async image=>{stored.push(image);return {asset_id:'img_'+'a'.repeat(64),reference:'asset:img_'+'a'.repeat(64),mime_type:'image/png'}},list:async()=>[]},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,'mock.example','no remote output fetch in mock');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));
   const nodeURL='http://127.0.0.1:'+server.address().port,goURL=handoff.base_url.replace(/\/v1$/,'');
   await new Promise((resolve,reject)=>{const r=httpRequest(goURL+'/internal/images/capabilities',{headers:{authorization:'Bearer '+handoff.api_key}},res=>{res.resume();res.once('end',()=>{try{assert.equal(res.statusCode,200);resolve()}catch(e){reject(e)}})});r.once('error',reject);r.end()});
   const nr=await invoke(nodeURL,'synthetic-node-only',request,'/internal/images/edit',{'x-local-token':'synthetic-node-only'}),gr=await invoke(goURL,handoff.api_key,request,'/internal/images/edit');
   const bad=['prose','length','refusal','duplicate'].includes(shape);
   assert.equal(nr.status,shape==='url'?502:status===500?502:status);assert.equal(gr.status,bad?502:status);
   const captures=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captures.length,2);assert.deepEqual(captures[0],want);assert.deepEqual(captures[1],want);
   if(status===200&&shape!=='url'){assert.equal(stored.length,1);assert.equal(stored[0].b64_json,png);assert.equal(JSON.parse(nr.body).images[0].b64_json,undefined)}
   if(status===200&&!bad){const result=JSON.parse(gr.body);assert.equal(result.terminal,true);assert.equal(result.task_id,undefined);assert.equal(result.images.length,1);if(shape==='url')assert.deepEqual(result.images,[{url:'https://images.example/chat.png'}]);else assert.equal(result.images[0].b64_json,png)}
   assert.ok(!gr.body.includes('synthetic-private-prose'));if(bad)assert.ok(!gr.body.includes('b64_json'));
   console.log('PASS shared Gemini chat image edit '+shape+'; exact same input/mock/resources/wire; Node recursive extraction/persistence vs Go typed finished output/no fetch independently asserted; not live inference');count++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
 }
 return count;
}
