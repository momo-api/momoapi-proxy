//go:build appcheck && !nogui

package main

// Executes the shipped page's DOM event handlers, not alternate fetch actions.
// Synthetic native test only, never compiled into the distributed application.
const pageProbeScript = `
async function check(){
 const ensure=value=>{if(!value)throw Error('page check failed')};
 const request=async name=>{const r=await fetch('/'+name,{method:'POST',headers:{'X-MOMO-Bridge':bridgeNonce}});ensure(r.ok)};
 const button=async name=>{ensure(!byId(name).disabled);await byId(name).onclick()};
 const readyDeadline=Date.now()+5000;while((!lastState||statePending)&&Date.now()<readyDeadline)await new Promise(resolve=>setTimeout(resolve,20));
 ensure(lastState);await action('state');ensure(byId('start').disabled&&!byId('configure').disabled);
 await button('nav-routing');ensure(!byId('view-routing').hidden&&byId('view-overview').hidden&&byId('nav-routing').getAttribute('aria-selected')==='true');
 await button('nav-settings');ensure(!byId('view-settings').hidden&&byId('view-routing').hidden);
 await button('nav-overview');ensure(!byId('view-overview').hidden);
 await button('nav-integrations');ensure(!byId('view-integrations').hidden);await button('skill-copy');await button('mcp-copy');
 await button('nav-overview');ensure(byId('quota-refresh').disabled);
 byId('endpoint').value='https://mock.example';byId('key').value='synthetic-appcheck-only';byId('remember').checked=true;
 await button('configure');ensure(byId('key').value===''&&lastState.Configured);
 byId('endpoint').value='https://other.example';byId('key').value='synthetic-other';byId('remember').checked=false;
 await button('configure');await button('nav-settings');await button('load');ensure(byId('endpoint').value==='https://mock.example'&&!byId('view-overview').hidden&&byId('view-settings').hidden);
 await button('quota-refresh');ensure(byId('quota-available').textContent.includes('12,345')&&byId('quota-note').textContent.includes('非账户钱包')&&!byId('state').textContent.includes('private-do-not-render'));
 await button('start');ensure(lastState.Running&&byId('configure').disabled&&byId('load').disabled&&byId('start').disabled&&!byId('stop').disabled&&!byId('quit').disabled);
 ensure(byId('service-state').textContent==='运行中'&&byId('status-badge').dataset.tone==='good'&&byId('local-url').textContent===lastState.LocalEndpoint+'/v1');
 await request('check-proxy');await request('check-native-stop');
 const deadline=Date.now()+5000;while(lastState.Running&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
 ensure(!lastState.Running&&!byId('start').disabled&&!byId('configure').disabled);
 ensure(byId('status-label').textContent==='已停止');
 await button('start');await request('check-stall');await button('stop');await request('check-done');
}
check().catch(()=>{});
`
