// Uniform semantic blackbox: real TCP requests to Node and Go, same mock
// upstream per case, same workload/concurrency and matched configurable budgets.
// Test-only binary; no profiles, credentials, production or benchmark claims.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {createMomoSwitch} from '../../src/server.mjs';
const binary=process.argv[2];assert.ok(binary);
const tool={type:'namespace',name:'pad',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{}}},{type:'custom',name:'write'}]};
const payload={model:'gpt-5.5',stream:true,instructions:'Be concise.',input:[{role:'user',content:[{type:'input_text',text:'中文🙂'}]}],tools:[tool]};
const chunk=(delta,finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
const sse=chunks=>chunks.map(c=>'data: '+JSON.stringify(c)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n';
const text=sse([chunk({content:'中文'}),chunk({content:'🙂'},'stop')]);
const calls=sse([
 chunk({tool_calls:[{index:0,id:'call_read',type:'function',function:{name:'pad__read',arguments:'{"x":'}}]}),
 chunk({tool_calls:[{index:0,function:{arguments:'1}'}},{index:1,id:'call_write',type:'function',function:{name:'pad__write',arguments:'{"input":"text(\'hi\')"}'}}]}),
 chunk({},'tool_calls')]);
const bare=sse([chunk({tool_calls:[{index:0,id:'call_read',type:'function',function:{name:'read',arguments:'{}'}}]},'tool_calls')]);
const cf=(type,fields={})=>'event: '+type+'\r\ndata: '+JSON.stringify({type,...fields})+'\r\n\r\n';
const cs=cf('message_start',{message:{id:'msg_mock',type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:1}}});
const ce=reason=>cf('message_delta',{delta:{stop_reason:reason,stop_sequence:null},usage:{output_tokens:5}})+cf('message_stop');
const ct=(index,text)=>cf('content_block_start',{index,content_block:{type:'text',text:''}})+cf('content_block_delta',{index,delta:{type:'text_delta',text}})+cf('content_block_stop',{index});
const ctool=(index,id,name,partial_json)=>cf('content_block_start',{index,content_block:{type:'tool_use',id,name,input:{}}})+cf('content_block_delta',{index,delta:{type:'input_json_delta',partial_json}})+cf('content_block_stop',{index});
const claudeText=cs+ct(0,'中文🙂')+ce('end_turn');
const claudeCalls=cs+ctool(0,'call_read','pad__read','{"x":1}')+ctool(1,'call_write','pad__write',JSON.stringify({input:"text('hi')"}))+ce('tool_use');
const cp={...payload,model:'claude-sonnet-4-6'};
const gp={...payload,model:'gemini-2.5-flash'};
const imageURL='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const imageInput=[{type:'input_text',text:'before-image'},{type:'input_image',image_url:imageURL},{type:'input_text',text:'after-image'},{type:'input_image',image_url:'https://images.example.invalid/a',mime_type:'image/jpeg'}];
const gpath='/v1beta/models/gemini-2.5-flash:streamGenerateContent';
const gu={promptTokenCount:3,candidatesTokenCount:5,totalTokenCount:10,cachedContentTokenCount:2,thoughtsTokenCount:2};
const gf=(parts,finishReason,usageMetadata)=>'data: '+JSON.stringify({...((parts||finishReason)?{candidates:[{index:0,...(parts?{content:{role:'model',parts}}:{}),...(finishReason?{finishReason}:{})}]}:{}),...(usageMetadata?{usageMetadata}:{})})+'\r\n\r\n';
const gt=gf([{text:'中文🙂'}])+gf(null,'STOP',gu);
const gc=gf([{functionCall:{id:'call_read',name:'pad__read',args:{x:1}}},{functionCall:{id:'call_write',name:'pad__write',args:{input:"text('hi')"}}}])+gf(null,'STOP',gu);
const chatUsage={prompt_tokens:3,completion_tokens:5,total_tokens:8,prompt_tokens_details:{cached_tokens:2},completion_tokens_details:{reasoning_tokens:1}};
const cu=u=>'data: '+JSON.stringify({choices:[],usage:u})+'\r\n\r\n';
const withChatUsage=(stream,usage)=>stream.replace('data: [DONE]\r\n\r\n',cu(usage)+'data: [DONE]\r\n\r\n');
const chatSingle=name=>sse([chunk({tool_calls:[{index:0,id:'call_one',type:'function',function:{name:'pad__'+name,arguments:name==='read'?'{}':JSON.stringify({input:'hi'})}}]},'tool_calls')]);
const claudeSingle=name=>cs+ctool(0,'call_one','pad__'+name,name==='read'?'{}':JSON.stringify({input:'hi'}))+ce('tool_use');
const geminiSingle=name=>gf([{functionCall:{id:'call_one',name:'pad__'+name,args:name==='read'?{}:{input:'hi'}}}])+gf(null,'STOP',gu);
const claudeOrdered=cs+ct(0,'before-tool')+ctool(1,'call_read','pad__read','{}')+ct(2,'after-tool')+ctool(3,'call_write','pad__write',JSON.stringify({input:"text('hi')"}))+ce('tool_use');
const geminiOrdered=gf([{text:'before-tool'},{functionCall:{id:'call_read',name:'pad__read',args:{}}},{text:'after-tool'},{functionCall:{id:'call_write',name:'pad__write',args:{input:"text('hi')"}}}])+gf(null,'STOP',gu);
const allowedChoice=(mode,name,kind='function')=>({type:'allowed_tools',mode,tools:[{type:kind,name,namespace:'pad'}]});
const clientToolSamples=[
 {name:'exec',raw:' \r\nawait tools.exec_command({cmd: '+String.fromCharCode(96)+'echo $'+'{x} $(whoami) 中文🙂'+String.fromCharCode(96)+'});\r\n ',node:'await tools.exec_command({cmd: '+String.fromCharCode(96)+'echo $'+'{x} $(whoami) 中文🙂'+String.fromCharCode(96)+'});'},
 {name:'exec',raw:'git status',node:'await tools.exec_command({ cmd: "git status" });'},
 {name:'apply_patch',raw:'*** Begin Patch\r\n*** Add File: example.txt\r\n+中文🙂\r\n*** End Patch\r\n',node:'*** Begin Patch\r\n*** Add File: example.txt\r\n+中文🙂\r\n*** End Patch'},
];
const searchTool={type:'tool_search',execution:'client',description:'client discovery',parameters:{type:'object',properties:{goal:{type:'string'}},required:['goal'],additionalProperties:false}};
const deferredTool={type:'namespace',name:'pad',tools:[{type:'function',name:'read',defer_loading:true,parameters:{type:'object',properties:{}}}]};
const searchHistory=[{type:'tool_search_call',execution:'client',call_id:'search_history',arguments:{goal:'read'}},{type:'tool_search_output',execution:'client',call_id:'search_history',status:'completed',tools:[deferredTool]}];
const searchCalls={Chat:args=>sse([chunk({tool_calls:[{index:0,id:'search_call',type:'function',function:{name:'tool_search',arguments:JSON.stringify(args)}}]},'tool_calls')]),Claude:args=>cs+ctool(0,'search_call','tool_search',JSON.stringify(args))+ce('tool_use'),Gemini:args=>gf([{functionCall:{id:'search_call',name:'tool_search',args}}],'STOP',gu)};
const cases=[
 ...[{label:'Chat',payload,path:undefined,single:chatSingle},{label:'Claude',payload:cp,path:'/v1/messages',single:claudeSingle},{label:'Gemini',payload:gp,path:gpath,single:geminiSingle}].flatMap(f=>[true,false].flatMap(stream=>[
  {name:f.label+' client search object '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tools:[searchTool,deferredTool],momo_tool_loading:'client-search',parallel_tool_calls:false},path:f.path,stream:searchCalls[f.label]({goal:'read 中文🙂'}),search:true,json:!stream},
  {name:f.label+' client search schema rejection '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tools:[searchTool,deferredTool],momo_tool_loading:'client-search',parallel_tool_calls:false},path:f.path,stream:searchCalls[f.label]({goal:17}),search:true,json:!stream,searchReject:true},
  {name:f.label+' client search loaded deferred '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tools:[searchTool,deferredTool],momo_tool_loading:'client-search',parallel_tool_calls:false,input:[...f.payload.input,...searchHistory]},path:f.path,stream:f.single('read'),search:true,loaded:true,json:!stream},
  {name:f.label+' client search empty result '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tools:[searchTool,deferredTool],momo_tool_loading:'client-search',parallel_tool_calls:false,input:[...f.payload.input,...searchHistory.map(v=>v.type==='tool_search_output'?{...v,tools:[]}:v)]},path:f.path,stream:searchCalls[f.label]({goal:'again'}),search:true,emptySearch:true,json:!stream},
 ])),
 {name:'text Unicode fragmented',stream:text,payload},
 {name:'function custom namespace fragmented',stream:calls,payload},
 {name:'history function/output',stream:text,payload:{...payload,tools:tool.tools,input:[...payload.input,{type:'function_call',call_id:'history_read',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'history_read',output:'done'},{role:'user',content:'continue'}]}},
 {name:'history assistant plus parallel calls',stream:text,payload:{...payload,tools:tool.tools,input:[...payload.input,{role:'assistant',content:'checking'},{type:'function_call',call_id:'a',name:'read',arguments:'{}'},{type:'custom_tool_call',call_id:'b',name:'write',input:"text('hello')"},{type:'custom_tool_call_output',call_id:'b',output:'written'},{type:'function_call_output',call_id:'a',output:'read'},{role:'user',content:'continue'}]}},
 {name:'Qwen system consolidation',stream:text,payload:{...payload,model:'qwen-test',input:[...payload.input,{role:'developer',content:'later instruction'}]}},
 {name:'four concurrent same-resource requests',stream:text,payload,concurrent:4},
 {name:'namespace absent from upstream delta',stream:bare,payload},
 ...[401,429,500].map(status=>({name:'upstream '+status,stream:'',status,payload})),
 {name:'truncated EOF safety difference',stream:'data: '+JSON.stringify(chunk({content:'partial'}))+'\n\n',payload,truncate:true},
 {name:'Claude Unicode fragmented',stream:claudeText,payload:cp,path:'/v1/messages'},
 {name:'Claude function/custom namespace',stream:claudeCalls,payload:cp,path:'/v1/messages'},
 {name:'Claude paired parallel history',stream:claudeText,payload:{...cp,input:[...cp.input,{role:'assistant',content:'checking'},{type:'function_call',call_id:'a',namespace:'pad',name:'read',arguments:'{}'},{type:'custom_tool_call',call_id:'b',namespace:'pad',name:'write',input:'hello'},{type:'function_call_output',call_id:'a',output:'read'},{type:'custom_tool_call_output',call_id:'b',output:'written'},{role:'user',content:'continue'}]},path:'/v1/messages',historyDifference:true},
 {name:'Claude four concurrent same-resource',stream:claudeText,payload:cp,path:'/v1/messages',concurrent:4},
 ...[401,429,500].map(status=>({name:'Claude upstream '+status,stream:'',status,payload:cp,path:'/v1/messages'})),
 {name:'Claude truncated EOF safety difference',stream:cs+ct(0,'partial'),payload:cp,path:'/v1/messages',truncate:true},
 {name:'Claude system/tool choice preservation',stream:claudeText,payload:{...cp,tool_choice:'required',input:[{role:'developer',content:'rules'},...cp.input]},path:'/v1/messages',systemDifference:true,reject:true},
 {name:'Gemini Unicode fragmented',stream:gt,payload:gp,path:gpath},
 {name:'Gemini function/custom namespace',stream:gc,payload:gp,path:gpath},
 {name:'Gemini paired function history',stream:gt,payload:{...gp,input:[...gp.input,{role:'assistant',content:'checking'},{type:'function_call',call_id:'a',namespace:'pad',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'a',output:'read'},{role:'user',content:'continue'}]},path:gpath,geminiHistory:true},
 {name:'Gemini four concurrent same-resource',stream:gt,payload:gp,path:gpath,concurrent:4},
 ...[401,429,500].map(status=>({name:'Gemini upstream '+status,stream:'',status,payload:gp,path:gpath})),
 {name:'Gemini premature EOF safety difference',stream:gf([{text:'partial'}]),payload:gp,path:gpath,truncate:true},
 {name:'Gemini system/tool choice',stream:gt,payload:{...gp,tool_choice:'required',input:[{role:'developer',content:'rules'},...gp.input]},path:gpath,reject:true},
 {name:'Gemini usage-only trailer',stream:gf([{text:'中文🙂'}],'STOP')+gf(null,null,gu),payload:gp,path:gpath},
 ...[{label:'Chat',payload,stream:text,calls,path:undefined,partial:'data: '+JSON.stringify(chunk({content:'partial'}))+'\n\n'},
     {label:'Claude',payload:cp,stream:claudeText,calls:claudeCalls,path:'/v1/messages',partial:cs+ct(0,'partial')},
     {label:'Gemini',payload:gp,stream:gt,calls:gc,path:gpath,partial:gf([{text:'partial'}])}].flatMap(f=>[
  {name:f.label+' JSON text',stream:f.stream,payload:{...f.payload,stream:false},path:f.path,json:true},
  {name:f.label+' JSON namespace tools',stream:f.calls,payload:{...f.payload,stream:false},path:f.path,json:true},
  {name:f.label+' omitted stream returns JSON',stream:f.stream,payload:Object.fromEntries(Object.entries(f.payload).filter(([k])=>k!=='stream')),path:f.path,json:true},
  {name:f.label+' JSON truncated upstream',stream:f.partial,payload:{...f.payload,stream:false},path:f.path,json:true,truncate:true},
  {name:f.label+' JSON upstream 429',stream:'',status:429,payload:{...f.payload,stream:false},path:f.path,json:true},
 ]),
 ...[true,false].flatMap(stream=>[
  {name:'Chat usage '+(stream?'SSE':'JSON'),payload:{...payload,stream},stream:withChatUsage(text,chatUsage),json:!stream,chatUsage},
  {name:'Chat invalid usage '+(stream?'SSE':'JSON'),payload:{...payload,stream},stream:withChatUsage(text,{...chatUsage,total_tokens:9}),json:!stream,reject:true},
  {name:'Chat decreasing usage '+(stream?'SSE':'JSON'),payload:{...payload,stream},stream:withChatUsage(text,chatUsage).replace('data: [DONE]\r\n\r\n',cu({...chatUsage,completion_tokens:4,total_tokens:7})+'data: [DONE]\r\n\r\n'),json:!stream,reject:true},
  {name:'Chat usage missing DONE '+(stream?'SSE':'JSON'),payload:{...payload,stream},stream:withChatUsage(text,chatUsage).replace('data: [DONE]\r\n\r\n',''),json:!stream,reject:true},
 ]),
 ...[{label:'Chat',payload,path:undefined,single:chatSingle}, {label:'Claude',payload:cp,path:'/v1/messages',single:claudeSingle},{label:'Gemini',payload:gp,path:gpath,single:geminiSingle}].flatMap(f=>[true,false].flatMap(stream=>[
  ...[{kind:'function',name:'read'},{kind:'custom',name:'write'}].map(s=>({name:f.label+' named '+s.kind+' '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tool_choice:{type:s.kind,name:s.name,namespace:'pad'}},path:f.path,stream:f.single(s.name),json:!stream,selected:'pad__'+s.name,singleNamespace:true})),
  {name:f.label+' none rejects call '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tool_choice:'none'},path:f.path,stream:f.single('read'),json:!stream,reject:true},
  {name:f.label+' named rejects wrong call '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tool_choice:{type:'function',name:'read',namespace:'pad'}},path:f.path,stream:f.single('write'),json:!stream,selected:'pad__read',reject:true},
 ])),
 ...[{label:'Chat',payload,path:undefined,text,calls},{label:'Claude',payload:cp,path:'/v1/messages',text:claudeText,calls:claudeCalls},{label:'Gemini',payload:gp,path:gpath,text:gt,calls:gc}].flatMap(f=>[true,false].flatMap(stream=>[
  {name:f.label+' text continuation '+(stream?'SSE':'JSON'),payload:{...f.payload,stream},path:f.path,stream:f.text,json:!stream,continuation:true},
  {name:f.label+' tools continuation '+(stream?'SSE':'JSON'),payload:{...f.payload,stream},path:f.path,stream:f.calls,json:!stream,continuation:true},
 ])),
 ...[{label:'Claude',payload:cp,path:'/v1/messages',stream:claudeOrdered},{label:'Gemini',payload:gp,path:gpath,stream:geminiOrdered}].flatMap(f=>[true,false].map(stream=>({name:f.label+' ordered block continuation '+(stream?'SSE':'JSON'),payload:{...f.payload,stream},path:f.path,stream:f.stream,json:!stream,continuation:true,ordered:true}))),
 ...[{label:'Chat',payload,path:undefined,stream:bare},{label:'Claude',payload:cp,path:'/v1/messages',stream:claudeSingle('read').replaceAll('pad__read','read')},{label:'Gemini',payload:gp,path:gpath,stream:geminiSingle('read').replaceAll('pad__read','read')}].flatMap(f=>[true,false].map(stream=>({name:f.label+' ambiguous bare output '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tools:[{type:'function',name:'read',parameters:{type:'object',properties:{}}},{type:'namespace',name:'pad',tools:[{type:'function',name:'read',parameters:{type:'object',properties:{}}}]}]},path:f.path,stream:f.stream,json:!stream,reject:true}))),
 ...[{label:'Chat',payload,path:undefined,text,limited:sse([chunk({content:'partial-limit'},'length')])},{label:'Claude',payload:cp,path:'/v1/messages',text:claudeText,limited:cs+ct(0,'partial-limit')+ce('max_tokens')},{label:'Gemini',payload:gp,path:gpath,text:gt,limited:gf([{text:'partial-limit'}],'MAX_TOKENS',gu)}].flatMap(f=>[true,false].flatMap(stream=>[
  {name:f.label+' explicit output limit '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,max_output_tokens:17},path:f.path,stream:f.text,json:!stream,limit:17},
  {name:f.label+' output limit incomplete '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,max_output_tokens:17},path:f.path,stream:f.limited,json:!stream,limit:17,incomplete:true},
 ])),
 ...[{label:'Chat',payload,path:undefined,single:chatSingle,text},{label:'Claude',payload:cp,path:'/v1/messages',single:claudeSingle,text:claudeText},{label:'Gemini',payload:gp,path:gpath,single:geminiSingle,text:gt}].flatMap(f=>[true,false].flatMap(stream=>[
  {name:f.label+' allowed function '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tool_choice:allowedChoice('required','read')},path:f.path,stream:f.single('read'),json:!stream,allowed:'pad__read',singleNamespace:true},
  {name:f.label+' allowed custom '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tool_choice:allowedChoice('required','write','custom')},path:f.path,stream:f.single('write'),json:!stream,allowed:'pad__write',singleNamespace:true,allowedCustom:true},
  {name:f.label+' allowed auto text '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tool_choice:allowedChoice('auto','read')},path:f.path,stream:f.text,json:!stream,allowed:'pad__read'},
  {name:f.label+' allowed required rejects text '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tool_choice:allowedChoice('required','read')},path:f.path,stream:f.text,json:!stream,allowed:'pad__read',reject:true},
  {name:f.label+' allowed rejects excluded call '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,tool_choice:allowedChoice('auto','read')},path:f.path,stream:f.single('write'),json:!stream,allowed:'pad__read',reject:true},
 ])),
 ...[{label:'Chat',payload,path:undefined},{label:'Claude',payload:cp,path:'/v1/messages'},{label:'Gemini',payload:gp,path:gpath}].flatMap(f=>[true,false].flatMap(stream=>clientToolSamples.map(sample=>({
  name:f.label+' custom client '+sample.name+' '+sample.raw.length+' '+(stream?'SSE':'JSON'),
  payload:{...f.payload,stream,tools:[{type:'namespace',name:'pad',tools:[{type:'custom',name:sample.name,format:{type:'text'}}]}]},path:f.path,json:!stream,clientTool:sample,
  stream:!f.path?sse([chunk({tool_calls:[{index:0,id:'call_client',type:'function',function:{name:'pad__'+sample.name,arguments:JSON.stringify({input:sample.raw})}}]},'tool_calls')]):f.path==='/v1/messages'?cs+ctool(0,'call_client','pad__'+sample.name,JSON.stringify({input:sample.raw}))+ce('tool_use'):gf([{functionCall:{id:'call_client',name:'pad__'+sample.name,args:{input:sample.raw}}}])+gf(null,'STOP',gu),
 })))),
];
cases.push(...[{label:'Chat',payload,path:undefined,text},{label:'Claude',payload:cp,path:'/v1/messages',text:claudeText},{label:'Gemini',payload:gp,path:gpath,text:gt}].flatMap(f=>[true,false].flatMap(stream=>[false,true].map(urlOnly=>({name:f.label+' ordered images '+(urlOnly?'URL':'inline and URL')+' '+(stream?'SSE':'JSON'),payload:{...f.payload,stream,input:[{role:'user',content:urlOnly?[imageInput[3]]:imageInput}]},path:f.path,stream:f.text,json:!stream,images:true,urlOnly,continuation:true})))));
const toolImageFixtures=[{label:'Chat',model:'gpt-5.5',path:undefined,text,policy:'user-projection'},{label:'Claude',model:'claude-sonnet-4-6',path:'/v1/messages',text:claudeText},{label:'Gemini projection',model:'gemini-2.5-flash',path:gpath,text:gt,policy:'user-projection'},{label:'Gemini native',model:'gemini-3.1-flash',path:'/v1beta/models/gemini-3.1-flash:streamGenerateContent',text:gt}];
cases.push(...toolImageFixtures.flatMap(f=>[true,false].flatMap(stream=>['function','custom'].map(kind=>({
 name:f.label+' paired '+kind+' image result '+(stream?'SSE':'JSON'),path:f.path,stream:f.text,json:!stream,toolImages:true,kind,policy:f.policy,
 payload:{model:f.model,stream,...(f.policy?{momo_tool_images:f.policy}:{}),tools:[kind==='function'?{type:'function',name:'read',parameters:{type:'object',properties:{}}}:{type:'custom',name:'write'}],input:[{role:'user',content:'inspect'},kind==='function'?{type:'function_call',name:'read',call_id:'image_call',arguments:'{}'}:{type:'custom_tool_call',name:'write',call_id:'image_call',input:'raw'}, {type:kind==='function'?'function_call_output':'custom_tool_call_output',call_id:'image_call',output:imageInput.slice(0,3)},{role:'user',content:'CURRENT'}]}
})))));
async function launch(fixture){
 const child=spawn(binary,[],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let stderr='';child.stderr.on('data',b=>{stderr+=b});
 const handoff=await new Promise((resolve,reject)=>{
  let line='';const timer=setTimeout(()=>reject(Error('routecheck startup timeout')),10000);
  child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('routecheck exited before handoff'))});
  child.stdout.on('data',b=>{line+=b;if(line.includes('\n')){clearTimeout(timer);resolve(JSON.parse(line.split('\n')[0]))}});
  child.stdin.end(JSON.stringify({Stream:fixture.stream,Status:fixture.status||200,Path:fixture.path,Search:fixture.search,JSON:fixture.upstreamJSON}));
 });
 return {child,handoff};
}
function items(body){
 try{const response=JSON.parse(body);if(response.object==='response'&&['completed','incomplete'].includes(response.status))return {events:[],[response.status]:{response},json:true,output:response.output.map(({id,status,...item})=>item)}}catch{}
 const events=body.split(/\r?\n\r?\n/).flatMap(block=>{const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!data||data==='[DONE]')return [];try{return [JSON.parse(data)]}catch{return []}});
 const completed=events.find(e=>e.type==='response.completed');
 const incomplete=events.find(e=>e.type==='response.incomplete');
 return {events,completed,incomplete,output:(completed||incomplete)?.response?.output?.map(({id,status,...item})=>item)||[]};
}
async function invoke(url,token,p,path='/v1/responses',extraHeaders={}){
 return new Promise((resolve,reject)=>{
  const data=JSON.stringify(p);
  const req=httpRequest(url+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','content-length':Buffer.byteLength(data),...extraHeaders}},response=>{
   const chunks=[];let settled=false;
   const finish=truncated=>{if(settled)return;settled=true;const body=Buffer.concat(chunks).toString('utf8');resolve({status:response.statusCode,body,truncated,...items(body)})};
   response.on('data',b=>chunks.push(b));response.once('end',()=>finish(false));response.once('error',()=>finish(true));response.once('aborted',()=>finish(true));
  });req.setTimeout(10000,()=>req.destroy(Error('request timeout')));req.once('error',reject);req.end(data);
 });
}
for(const fixture of cases){
 const {child,handoff}=await launch(fixture);
 let server;
 try{
  const env={MOMO_PROXY_HOME:'unused-routecheck-profile',MOMO_PROXY_CONSOLE_MIRROR:'0'};
  const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
  server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,
   requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},
   {env,loggingRuntime,assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);return fetch(handoff.mock_url+u.pathname+u.search,init)}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const nodeURL='http://127.0.0.1:'+server.address().port;
  const goURL=handoff.base_url.replace(/\/v1$/,'');
  const count=fixture.concurrent||1;
  const nodeResults=await Promise.all(Array.from({length:count},()=>invoke(nodeURL,'synthetic-node-only',fixture.payload)));
  const goResults=await Promise.all(Array.from({length:count},()=>invoke(goURL,handoff.api_key,fixture.payload)));
  const captures=await(await fetch(handoff.mock_url+'/capture')).json();
  assert.equal(captures.length,count*2,fixture.name+' no duplicate fallback');
  // Independently assert the actual Go wire before normalizing this one known
  // Node difference for the remaining payload comparisons. No constraints drop.
  if(fixture.path?.includes(':streamGenerateContent')){
   for(const g of captures.slice(count))for(const d of g.tools?.[0]?.functionDeclarations||[]){
    assert.equal(d.parameters,undefined);assert.ok(d.parametersJsonSchema&&typeof d.parametersJsonSchema==='object');
    const namespaced=fixture.payload.tools?.flatMap(t=>t.type==='namespace'?t.tools.map(v=>({...v,wire:t.name+'__'+v.name})): [{...t,wire:t.name}])||[];
    const declared=namespaced.find(t=>t.wire===d.name);
    if(declared&&declared.type==='function')assert.deepEqual(d.parametersJsonSchema,declared.parameters||{type:'object',properties:{}});
    if(declared&&declared.type==='custom')assert.deepEqual(d.parametersJsonSchema,{type:'object',properties:{input:{type:'string',description:'Raw freeform input for this tool.'}},required:['input'],additionalProperties:false});
    if(d.name==='momo__client_tool_search')assert.deepEqual(d.parametersJsonSchema,searchTool.parameters);
    d.parameters=d.parametersJsonSchema;delete d.parametersJsonSchema;
   }
   console.log('DIFFERENCE Go Gemini uses parametersJsonSchema and preserves constraints; Node uses restricted parameters for JSON Schema');
  }
  if(fixture.search){
   const [n,g]=captures;
   const declarations=b=>!fixture.path?b.tools.map(t=>t.function):fixture.path==='/v1/messages'?b.tools:b.tools[0].functionDeclarations;
   const nt=declarations(n),gt=declarations(g);
   assert.deepEqual(nt.map(t=>t.name),['pad__read']);
   assert.deepEqual(gt.map(t=>t.name),fixture.loaded?['momo__client_tool_search','pad__read']:['momo__client_tool_search']);
   const schema=fixture.path==='/v1/messages'?'input_schema':'parameters';
   assert.deepEqual(gt[0][schema],searchTool.parameters);assert.deepEqual(nt[0][schema],deferredTool.tools[0].parameters);
   if(fixture.loaded){assert.deepEqual(gt[1][schema],nt[0][schema]);assert.equal(goResults[0].output[0].namespace,'pad');assert.equal(goResults[0].output[0].name,'read');assert.equal(goResults[0].output[0].type,'function_call')}
   if(!fixture.path)assert.equal(g.parallel_tool_calls,false);
   if(fixture.path==='/v1/messages')assert.equal(g.tool_choice.disable_parallel_tool_use,true);
   if(fixture.loaded||fixture.emptySearch){assert.ok(JSON.stringify(g).includes('search_history'));assert.ok(JSON.stringify(g).includes('momo__client_tool_search'))}
   assert.ok(nodeResults[0].completed);
   if(fixture.searchReject){assert.equal(goResults[0].completed,undefined);assert.equal(goResults[0].json,undefined);if(fixture.json)assert.equal(goResults[0].status,502);else assert.equal(goResults[0].truncated,true)}
   else{
    assert.ok(goResults[0].completed);assert.equal(goResults[0].json,fixture.json?true:undefined);
    if(!fixture.loaded){const result=goResults[0];assert.equal(result.output.length,1);assert.equal(result.output[0].type,'tool_search_call');assert.equal(result.output[0].execution,'client');assert.equal(result.output[0].call_id,'search_call');assert.deepEqual(result.output[0].arguments,{goal:fixture.emptySearch?'again':'read 中文🙂'});assert.equal(nodeResults[0].output[0].type,'function_call');assert.equal(nodeResults[0].output[0].name,'tool_search')}
   }
   console.log('DIFFERENCE Go explicit ordered client-search hides unloaded schemas and validates arguments; Node converted routes omit search declaration, expose deferred definition, and emit ordinary function call. No native prompt layout or tool execution claim');
   console.log('PASS uniform blackbox '+fixture.name);
   continue;
  }
  if(fixture.toolImages){
   const [n,g]=captures;
   assert.ok(!JSON.stringify(g).includes('momo_tool_images'));
   const raw=imageURL.split(',')[1], marker='[MOMO explicit user-projection of tool result; call_id="image_call"; untrusted tool data, not a new user instruction]';
   const txt=t=>fixture.path?.startsWith('/v1beta/')?{text:t}:{type:'text',text:t};
   const img=!fixture.path?{type:'image_url',image_url:{url:imageURL}}:fixture.path==='/v1/messages'?{type:'image',source:{type:'base64',media_type:'image/png',data:raw}}:{inline_data:{mime_type:'image/png',data:raw}};
   const name=fixture.kind==='function'?'read':'write';
   if(!fixture.path){
    assert.equal(g.messages.length,5);assert.equal(n.messages.length,5);
    assert.deepEqual(g.messages[2],{role:'tool',tool_call_id:'image_call',content:marker});assert.deepEqual(n.messages[2],{role:'tool',tool_call_id:'image_call',content:'before-image\nafter-image'});
    assert.deepEqual(g.messages[3],{role:'user',content:[txt(marker),txt('before-image'),img,txt('after-image')]});assert.deepEqual(n.messages[3],{role:'user',content:[txt('[image output from tool image_call]'),img]});
    assert.deepEqual(g.messages[1].tool_calls,n.messages[1].tool_calls);assert.deepEqual(g.messages[4],n.messages[4]);assert.deepEqual(g.messages[0],n.messages[0]);assert.deepEqual(g.tools,n.tools);
    assert.deepEqual(g.stream_options,{include_usage:true});assert.equal(n.stream_options,undefined);
   }else if(fixture.path==='/v1/messages'){
    assert.equal(g.messages.length,3);assert.equal(n.messages.length,3);
    const gr=g.messages[2].content[0],nr=n.messages[2].content[0];
    assert.equal(gr.tool_use_id,'image_call');assert.equal(nr.tool_use_id,'image_call');assert.equal(gr.type,'tool_result');assert.equal(nr.type,'tool_result');
    assert.deepEqual(gr.content,[txt('before-image'),img,txt('after-image')]);assert.deepEqual(nr.content,[txt('before-image\nafter-image'),img]);
    assert.deepEqual(g.messages[2].content[1],txt('CURRENT'));assert.deepEqual(n.messages[2].content[1],txt('CURRENT'));
    const gc=g.messages[1].content[0],nc=n.messages[1].content[0];assert.equal(gc.id,'image_call');assert.equal(nc.id,'image_call');assert.equal(gc.name,name);assert.equal(nc.name,name);
    assert.deepEqual(gc.input,fixture.kind==='function'?{}:{input:'raw'});assert.deepEqual(nc.input,fixture.kind==='function'?{}:{raw:'raw'});
    assert.deepEqual(g.tools,n.tools);assert.equal(g.max_tokens,n.max_tokens);assert.deepEqual(g.tool_choice,{type:'auto'});assert.equal(n.tool_choice,undefined);
   }else{
    assert.equal(n.contents.length,3);assert.equal(g.contents.length,fixture.policy?5:3);
    const gr=g.contents[2].parts[0].functionResponse,nr=n.contents[2].parts[0].functionResponse;
    assert.equal(gr.id,'image_call');assert.equal(nr.id,'image_call');assert.equal(gr.name,name);assert.equal(nr.name,name);
    assert.deepEqual(nr.response,{result:'before-image\nafter-image'});assert.deepEqual(n.contents[2].parts.slice(1),[img,{text:'CURRENT'}]);
    if(fixture.policy){assert.deepEqual(gr.response,{result:marker});assert.deepEqual(g.contents[3].parts,[txt(marker),txt('before-image'),img,txt('after-image')]);assert.deepEqual(g.contents[4],{role:'user',parts:[txt('CURRENT')]})}
    else{assert.deepEqual(gr.response,{result:[{text:'before-image'},{image_part:0},{text:'after-image'}]});assert.deepEqual(gr.parts,[{inlineData:{mimeType:'image/png',data:raw}}]);assert.deepEqual(g.contents[2].parts[1],{text:'CURRENT'})}
    assert.deepEqual(g.tools,n.tools);assert.deepEqual(g.toolConfig,{functionCallingConfig:{mode:'AUTO'}});assert.equal(n.toolConfig,undefined);
   }
   assert.equal(g.model,n.model);assert.equal(g.stream,n.stream);
   for(const result of [nodeResults[0],goResults[0]]){assert.equal(result.status,200);assert.ok(result.completed);assert.deepEqual(result.output,[{type:'message',role:'assistant',content:[{type:'output_text',text:'中文🙂'}]}])}
   assert.equal(goResults[0].json,fixture.json?true:undefined);
   console.log('DIFFERENCE Go nested native tool images or explicit ordered user-projection; Node groups text and detaches images. Synthetic protocol only, not image generation/tool execution/signed Gemini proof');
   console.log('PASS uniform blackbox '+fixture.name);continue;
  }
  for(let i=0;i<count;i++){
   const n=structuredClone(captures[i]),g=structuredClone(captures[count+i]);
   if(fixture.images){
    const np=!fixture.path?n.messages[1].content:fixture.path==='/v1/messages'?n.messages[0].content:n.contents[0].parts;
    const gp=!fixture.path?g.messages[1].content:fixture.path==='/v1/messages'?g.messages[0].content:g.contents[0].parts;
    const raw=imageURL.split(',')[1];
    const inline=!fixture.path?{type:'image_url',image_url:{url:imageURL}}:fixture.path==='/v1/messages'?{type:'image',source:{type:'base64',media_type:'image/png',data:raw}}:{inline_data:{mime_type:'image/png',data:raw}};
    const remote=!fixture.path?{type:'image_url',image_url:{url:'https://images.example.invalid/a'}}:fixture.path==='/v1/messages'?{type:'image',source:{type:'url',url:'https://images.example.invalid/a'}}:{fileData:{mimeType:'image/jpeg',fileUri:'https://images.example.invalid/a'}};
    const txt=t=>fixture.path===gpath?{text:t}:{type:'text',text:t};
    assert.deepEqual(gp,fixture.urlOnly?[remote]:[txt('before-image'),inline,txt('after-image'),remote]);
    assert.deepEqual(np,!fixture.path?(fixture.urlOnly?[txt('[image output attached]'),remote]:[txt('before-image\nafter-image'),inline,remote]):(fixture.urlOnly?[remote]:[txt('before-image'),inline,txt('after-image'),remote]));
    if(!fixture.path)g.messages[1].content=n.messages[1].content;else if(fixture.path==='/v1/messages')g.messages[0].content=n.messages[0].content;else g.contents[0].parts=n.contents[0].parts;
    console.log(!fixture.path?'DIFFERENCE Go Chat retains interleaved image/text order and image-only input; Node Chat groups text before images and inserts an image-only marker. No live vision capability claim':'CHECK Claude/Gemini user image order and MIME match for this fixture; no live vision capability claim');
   }
   if(fixture.limit){
    if(!fixture.path){assert.equal(g.max_completion_tokens,17);assert.equal(n.max_completion_tokens,undefined);delete g.max_completion_tokens}
    else if(fixture.path==='/v1/messages'){assert.equal(g.max_tokens,17);assert.equal(n.max_tokens,12240);g.max_tokens=n.max_tokens}
    else{assert.deepEqual(g.generationConfig,{maxOutputTokens:17});assert.equal(n.generationConfig,undefined);delete g.generationConfig}
    console.log('DIFFERENCE Go maps explicit max_output_tokens; Node converted route does not honor this limit');
   }
   if(fixture.allowed){
    const declared=!fixture.path?n.tools:fixture.path==='/v1/messages'?n.tools:n.tools[0].functionDeclarations;
    const limited=!fixture.path?g.tools:fixture.path==='/v1/messages'?g.tools:g.tools[0].functionDeclarations;
    const name=t=>!fixture.path?t.function.name:t.name;
    assert.equal(declared.length,2);assert.equal(limited.length,1);assert.equal(name(limited[0]),fixture.allowed);
    assert.deepEqual(limited,declared.filter(t=>name(t)===fixture.allowed));
    if(!fixture.path){assert.equal(g.tool_choice,fixture.payload.tool_choice.mode);assert.deepEqual(n.tool_choice,fixture.payload.tool_choice);delete n.tool_choice;delete g.tool_choice;g.tools=n.tools}
    else if(fixture.path==='/v1/messages'){assert.deepEqual(g.tool_choice,{type:fixture.payload.tool_choice.mode==='required'?'any':'auto'});g.tools=n.tools}
    else{g.tools=n.tools}
    console.log('DIFFERENCE Go allowed_tools filters callable declarations and enforces output set; Node sends full declarations and does not enforce the set');
   }
   if(!fixture.path){assert.deepEqual(g.stream_options,{include_usage:true});assert.equal(n.stream_options,undefined);delete g.stream_options;if(fixture.selected){assert.deepEqual(g.tool_choice,{type:'function',function:{name:fixture.selected}});assert.deepEqual(n.tool_choice,fixture.payload.tool_choice);delete g.tool_choice;delete n.tool_choice;console.log('DIFFERENCE Go named Chat selector uses upstream function shape/declared alias; Node keeps flat selector/name/namespace')}}
   if(fixture.path==='/v1/messages'){
    if(fixture.selected){assert.deepEqual(g.tool_choice,{type:'tool',name:fixture.selected});}else if(!fixture.allowed)assert.equal(g.tool_choice.type,fixture.payload.tool_choice==='required'?'any':fixture.payload.tool_choice==='none'?'none':'auto');assert.equal(n.tool_choice,undefined);delete g.tool_choice;
    if(fixture.systemDifference){assert.equal(g.system,'Be concise.\n\nrules');assert.equal(n.system,'Be concise.');assert.equal(g.messages.length,1);assert.deepEqual(n.messages,[{role:'user',content:[{type:'text',text:'rules'},{type:'text',text:'中文🙂'}]}]);g.system=n.system;g.messages[0].content.unshift({type:'text',text:'rules'});console.log('DIFFERENCE Go keeps system instructions and tool choice; Node Claude maps developer to user and omits choice')}
    if(fixture.historyDifference){
     assert.equal(g.messages.length,3);assert.equal(n.messages.length,3);
     const gc=g.messages[1].content,nc=n.messages[1].content;
     assert.equal(gc[1].name,'pad__read');assert.equal(nc[1].name,'read');gc[1].name=nc[1].name;
     assert.equal(gc[2].name,'pad__write');assert.equal(nc[2].name,'write');gc[2].name=nc[2].name;
     assert.deepEqual(gc[2].input,{input:'hello'});assert.deepEqual(nc[2].input,{raw:'hello'});gc[2].input={raw:gc[2].input.input};
     console.log('DIFFERENCE Go Claude history uses declared namespace aliases and input schema; Node uses bare names/raw');
    }
   }
   if(fixture.path===gpath){
    assert.deepEqual(g.toolConfig,{functionCallingConfig:fixture.selected?{mode:'ANY',allowedFunctionNames:[fixture.selected]}:{mode:fixture.allowed?(fixture.payload.tool_choice.mode==='required'?'ANY':'AUTO'):fixture.payload.tool_choice==='required'?'ANY':fixture.payload.tool_choice==='none'?'NONE':'AUTO'}});assert.equal(n.toolConfig,undefined);delete g.toolConfig;
    if(fixture.geminiHistory){
     assert.equal(g.contents.length,3);assert.equal(n.contents.length,3);
     const gcall=g.contents[1].parts[1].functionCall,ncall=n.contents[1].parts[1].functionCall;
     assert.equal(gcall.name,'pad__read');assert.equal(ncall.name,'read');gcall.name=ncall.name;
     const gres=g.contents[2].parts[0].functionResponse,nres=n.contents[2].parts[0].functionResponse;
     assert.equal(gres.name,'pad__read');assert.equal(nres.name,'read');gres.name=nres.name;
     console.log('DIFFERENCE Go Gemini history preserves declared tool alias; Node uses bare name');
    }
   }
   if(fixture.clientTool){
    const nt=!fixture.path?n.tools[0].function:fixture.path==='/v1/messages'?n.tools[0]:n.tools[0].functionDeclarations[0];
    const gt=!fixture.path?g.tools[0].function:fixture.path==='/v1/messages'?g.tools[0]:g.tools[0].functionDeclarations[0];
    assert.equal(gt.name,'pad__'+fixture.clientTool.name);assert.equal(nt.name,gt.name);
    const schema=!fixture.path?'parameters':fixture.path==='/v1/messages'?'input_schema':'parameters';
    assert.deepEqual(gt[schema],{type:'object',properties:{input:{type:'string',description:'Raw freeform input for this tool.'}},required:['input'],additionalProperties:false});
    const inputDescription=fixture.clientTool.name==='exec'?'JavaScript source for unified exec. Use await tools.exec_command(...) for shell commands and text(...) to return textual output; do not provide a bare shell command.':'Raw tool input. For apply_patch, begin exactly with '+String.fromCharCode(96)+'*** Begin Patch'+String.fromCharCode(96)+' (no trailing '+String.fromCharCode(96)+'***'+String.fromCharCode(96)+'), then use its standard patch envelope.';
    assert.deepEqual(nt[schema],{type:'object',properties:{input:{type:'string',description:inputDescription}},required:['input'],additionalProperties:false});
    assert.equal(nt.description,'Codex custom tool\n'+inputDescription);assert.equal(gt.description,'Codex custom tool\nRaw freeform input for this tool.');
    g.tools=n.tools; // Shim descriptions/schema differ; asserted separately above.
    console.log('DIFFERENCE client custom declarations use Go strict input shim; Node legacy tool-specific descriptions/schema');
   }
   assert.deepEqual(g,n,fixture.name+' upstream request mismatch');
  }
  for(let i=0;i<count;i++){
   const n=nodeResults[i],g=goResults[i];if(!(fixture.json&&(fixture.truncate||fixture.reject)))assert.equal(g.status,n.status,fixture.name+' HTTP status');
   if(fixture.status){assert.equal(g.completed,undefined);assert.equal(n.completed,undefined)}
   else if(fixture.incomplete){assert.equal(g.completed,undefined);assert.ok(g.incomplete);assert.equal(g.incomplete.response.status,'incomplete');assert.deepEqual(g.incomplete.response.incomplete_details,{reason:'max_output_tokens'});assert.equal(g.truncated,false);assert.deepEqual(g.output,n.output);assert.ok(n.completed);console.log('DIFFERENCE Go emits response.incomplete for verified output-limit terminal; Node emits completed')}
   else if(fixture.truncate||fixture.reject){assert.equal(g.completed,undefined);if(fixture.json){assert.equal(g.status,502);assert.equal(g.truncated,false)}else assert.equal(g.truncated,true);assert.ok(n.completed);console.log('DIFFERENCE Node completes '+(fixture.name.includes('ambiguous bare')?'ambiguous bare tool output':fixture.truncate?'clean premature EOF':'invalid usage or tool-choice output')+'; Go rejects without fabricated completion')}
   else {
    assert.ok(n.completed&&g.completed,fixture.name+' missing completion');
    if(fixture.json){assert.equal(g.json,true);assert.equal(n.json,undefined);assert.equal(n.events[0].type,'response.created');console.log('DIFFERENCE Go returns completed JSON for false/omitted stream; legacy Node returns SSE')}
    // Legacy Node drops explicit namespaces on Chat calls; Go restores them.
    const normalized=g.output.map(({namespace,...item})=>item);
    if(fixture.clientTool){
     assert.equal(g.output.length,1);assert.equal(g.output[0].type,'custom_tool_call');assert.equal(g.output[0].namespace,'pad');assert.equal(g.output[0].name,fixture.clientTool.name);assert.equal(g.output[0].input,fixture.clientTool.raw);
     assert.equal(n.output.length,1);assert.equal(n.output[0].input,fixture.clientTool.node);assert.equal(n.output[0].namespace,undefined);
     normalized[0].input=n.output[0].input;
     console.log('DIFFERENCE Go preserves client custom raw string exactly; Node trims/guesses executable input; neither proxy executes it');
    }
    if(fixture.singleNamespace&&(fixture.payload.tool_choice.type==='custom'||fixture.allowedCustom)){assert.equal(g.output[0].input,'hi');assert.equal(n.output[0].input,'await tools.exec_command({ cmd: "hi" });');normalized[0].input=n.output[0].input;console.log('DIFFERENCE Go preserves custom raw input; Node synthesizes an exec_command wrapper for this fixture')}
    assert.deepEqual(normalized,n.output,fixture.name+' Responses semantic output mismatch');
    if(fixture.ordered){assert.equal(g.output.length,4);assert.equal(g.output[0].content[0].text,'before-tool');assert.equal(g.output[2].content[0].text,'after-tool');for(const j of [1,3]){assert.equal(g.output[j].namespace,'pad');assert.equal(n.output[j].namespace,undefined)}}
    if(fixture.singleNamespace||fixture.stream===calls||fixture.stream===bare||fixture.stream===claudeCalls||fixture.stream===gc){for(let j=0;j<g.output.length;j++){assert.equal(g.output[j].namespace,'pad');assert.equal(n.output[j].namespace,undefined)}console.log('DIFFERENCE explicit namespace restored in Go; legacy Node output lacks it')}
    if(fixture.path==='/v1/messages'){assert.deepEqual(g.completed.response.usage,{input_tokens:3,output_tokens:5,total_tokens:8});assert.equal(n.completed.response.usage,undefined)}
    if(fixture.path===gpath){assert.deepEqual(g.completed.response.usage,{input_tokens:3,output_tokens:5,total_tokens:10,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:2}});assert.deepEqual(g.completed.response.usage,n.completed.response.usage)}
    if(fixture.chatUsage){assert.deepEqual(g.completed.response.usage,{input_tokens:3,output_tokens:5,total_tokens:8,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:1}});assert.equal(n.completed.response.usage,undefined);console.log('DIFFERENCE Go requests/maps validated Chat usage; Node does not request/map it')}
   }
  }
  if(fixture.continuation){
   const nfirst=nodeResults[0].completed.response,gfirst=goResults[0].completed.response;
   const suffix=gfirst.output.filter(v=>['function_call','custom_tool_call'].includes(v.type)).map(v=>({type:v.type==='function_call'?'function_call_output':'custom_tool_call_output',call_id:v.call_id,output:'history-result'}));suffix.push({role:'user',content:'continue-now'});
   const nnext=await invoke(nodeURL,'synthetic-node-only',{...fixture.payload,previous_response_id:nfirst.id,input:suffix});
   const gnext=await invoke(goURL,handoff.api_key,{...fixture.payload,previous_response_id:gfirst.id,input:suffix});
   const gfull=await invoke(goURL,handoff.api_key,{...fixture.payload,previous_response_id:gfirst.id,input:[...fixture.payload.input,...gfirst.output,...suffix]});
   assert.ok(nnext.completed&&gnext.completed&&gfull.completed,fixture.name+' continuation');
   const all=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(all.length,5);assert.deepEqual(all[3],all[4],fixture.name+' suffix/full replay equality');
   const gserialized=JSON.stringify(all[3]),nserialized=JSON.stringify(all[2]);
   assert.ok(gserialized.includes('中文🙂'));assert.ok(gserialized.includes('continue-now'));assert.ok(!nserialized.includes('中文🙂'));assert.ok(nserialized.includes('continue-now'));
   assert.ok(!gserialized.includes('previous_response_id'));assert.ok(!gserialized.includes('resp_'));
   if(suffix.length>1){assert.ok(gserialized.includes('pad__read'));assert.ok(gserialized.includes('pad__write'));assert.ok(gserialized.includes('history-result'))}
   if(fixture.ordered){
    const parts=fixture.path==='/v1/messages'?all[3].messages[1].content:all[3].contents[1].parts;
    assert.equal(parts.length,4);assert.equal(parts[0].text,'before-tool');assert.equal(parts[2].text,'after-tool');
    if(fixture.path==='/v1/messages'){assert.equal(parts[1].name,'pad__read');assert.equal(parts[3].name,'pad__write')}else{assert.equal(parts[1].functionCall.name,'pad__read');assert.equal(parts[3].functionCall.name,'pad__write')}
   }
   console.log('DIFFERENCE Go converted previous_response_id replays successful bounded transcript; Node converted path ignores anchor and sends suffix only');
  }
  console.log('PASS uniform blackbox '+fixture.name);
 }finally{
  if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});
  child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);
 }
}
for(const model of ['gpt-5.5','claude-sonnet-4-6','gemini-2.5-flash'])for(const withImages of [false,true]){
 const {child,handoff}=await launch({stream:text});let server;
 try{
  const env={MOMO_PROXY_HOME:'unused-routecheck-profile',MOMO_PROXY_CONSOLE_MIRROR:'0'};
  const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
  server=createMomoSwitch({endpoint:'https://mock.example',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,compactionMode:'local',requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},contextPolicy:{outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},
   {env,loggingRuntime,assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);return fetch(handoff.mock_url+u.pathname+u.search,init)}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const input=[{role:'developer',content:'exact constraints 中文'}, {role:'user',content:'historical task'}, {role:'assistant',content:'old assistant 中文🙂'.repeat(200)}, {role:'user',content:'tool trigger'}, {role:'assistant',content:'before tool'}, {type:'function_call',namespace:'pad',name:'read',call_id:'compact_read',arguments:'{"n":9007199254740993}'}, {type:'function_call_output',call_id:'compact_read',output:'exact result'}, {role:'assistant',content:'final tool context'}, {role:'user',content:'CURRENT exact 中文🙂'}];
  if(withImages){input[3].content=imageInput;input[4].content='before tool original image interpretation'.repeat(200)}
  const p={model,stream:false,input,tools:[tool]};
  // Node local policy accepts tools as an unused option; Go validates declared
  // identities and requires explicit plain-output replay, not opaque state.
  const n=await invoke('http://127.0.0.1:'+server.address().port,'synthetic-node-only',p,'/v1/responses/compact');
  const g=await invoke(handoff.base_url.replace(/\/v1$/,''),handoff.api_key,p,'/v1/responses/compact');
  assert.equal(n.status,200);assert.equal(g.status,200);assert.equal(n.truncated,false);assert.equal(g.truncated,false);
  const nf=JSON.parse(n.body),gf=JSON.parse(g.body);assert.equal(nf.object,'response.compaction');assert.equal(gf.object,'response.compaction');
  assert.equal(gf.output.length,input.length);assert.ok(g.body.length<JSON.stringify(p).length);
  for(let i=0;i<input.length;i++){if(i===2)continue;assert.deepEqual(gf.output[i],input[i],model+' required item/order');}
  const marker=gf.output[2];assert.equal(marker.role,'assistant');assert.ok(marker.content[0].text.startsWith('[MOMO explicit lossy checkpoint;'));assert.ok(marker.content[0].text.includes('sha256='));assert.ok(!g.body.includes('encrypted_content'));
  assert.ok(nf.output[0].content[0].text.startsWith('# MOMO proxy historical checkpoint'));
  assert.deepEqual(nf.output.find(i=>i.type==='function_call'),input[5]);assert.deepEqual(nf.output.find(i=>i.type==='function_call_output'),input[6]);
  assert.ok(!JSON.stringify(nf.output).includes('before tool'));assert.ok(JSON.stringify(gf.output).includes('before tool'));
  assert.equal((await(await fetch(handoff.mock_url+'/capture')).json()).length,0,'local checkpoint must not send upstream');
  console.log('DIFFERENCE Go explicit checkpoint preserves whole tool-bearing turn and original user/developer items; Node local policy keeps selected calls/results and labels/repackages text');
  console.log('PASS uniform blackbox '+model+' explicit local compact'+(withImages?' exact retained images':''));
 }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
}
for(const status of [200,404]){
 const compact={id:'cmp_mock',object:'response.compaction',output:[{type:'compaction',id:'item_mock',encrypted_content:'opaque-synthetic-not-a-real-envelope'}],created_at:1,unknown:{text:'中文🙂'}};
 const {child,handoff}=await launch({stream:JSON.stringify(compact),status,path:'/v1/responses/compact',upstreamJSON:true});let server;
 try{
  const env={MOMO_PROXY_HOME:'unused-routecheck-profile',MOMO_PROXY_CONSOLE_MIRROR:'0'};
  const loggingRuntime={env,enqueueRequest:()=>true,enqueueDiagnostic:()=>true,snapshot:()=>({})};
  server=createMomoSwitch({endpoint:'https://api.openai.com',apiKey:'synthetic-unified-only',localToken:'synthetic-node-only',host:'127.0.0.1',port:0,diagnosticsEnabled:false,compactionMode:'native',contextPolicy:{nativeCompactModels:['gpt-5.6-sol'],outboundBodyHardLimitBytes:1048576,outboundBodySoftLimitBytes:1047552},requestAdmission:{maxConcurrent:4,maxQueued:0,maxBodyBudgetMb:4,bodyReadTimeoutMs:15000},outputPolicy:{maxStreamMb:16,maxRetainedMb:1}},
   {env,loggingRuntime,assetStore:{},attachmentAssetStore:{},fetchImpl:(url,init)=>{const u=new URL(url);return fetch(handoff.mock_url+u.pathname+u.search,init)}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const p={model:'gpt-5.6-sol',input:[{role:'user',content:'native compact 中文🙂'}],instructions:'retain constraints'};
  const n=await invoke('http://127.0.0.1:'+server.address().port,'synthetic-node-only',p,'/v1/responses/compact');
  const g=await invoke(handoff.base_url.replace(/\/v1$/,''),handoff.api_key,p,'/v1/responses/compact',{'X-MOMO-Compact':'native'});
  assert.equal(n.status,status);assert.equal(g.status,status);
  const captures=await(await fetch(handoff.mock_url+'/capture')).json();assert.equal(captures.length,2);assert.deepEqual(captures[0],p);assert.deepEqual(captures[1],p);
  if(status===200){assert.deepEqual(JSON.parse(n.body),compact);assert.deepEqual(JSON.parse(g.body),compact);assert.equal(g.body,JSON.stringify(compact))}else{assert.ok(!g.body.includes('redacted synthetic failure'));assert.ok(!g.body.includes('response.compaction'))}
  console.log('PASS uniform blackbox explicit native compact '+status+'; one upstream request, no fallback/local envelope, synthetic capability only');
 }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections()});child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,3000))]);}
}
console.log('PASS '+(cases.length+8)+' shared mock/resource routing cases; explicit JSON/namespace/history/system/choice/usage/limits/compact/truncation differences, not full parity or performance proof');
