import assert from 'node:assert/strict';
import {createMomoSwitch} from '../../src/server.mjs';
const schema={type:'object',properties:{n:{type:['integer','null'],minimum:0},s:{type:['string','null'],minLength:1,maxLength:2}},required:['n','s'],additionalProperties:false};
const frame=o=>'data: '+JSON.stringify(o)+'\n\n';
const cf=(type,fields={})=>frame({type,...fields});
const specs=[
 {model:'gpt-5.5',path:'/v1/chat/completions',fixture:args=>frame({choices:[{index:0,delta:{tool_calls:[{index:0,id:'strict_shared',type:'function',function:{name:'pad__read',arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n'},
 {model:'claude-sonnet-4-6',path:'/v1/messages',fixture:args=>cf('message_start',{message:{id:'strict_msg',type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],usage:{input_tokens:3,output_tokens:1}}})+cf('content_block_start',{index:0,content_block:{type:'tool_use',id:'strict_shared',name:'pad__read',input:{}}})+cf('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}})+cf('content_block_stop',{index:0})+cf('message_delta',{delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:5}})+cf('message_stop')},
 {model:'gemini-2.5-flash',path:'/v1beta/models/gemini-2.5-flash:streamGenerateContent',fixture:args=>frame({candidates:[{index:0,content:{role:'model',parts:[{functionCall:{id:'strict_shared',name:'pad__read',args}}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:5,totalTokenCount:8}})},
];
export async function ordinaryStrictBlackbox(launch,invoke){
 let cases=0;
 for(const spec of specs)for(const stream of [true,false])for(const strict of [true,false])for(const valid of [true,false]){
  const args=valid?{n:null,s:'中🙂'}:{n:-1,s:'abc'};
  const {child,handoff}=await launch({path:spec.path,stream:spec.fixture(args)});let server;
  try{
   const env={MOMO_PROXY_HOME:'unused-ordinary-strict-profile',MOMO_PROXY_CONSOLE_MIRROR:'0'};
   server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},{env,loggingRuntime:{env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})},assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);assert.equal(u.hostname,'mock.example');return fetch(handoff.mock_url+u.pathname+u.search,init)}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));
   const p={model:spec.model,stream,input:[{role:'user',content:'strict-shared-turn'}],tools:[{type:'namespace',name:'pad',tools:[{type:'function',name:'read',strict,parameters:schema}]}]};
   const n=await invoke('http://127.0.0.1:'+server.address().port,'synthetic-node-only',p),g=await invoke(handoff.base_url.slice(0,-3),handoff.api_key,p);
   assert.equal(n.status,200);assert.ok(n.completed);assert.equal(n.output.length,1);
   const captures=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captures.length,2,'one send each, no retry');
   const [nw,gw]=captures;
   let nd,gd,ns,gs;
   if(spec.model==='gpt-5.5'){nd=nw.tools[0].function;gd=gw.tools[0].function;ns=nd.parameters;gs=gd.parameters;assert.equal(gd.strict,strict);assert.equal(nd.strict,undefined)}
   else if(spec.model.startsWith('claude')){nd=nw.tools[0];gd=gw.tools[0];ns=nd.input_schema;gs=gd.input_schema;assert.equal(gd.strict,undefined);assert.equal(nd.strict,undefined)}
   else{nd=nw.tools[0].functionDeclarations[0];gd=gw.tools[0].functionDeclarations[0];ns=nd.parameters;gs=gd.parametersJsonSchema;assert.equal(gd.strict,undefined);assert.equal(nd.strict,undefined)}
   assert.equal(gd.name,'pad__read');assert.equal(nd.name,'pad__read');assert.deepEqual(gs,schema);assert.deepEqual(ns,schema);
   if(valid||!strict){
    assert.equal(g.status,200);assert.ok(g.completed);assert.equal(g.output.length,1);assert.equal(g.output[0].name,'read');assert.equal(g.output[0].namespace,'pad');assert.deepEqual(JSON.parse(g.output[0].arguments),args);assert.deepEqual(JSON.parse(n.output[0].arguments),args);
    assert.equal(n.output[0].namespace,undefined);const normalized=structuredClone(n.output);normalized[0].namespace='pad';normalized[0].arguments=g.output[0].arguments;assert.deepEqual(g.output,normalized);
   }else{assert.equal(g.completed,undefined);assert.equal(g.incomplete,undefined);if(stream)assert.ok(g.truncated);else assert.equal(g.status,502)}
   console.log('PASS shared ordinary strict '+spec.model+' '+(stream?'SSE':'JSON')+' strict='+strict+' valid='+valid+'; identical mock/resources/input, schema and explicit Chat bool independently asserted, local Go rejection vs Node acceptance; not provider constrained-generation guarantee');cases++;
  }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
 }return cases;
}
