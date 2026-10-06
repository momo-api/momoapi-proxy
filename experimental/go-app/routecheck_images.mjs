import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {createMomoSwitch} from '../../src/server.mjs';
async function localGET(url,headers){
 return new Promise((resolve,reject)=>{
  const req=httpRequest(url,{headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,json:()=>JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});
  req.setTimeout(10000,()=>req.destroy(Error('image query timeout')));req.once('error',reject);req.end();
 });
}

// Same TCP upstream, budgets and exact canonical request on Node and Go. Node
// asset persistence is an in-memory test stub; URL downloading is intentionally
// rejected by the fixture, not a parity/real image storage or generation proof.
export async function imageBlackbox(launch,invoke,edit=false){
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
 const profiles=[
  {model:'momoapi-gpt-image-2-5-flare',extra:{aspect_ratio:'16:9',quality:'high'},want:{size:'16:9',quality:'high'}},
  {model:'gpt-image-2.5-flare',extra:{size:'1536x1024',quality:'max',output_format:'webp',output_compression:80,background:'transparent'},want:{size:'1536x1024',resolution:'1k',quality:'max',output_format:'webp',output_compression:80,background:'transparent',moderation:'low'}},
  {model:'momoapi-gemini-nano-banana-3',extra:{resolution:'4k'},want:{aspect_ratio:'1:1',resolution:'4k'}},
  {model:'gpt-image-2',extra:{aspect_ratio:'16:9',resolution:'4k'},want:{size:'1536x1024',quality:'high'}},
 ];
 if(edit)profiles.push(
  {model:'momoapi-gpt-image-2-5-sunburst',extra:{aspect_ratio:'16:9',quality:'high'},want:{size:'16:9',quality:'high'}},
  {model:'momoapi-gpt-image-2-5-prism',extra:{aspect_ratio:'4:3',quality:'low'},want:{aspect_ratio:'4:3',quality:'low'}},
 );
 let count=0;
 for(const f of profiles)for(const shape of ['inline','url','task','401','429','500']){
  const status=/^\d/.test(shape)?Number(shape):200;
  const output=shape==='inline'?{data:[{b64_json:png}]}:shape==='url'?{data:[{url:'https://images.example/generated.png'}]}:{data:[{task_id:'task_shared',status:'submitted'}]};
  const reference='data:image/png;base64,'+png;
  const references=edit?[reference,...(f.model==='gpt-image-2'?[]:[reference])]:undefined;
  const web=f.model==='momoapi-gpt-image-2-5-flare'||f.model==='momoapi-gpt-image-2-5-sunburst';
  const catalog={models:[{id:f.model,modality:'image',available:true,operations:edit?['generate','edit']:['generate'],parameters:edit?{max_reference_images:{maximum:2}}:{}}]};
  const {child,handoff}=await launch({path:edit&&web?'/v1/images/edits':'/v1/images/generations',stream:JSON.stringify(output),upstreamJSON:true,status,image:true,imageCatalog:JSON.stringify(catalog)});let server;
  try{
   const env={MOMO_PROXY_HOME:'unused-image-routecheck',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
   const stored=[];const store={putBase64:async image=>{stored.push(image);return {asset_id:'img_'+ 'a'.repeat(64),reference:'asset:img_'+ 'a'.repeat(64),mime_type:'image/png'}},list:async()=>[]};
   server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},
    {env,loggingRuntime,assetStore:store,attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,'mock.example','no output download/auth to external URL');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));
   const nodeURL='http://127.0.0.1:'+server.address().port,goURL=handoff.base_url.replace(/\/v1$/,'');
   const capability=await localGET(goURL+'/internal/images/capabilities',{authorization:'Bearer '+handoff.api_key});assert.equal(capability.status,200);
   const cap=await capability.json();assert.equal(cap.models.length,1);assert.equal(cap.models[0].id,f.model);assert.deepEqual(cap.models[0].operations,edit?['generate','edit']:['generate']);
   const request={model:f.model,prompt:' 中文🙂 ',n:1,...f.extra,...(edit?{reference_images:references}:{})};
   const localPath=edit?'/internal/images/edit':'/internal/images/generate';
   const n=await invoke(nodeURL,'synthetic-node-only',request,localPath,{'x-local-token':'synthetic-node-only'});
   const g=await invoke(goURL,handoff.api_key,request,localPath);
   const nodeStatus=shape==='url'?502:status===500?502:status;assert.equal(n.status,nodeStatus,f.model+' '+shape+' Node '+n.body);assert.equal(g.status,status);
   const captures=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captures.length,2,'one generation send each, no fallback');
   const want={model:f.model,prompt:'中文🙂',n:1,...f.want,...(edit?{[web?'images':'image_urls']:references}:{})};assert.deepEqual(captures[0],want);assert.deepEqual(captures[1],want);
   if(status===200){
    const nr=JSON.parse(n.body),gr=JSON.parse(g.body);
    if(shape==='inline'){assert.equal(nr.images.length,1);assert.equal(gr.images.length,1);assert.equal(nr.images[0].asset_id,'img_'+ 'a'.repeat(64));assert.equal(nr.images[0].b64_json,undefined);assert.equal(stored[0].b64_json,png);assert.equal(gr.images[0].b64_json,png);assert.equal(gr.images[0].mime_type,'image/png');assert.equal(gr.terminal,true)}
    if(shape==='url'){assert.deepEqual(gr.images,[{url:'https://images.example/generated.png'}]);assert.equal(gr.terminal,true);assert.equal(stored.length,0);console.log('DIFFERENCE Node requires successful download before local persistence (fixture denies external access ->502); Go delegates URL without fetching/persistence')}
    if(shape==='task'){
     assert.equal(nr.task_id,'task_shared');assert.equal(gr.task_id,'task_shared');assert.equal(gr.raw_status,'submitted');assert.equal(gr.terminal,false);
     const nt=await localGET(nodeURL+'/internal/images/tasks/task_shared',{'x-local-token':'synthetic-node-only'}),gt=await localGET(goURL+'/internal/images/tasks/task_shared',{authorization:'Bearer '+handoff.api_key});assert.equal(nt.status,502);assert.equal(gt.status,200);
     const gp=await gt.json();assert.equal(gp.images[0].url,'https://images.example/generated.png');assert.equal(gp.terminal,true);assert.equal(stored.length,0);
     const paths=(await(await fetch(handoff.mock_url+'/capture')).json()).slice(2);assert.deepEqual(paths,[{task_path:'/v1/tasks/task_shared'},{task_path:'/v1/tasks/task_shared'}]);
    }
   }else{assert.ok(!g.body.includes('redacted synthetic failure'));assert.ok(!g.body.includes('b64_json'))}
   console.log('PASS shared image '+(edit?'edit':'generate')+' blackbox '+f.model+' '+shape+'; no live image/storage/MCP proof');count++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
 }
 return count;
}
