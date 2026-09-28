import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
const exec = promisify(execFile);
const docker = args => exec('docker', args, { timeout: 120000, maxBuffer: 1024 * 1024 });

test('production nginx routes monitor under prefix and isolates failures', { timeout: 180000 }, async t => {
  const id = `monitor-proxy-test-${process.pid}-${Date.now()}`;
  const network = `${id}-net`, monitor = `${id}-app`, gateway = `${id}-gateway`;
  let networkCreated = false, monitorCreated = false, gatewayCreated = false;
  t.after(async () => {
    if (gatewayCreated) await docker(['rm', '-f', gateway]);
    if (monitorCreated) await docker(['rm', '-f', monitor]);
    if (networkCreated) await docker(['network', 'rm', network]);
  });
  await docker(['network', 'create', network]); networkCreated = true;
  await docker(['run', '-d', '--name', monitor, '--network', network, '--network-alias', 'page-monitor', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/app/data:rw,uid=1000,gid=1000,size=16m', '-e', 'PUBLIC_ORIGIN=https://www.lanbinquan.top', 'monitor-check']); monitorCreated = true;
  await docker(['run', '-d', '--name', gateway, '--network', network, '--network-alias', 'gateway', '--mount', `type=bind,src=${fileURLToPath(new URL('nginx.conf', import.meta.url))},dst=/etc/nginx/conf.d/default.conf,readonly`, '--entrypoint', 'nginx', 'nginx:stable-alpine', '-g', 'daemon off;']); gatewayCreated = true;
  for (let attempt = 0; ; attempt++) {
    try { await docker(['exec', monitor, 'node', '-e', "fetch('http://127.0.0.1:4318/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]); break; }
    catch (error) { if (attempt >= 19) throw error; await setTimeout(500); }
  }
  await docker(['exec', monitor, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const base='http://gateway/3D/monitor/';
    const headers={Host:'www.lanbinquan.top','X-Forwarded-Proto':'https'};
    assert.equal((await fetch(base,{redirect:'manual'})).status,308);
    assert.equal((await fetch(base.slice(0,-1),{headers,redirect:'manual'})).status,308);
    for(const p of ['', 'app.js', 'style.css', 'monitor.js', 'demo.html']) {
      const r=await fetch(base+p,{headers}); assert.equal(r.status,200,p);
      if(p.endsWith('.js')) assert.match(r.headers.get('content-type'),/javascript/);
    }
    assert.equal((await fetch(base+'api/events',{headers})).status,200);
    assert.equal((await fetch(base+'api/ingest',{method:'POST',headers:{...headers,Origin:'https://www.lanbinquan.top'},body:JSON.stringify({events:[{id:'proxy-check',project:'ci',session:'ci',type:'pageview',name:'ci',timestamp:Date.now()}]})})).status,202);
    assert.equal((await fetch(base+'api/ingest',{method:'POST',headers,body:'x'.repeat(70000)})).status,413);
    assert.equal((await fetch('http://gateway/',{headers})).status,200);
  `]);
  await docker(['stop', monitor]);
  await docker(['exec', gateway, 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/']);
  const { stdout } = await docker(['exec', gateway, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'X-Forwarded-Proto: https', 'http://127.0.0.1/3D/monitor/']);
  assert.ok(['502', '504'].includes(stdout.trim()), stdout);
});
