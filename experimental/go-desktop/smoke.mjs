import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
const binary=process.argv[2];if(!binary)throw Error('Provide absolute experimental binary path');
const token=randomBytes(32).toString('hex');
const daemon=spawn(binary,['serve'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
let stderr='',output='';daemon.stderr.on('data',b=>stderr+=b);daemon.stdout.on('data',b=>output+=b);
daemon.stdin.end(JSON.stringify({Token:token}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function command(action,session){
 const child=spawn(binary,[action],{windowsHide:true,stdio:['pipe','pipe','pipe'],timeout:10000});
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.stdin.end(JSON.stringify(session));
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
 assert(!out.includes(token)&&!err.includes(token));return {code,out,err};
}
try{
 for(let i=0;i<100&&!output.includes(String.fromCharCode(10));i++)await delay(50);
 const ready=JSON.parse(output.trim());assert.equal(ready.Experimental,true);assert.equal(ready.Protocol,1);
 const session={Endpoint:ready.Endpoint,Token:token};
 for(const [action,running]of [['status',false],['demo-start',true],['demo-start',true],['status',true],['demo-stop',false],['demo-stop',false]]){
  const r=await command(action,session);assert.equal(r.code,0);const state=JSON.parse(r.out);assert.equal(state.DemoRunning,running);assert.equal(state.ProxyImplemented,false);
 }
 const bad=await command('status',{...session,Token:'0'.repeat(64)});assert.notEqual(bad.code,0);
 // Client processes exited without stopping the independent owner.
 assert.equal(daemon.exitCode,null);
 const afterClients=await command('status',session);assert.equal(afterClients.code,0);
 const unavailable=await command('status',{Endpoint:'http://127.0.0.1:1',Token:token});assert.notEqual(unavailable.code,0);
 const origin=await fetch(ready.Endpoint+'/control/v1/state',{headers:{Authorization:'Bearer '+token,Origin:'https://evil.example'}});assert.equal(origin.status,403);
 assert(!output.includes(token)&&!stderr.includes(token));
 console.log('PASS: real CLI readiness, status, idempotent demo controls, auth, Origin denial, no secret output. UI and proxy NOT tested.');
}finally{
 // Only the exact disposable test process, never arbitrary port owners.
 const exited=new Promise(resolve=>daemon.once('exit',resolve));daemon.kill();await Promise.race([exited,delay(3000)]);
}
