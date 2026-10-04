package ui

const Page = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<title>MOMO 本地代理</title>
<style>:root{color-scheme:light dark}body{font:15px system-ui;margin:32px;max-width:760px}h1{margin-bottom:8px}p{line-height:1.6}label{display:block;margin-top:18px}input{box-sizing:border-box;width:100%;padding:10px;font:inherit}button{padding:10px 18px;margin:18px 8px 0 0}pre{white-space:pre-wrap;padding:18px;background:#8882;border-radius:8px}.note{color:#888;font-size:13px}</style>
<h1>MOMO 本地代理 · Preview</h1>
<p>原生 Go 服务 + Wails v3。支持原协议 Responses、Chat Completions 和模型列表；上游必须支持相应接口，暂不做协议转换。</p>
<label>HTTPS 上游地址（根域名，不带 /v1）<input id="endpoint" value="https://momoapi.us" autocomplete="off" spellcheck="false"></label>
<label>上游 API Key<input id="key" type="password" autocomplete="off" spellcheck="false"></label>
<label><input id="remember" type="checkbox" style="width:auto"> 明确同意保存至系统凭据库（默认不保存）</label>
<button id="configure">应用配置</button><button id="start">启动代理</button><button id="stop">停止代理</button><button id="refresh">刷新状态</button>
<button id="copy">复制客户端连接配置</button><button id="quit">退出并停止代理</button>
<button id="load">读取已保存配置</button><button id="forget">删除已保存配置</button>
<p id="notice" role="status" aria-live="polite"></p>
<pre id="state" aria-live="polite">正在读取状态</pre>
<p>复制配置会将本机地址和本地认证 Key 写入系统剪贴板，其他应用可能读取，请自行清除。也可使用托盘菜单。</p>
<p class="note">只在明确操作时保存/读取本应用的配置，不读取其他软件凭据。不写明文配置；系统凭据库不可用时不会回退明文。删除保存配置不清除本次内存配置，也不停止运行中的代理；取消保存勾选不会删除以前保存的配置。输入时 Key 会经过本地 WebView，清空输入框不保证内存擦除。Windows/macOS 关闭窗口隐藏至托盘；Linux 关闭窗口退出。无自启动、自动更新或正式签名安装包。</p>
<script>
const byId=id=>document.getElementById(id);
let lastState=null,mutationPending=false,statePending=false,requestSerial=0,renderedSerial=0;
function updateControls(){const stopped=lastState&&!lastState.Running&&lastState.Active===0;for(const id of ['configure','load','endpoint','key','remember'])byId(id).disabled=mutationPending||!stopped;byId('start').disabled=mutationPending||!stopped||!lastState.Configured;byId('forget').disabled=mutationPending;byId('copy').disabled=mutationPending||!lastState||!lastState.Configured;byId('stop').disabled=!lastState||(!lastState.Running&&lastState.Active===0);byId('refresh').disabled=statePending;byId('quit').disabled=false}
async function action(name,body){const polling=name==='state',mutation=!polling&&name!=='stop'&&name!=='quit';if(polling&&statePending||mutation&&mutationPending)return false;if(polling)statePending=true;if(mutation)mutationPending=true;const serial=++requestSerial;let controller,timer;if(polling){controller=new AbortController();timer=setTimeout(()=>controller.abort(),5000)}updateControls();if(!polling)byId('notice').textContent=mutation?'正在处理；系统凭据库可能等待解锁。仍可停止或退出。':'';try{const r=await fetch('/app/'+name,{method:'POST',signal:controller?.signal,headers:{'X-MOMO-Bridge':bridgeNonce,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(!r.ok){if(!polling)byId('notice').textContent=name==='configure'&&r.status===503?'配置已应用至本次内存，但安全保存失败。系统凭据库可能不可用，或配置过长；没有写入明文。':r.status===409?'另一操作尚未完成，或代理尚未停止；仍可停止或退出。':name==='load'?'读取失败：请先停止代理，确认已经保存且系统凭据库可用。':'操作失败，请检查配置或服务状态';return false}const s=await r.json();if(serial>=renderedSerial){renderedSerial=serial;lastState=s;byId('state').textContent=JSON.stringify(s,null,2)}if(name==='load')byId('endpoint').value=s.Endpoint;if(!polling)byId('notice').textContent=name==='copy'?'已复制连接配置，请注意剪贴板安全':name==='configure'?'配置已应用':name==='load'?'已读取保存配置，尚未启动':name==='forget'?'已删除保存配置，本次内存配置不变':'';return true}catch{if(!polling)byId('notice').textContent='操作失败，请检查配置或服务状态';return false}finally{if(timer)clearTimeout(timer);if(polling)statePending=false;if(mutation)mutationPending=false;updateControls()}}
document.getElementById('configure').onclick=async()=>{const key=byId('key');const config={Endpoint:byId('endpoint').value.trim(),APIKey:key.value,Remember:byId('remember').checked};key.value='';try{await action('configure',config)}finally{config.APIKey=''}};
document.getElementById('load').onclick=()=>action('load');document.getElementById('forget').onclick=()=>{if(confirm('仅删除系统凭据库中的保存配置，不清除当前内存配置。继续？'))action('forget')};
document.getElementById('start').onclick=()=>action('start');document.getElementById('stop').onclick=()=>action('stop');document.getElementById('refresh').onclick=()=>action('state');document.getElementById('copy').onclick=()=>{if(confirm('连接配置包含本地 Key，会写入剪贴板。继续？'))action('copy')};document.getElementById('quit').onclick=()=>action('quit');updateControls();setInterval(()=>{if(!document.hidden)action('state')},1500);window.addEventListener('focus',()=>action('state'));action('state')</script></html>`
