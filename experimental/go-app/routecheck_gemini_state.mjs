import assert from 'node:assert/strict';
import {createMomoSwitch} from '../../src/server.mjs';

const model='gemini-3.1-pro-preview',path='/v1beta/models/'+model+':streamGenerateContent';
const sig=Buffer.from('synthetic opaque provider state 中文').toString('base64');
const frame=parts=>'data: '+JSON.stringify({candidates:[{index:0,content:{role:'model',parts},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:5,totalTokenCount:8}})+'\r\n\r\n';
const call={functionCall:{id:'signed_call',name:'pad__read',args:{n:1}},thoughtSignature:sig};
const tools=[{type:'namespace',name:'pad',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{n:{type:'number'}}}}]}];

export async function geminiStateBlackbox(launch,invoke){
 let count=0;
 for(const nativeID of [true,false])for(const rich of [false,true])for(const stream of [false,true])for(const full of [false,true]){
  const nativeCall=structuredClone(call);if(!nativeID)delete nativeCall.functionCall.id;
  const parts=rich?[{text:'public summary\r\n',thought:true,thoughtSignature:sig},{text:'signed answer',thoughtSignature:sig},nativeCall,{text:'',thoughtSignature:sig}]:[nativeCall];
  const {child,handoff}=await launch({paths:[path,path,path,path],streams:[frame(parts),frame(parts),frame([{text:'finished'}]),frame([{text:'finished'}])]});let server;
  try{
   const env={MOMO_PROXY_HOME:'unused-gemini-state',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
   server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}}, {env,loggingRuntime,assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,'mock.example');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));const nodeURL='http://127.0.0.1:'+server.address().port,goURL=handoff.base_url.slice(0,-3);
   const initial={model,stream,input:[{role:'user',content:'first signed turn'}],tools,momo_gemini_thinking:{includeThoughts:true},reasoning_effort:'high'};
   const n=await invoke(nodeURL,'synthetic-node-only',initial),g=await invoke(goURL,handoff.api_key,initial);
   assert.equal(n.status,200);assert.equal(g.status,200);assert.ok(n.completed&&g.completed);
   assert.equal(g.output.length,rich?4:1);
   const signed=g.output.find(v=>v.type==='function_call');assert.equal(signed.namespace,'pad');assert.equal(signed.name,'read');assert.deepEqual(signed.momo_gemini,{model,thought_signature:sig,...(!nativeID?{call_id_absent:true}:{})});
   if(rich){
    assert.deepEqual(g.output[0],{type:'reasoning',summary:[{type:'summary_text',text:'public summary\r\n'}],momo_gemini:{model,thought_signature:sig}});
    assert.equal(g.output[1].content[0].text,'signed answer');assert.equal(g.output[3].content[0].text,'');
    const nodeAnswer=n.output.filter(v=>v.type==='message').flatMap(v=>v.content).map(v=>v.text).join('');
    assert.equal(nodeAnswer,'public summary\r\nsigned answer');assert.ok(!n.output.some(v=>v.type==='reasoning'));
    if(stream){assert.ok(g.events.some(v=>v.type==='response.reasoning_summary_text.delta'));assert.ok(!g.events.some(v=>v.type==='response.output_text.delta'&&v.delta.includes('public summary')))}
   }
   const results=[{type:'function_call_output',call_id:signed.call_id,output:'paired result'}];
   // Exactly the SAME canonical payload is given to both implementations.
   // Node retrieves the remembered signed call; Go's anchor holds the entire turn.
   const next={model,stream,tools,previous_response_id:g.completed.response.id,input:full?[...initial.input,...g.output,...results,{role:'user',content:'next'}]:results};
   // Without a native ID, each proxy generates an independent LOCAL call ID.
   // Match only that opaque ID for Node; no content/state/signature differences.
   const nodeNext=structuredClone(next);if(!nativeID){const nodeID=n.output.find(v=>v.type==='function_call').call_id;for(const item of nodeNext.input)if(item.call_id===signed.call_id)item.call_id=nodeID}
   const n2=await invoke(nodeURL,'synthetic-node-only',nodeNext),g2=await invoke(goURL,handoff.api_key,next);
   assert.equal(n2.status,200);assert.equal(g2.status,200);assert.ok(n2.completed&&g2.completed);
   const captures=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captures.length,4);
   assert.deepEqual(captures[0].generationConfig,{thinkingConfig:{thinkingLevel:'HIGH'}});
   assert.deepEqual(captures[1].generationConfig,{thinkingConfig:{thinkingLevel:'HIGH',includeThoughts:true}});
   assert.equal(captures[2].generationConfig,undefined,'Node controls not inherited');
   assert.equal(captures[3].generationConfig,undefined,'Go controls not inherited with signed full/suffix replay');
   assert.deepEqual(captures[0].contents,captures[1].contents);
   for(const [index,body] of captures.slice(2).entries()){
    const recalled=body.contents.flatMap(v=>v.parts).find(v=>v.functionCall);
    if(nativeID || index===1)assert.deepEqual(recalled,nativeCall,'signed Part including native ID presence exact');
    else{assert.equal(recalled.thoughtSignature,sig);assert.equal(recalled.functionCall.name,nativeCall.functionCall.name);assert.deepEqual(recalled.functionCall.args,nativeCall.functionCall.args);assert.equal(recalled.functionCall.id,full?undefined:n.output.find(v=>v.type==='function_call').call_id)}
    assert.ok(body.contents.flatMap(v=>v.parts).some(v=>v.functionResponse?.response.result==='paired result'));
   }
   assert.deepEqual(captures[3].contents[1].parts,parts,'Go full signed part order and empty text exact');
   if(rich){const nodeParts=captures[2].contents.flatMap(v=>v.parts);assert.ok(!nodeParts.some(v=>v.thought===true));assert.ok(!nodeParts.some(v=>v.text!==undefined&&v.thoughtSignature))}
   console.log('PASS uniform Gemini signed '+(nativeID?'native ID':'absent native ID/local IDs matched')+' '+(rich?'summary/text/call':'call')+' '+(stream?'SSE':'JSON')+' '+(full?'full':'suffix')+'; both preserve call signatures; Node suffix-only injects local ID into originally ID-less signed Part and thought-as-answer/text-state loss independently asserted');count++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))])}
 }
 return count;
}
