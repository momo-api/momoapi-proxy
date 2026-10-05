//go:build appcheck && !nogui

package main

// Executes the shipped page's DOM event handlers, not alternate fetch actions.
// Synthetic native test only, never compiled into the distributed application.
const pageProbeScript = `
async function check(){
 let step='initial';
 window.momoProbeStep=()=>step;const ensure=value=>{if(!value)throw Error('page check failed')};
 const request=async name=>{step=name;const r=await fetch('/'+name,{method:'POST',headers:{'X-MOMO-Bridge':bridgeNonce}});ensure(r.ok)};
 const button=async name=>{step=name;ensure(!byId(name).disabled);await byId(name).onclick()};
 const readyDeadline=Date.now()+5000;while((!lastState||statePending)&&Date.now()<readyDeadline)await new Promise(resolve=>setTimeout(resolve,20));
 ensure(lastState);await action('state');ensure(byId('start').disabled&&!byId('configure').disabled);
 await button('nav-routing');ensure(!byId('view-routing').hidden&&byId('view-overview').hidden&&byId('nav-routing').getAttribute('aria-selected')==='true');ensure(byId('compact-state').textContent==='默认关闭 · 501'&&!byId('routing-details').open);byId('routing-details').querySelector('summary').click();ensure(byId('routing-details').open);byId('routing-details').querySelector('summary').click();ensure(!byId('routing-details').open);
 await button('nav-settings');ensure(!byId('view-settings').hidden&&byId('view-routing').hidden);
 await button('nav-overview');ensure(!byId('view-overview').hidden);
 await button('nav-integrations');ensure(!byId('view-integrations').hidden);await button('skill-copy');await button('mcp-copy');await button('codex-copy');
 await button('nav-overview');ensure(byId('quota-refresh').disabled);
 byId('endpoint').value='https://mock.example';byId('key').value='synthetic-appcheck-only';byId('remember').checked=true;
 await button('configure');ensure(byId('key').value===''&&lastState.Configured);
 byId('endpoint').value='https://other.example';byId('key').value='synthetic-other';byId('remember').checked=false;
 await button('configure');await button('nav-settings');await button('load');ensure(byId('endpoint').value==='https://mock.example'&&!byId('view-overview').hidden&&byId('view-settings').hidden);
 await button('quota-refresh');ensure(byId('quota-available').textContent.includes('12,345')&&byId('quota-note').textContent.includes('非账户钱包')&&!byId('state').textContent.includes('private-do-not-render'));
 await button('models-refresh');ensure(byId('models-state').textContent==='列表权限已验证'&&byId('models-list').textContent==='mock'&&byId('models-note').textContent.includes('不证明模型推理可用'));byId('models-filter').value='absent';byId('models-filter').oninput();ensure(byId('models-list').textContent==='没有匹配的模型');byId('models-filter').value='';byId('models-filter').oninput();ensure(byId('models-list').textContent==='mock');
 await button('start');ensure(lastState.Running&&byId('configure').disabled&&byId('load').disabled&&byId('start').disabled&&!byId('stop').disabled&&!byId('quit').disabled);
 ensure(byId('service-state').textContent==='运行中'&&byId('status-badge').dataset.tone==='good'&&byId('local-url').textContent===lastState.LocalEndpoint+'/v1');
 await button('nav-integrations');ensure(!byId('view-integrations').hidden&&!byId('image-mcp-copy').disabled);await button('image-mcp-copy');await button('nav-overview');
 // Test-only synthetic consent dialog, not an alternate handler/fetch path.
 window.confirm=()=>true;await button('nav-images');ensure(!byId('view-images').hidden);await button('image-catalog');ensure(byId('image-model').value===''&&byId('image-generate').disabled);byId('image-model').value='momoapi-gpt-image-2-5-flare';byId('image-model').onchange();byId('image-prompt').value='media-probe';byId('image-options').value='{}';byId('image-consent').checked=true;byId('image-consent').oninput();await button('image-generate');ensure(byId('image-result-state').textContent==='任务待完成'&&!byId('image-consent').checked&&!byId('image-task').disabled);await button('image-task');ensure(byId('image-result-state').textContent==='已返回结果'&&byId('image-task').disabled&&byId('image-results').textContent.includes('https://images.example/probe.png')&&!byId('image-preview').getAttribute('src'));byId('image-prompt').value='gui-inline-probe';byId('image-consent').checked=true;byId('image-consent').oninput();await button('image-generate');ensure(byId('image-preview').hidden&&!byId('image-preview').getAttribute('src'));byId('image-results').querySelector('button').click();ensure(!byId('image-preview').hidden&&byId('image-preview').src.startsWith('data:image/png;base64,'));const previewDeadline=Date.now()+2000;while(!byId('image-preview').complete&&Date.now()<previewDeadline)await new Promise(r=>setTimeout(r,20));ensure(byId('image-preview').naturalWidth===1);await button('nav-overview');
 await request('check-proxy');await request('check-native-stop');
 const deadline=Date.now()+5000;while(lastState.Running&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
 ensure(!lastState.Running&&!byId('start').disabled&&!byId('configure').disabled);
 ensure(byId('status-label').textContent==='已停止');
 ensure(byId('image-results').textContent===''&&byId('image-preview').hidden&&!byId('image-preview').getAttribute('src')&&byId('image-catalog').disabled);
 byId('routing-mode').checked=true;byId('key').value='synthetic-appcheck-only';await button('configure');ensure(lastState.Mode==='momo-routing');
 await button('start');ensure(byId('routing-mode').disabled&&byId('routing-state').textContent.includes('已启用')&&byId('compact-state').textContent==='部分支持 · 手动回放');await request('check-routing');await request('check-stall');await button('stop');await request('check-done');
}
check().catch(()=>{const allowed=['initial','nav-routing','nav-settings','nav-overview','nav-integrations','nav-images','image-catalog','image-generate','image-task','skill-copy','mcp-copy','image-mcp-copy','codex-copy','configure','load','quota-refresh','models-refresh','start','check-proxy','check-native-stop','check-routing','check-stall','stop','check-done'];const step=window.momoProbeStep?.();fetch('/check-page-failure?step='+(allowed.includes(step)?step:'unknown'),{method:'POST',headers:{'X-MOMO-Bridge':bridgeNonce}}).catch(()=>{});});
`
