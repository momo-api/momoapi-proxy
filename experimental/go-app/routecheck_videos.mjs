import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {createMomoSwitch} from '../../src/server.mjs';

async function query(url,headers){
 return new Promise((resolve,reject)=>{const req=httpRequest(url,{headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.once('error',reject);res.once('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}))});req.setTimeout(10000,()=>req.destroy(Error('video query timeout')));req.once('error',reject);req.end()});
}

// Same actual TCP mock / resource controls / canonical requests. No real
// account, video generation, downloads, provider substitution or performance
// claim. Known stricter Go errors/status normalization independently asserted.
export async function videoBlackbox(launch,invoke){
 let count=0;
 for(const model of ['MiniMax-H3-Max','seedance-2.5'])for(const shape of ['queued','completed','failed','401','429','500']){
  const status=/^\d/.test(shape)?Number(shape):200;
  const output={task_id:'task_video_shared',status:shape==='completed'?'completed':shape==='failed'?'failed':'submitted',...(shape==='completed'?{url:'https://video.example/result.mp4'}:{}),...(shape==='failed'?{error:{message:'private upstream reason'}}:{})};
  const {child,handoff}=await launch({path:'/v1/video/generations',stream:JSON.stringify(output),upstreamJSON:true,status,video:true});let server;
  try{
   const env={MOMO_PROXY_HOME:'unused-video-routecheck',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
   server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},
    {env,loggingRuntime,assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,'mock.example','no video URL/reference download');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));
   const nodeURL='http://127.0.0.1:'+server.address().port,goURL=handoff.base_url.replace(/\/v1$/,'');
   const cap=await query(goURL+'/internal/videos/capabilities',{authorization:'Bearer '+handoff.api_key});assert.equal(cap.status,200);assert.deepEqual(JSON.parse(cap.body).models.map(p=>p.id),['MiniMax-H3-Max','seedance-2.5']);
   const request={model,prompt:' 中文🙂 ',duration:model==='MiniMax-H3-Max'?5:7,resolution:model==='MiniMax-H3-Max'?'480P':'720p',aspect_ratio:'adaptive',first_frame_image:'https://images.example/first.png',last_frame_image:'https://images.example/last.png'};
   const n=await invoke(nodeURL,'synthetic-node-only',request,'/internal/videos/generate',{'x-local-token':'synthetic-node-only'}),g=await invoke(goURL,handoff.api_key,request,'/internal/videos/generate');
   assert.equal(n.status,status);assert.equal(g.status,status);
   const captures=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captures.length,2,'one submission each, no retry');
   const want={...request,prompt:'中文🙂'};assert.deepEqual(captures[0],want);assert.deepEqual(captures[1],want);
   if(status===200){
    const nr=JSON.parse(n.body),gr=JSON.parse(g.body);assert.equal(nr.task_id,gr.task_id);assert.equal(gr.task_id,'task_video_shared');
    assert.equal(gr.status,shape==='queued'?'queued':shape);assert.equal(gr.terminal,shape!=='queued');
    assert.equal(nr.status,shape==='queued'?'submitted':shape);assert.equal(nr.terminal,gr.terminal);
    assert.equal(gr.remote_url,shape==='completed'?'https://video.example/result.mp4':undefined);assert.ok(!g.body.includes('private upstream reason'));assert.equal(gr.authenticated_content_url,undefined);
    if(shape==='queued'){
     const nt=await query(nodeURL+'/internal/videos/tasks/task_video_shared',{'x-local-token':'synthetic-node-only'}),gt=await query(goURL+'/internal/videos/tasks/task_video_shared',{authorization:'Bearer '+handoff.api_key});assert.equal(nt.status,200);assert.equal(gt.status,200);
     const np=JSON.parse(nt.body),gp=JSON.parse(gt.body);assert.equal(np.status,'completed');assert.equal(gp.status,'completed');assert.equal(np.remote_url,gp.remote_url);assert.equal(gp.remote_url,'https://video.example/result.mp4');assert.equal(gp.terminal,true);
     assert.deepEqual((await(await fetch(handoff.mock_url+'/capture')).json()).slice(2),[{task_path:'/v1/videos/task_video_shared'},{task_path:'/v1/videos/task_video_shared'}]);
    }
   }else{assert.ok(!g.body.includes('redacted synthetic failure'));assert.ok(!g.body.includes('private upstream reason'))}
   console.log('PASS shared video blackbox '+model+' '+shape+'; Go normalizes submitted->queued, redacts task errors and omits authenticated content URLs; no full media/live proof');count++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
 }
 return count;
}
