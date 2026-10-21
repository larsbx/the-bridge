import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

async function availablePort() {
  const server=createServer();
  await new Promise((resolve, reject) => {
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function untilHealthy(origin, child) {
  for (let i=0; i<60; i++) {
    if (child.exitCode !== null) throw Error('Server exited before becoming healthy');
    try {
      const res=await fetch(origin+'/healthz');
      if(res.ok) return;
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Server did not become healthy');
}
test('private dashboard HTTP authorization, CSRF, SSE and logout revocation', {timeout:20000}, async() => {
  const port=await availablePort();
  const root=resolve(fileURLToPath(new URL('..', import.meta.url)));
  const directory=mkdtempSync(join(tmpdir(),'bridge-http-'));
  const origin='http://127.0.0.1:'+port;
  const password='a sufficiently long passphrase for tests';
  const child=spawn(process.execPath,['src/server.mjs'],{
    cwd:root, env:{...process.env,PORT:String(port),HOST:'127.0.0.1',PLAID_ENV:'sandbox',
      PLAID_CLIENT_ID:'test-client',PLAID_SECRET:'test-secret',DASHBOARD_PASSWORD:password,
      SESSION_KEY:'ab'.repeat(32),DATA_KEY:'cd'.repeat(32),
      PUBLIC_URL:'',DB_PATH:join(directory,'finance.sqlite')},
    stdio:'ignore'
  });
  try {
    await untilHealthy(origin,child);
    let res=await fetch(origin+'/api/snapshot?month=2026-10');
    assert.equal(res.status,401);
    res=await fetch(origin+'/api/login',{method:'POST',headers:{
      Origin:'https://unrelated.example','Content-Type':'application/json'
    },body:JSON.stringify({password})});
    assert.equal(res.status,403);
    res=await fetch(origin+'/api/login',{method:'POST',headers:{
      Origin:origin,'Content-Type':'application/json'
    },body:JSON.stringify({password:'incorrect but long password'})});
    assert.equal(res.status,401);
    res=await fetch(origin+'/api/login',{method:'POST',headers:{
      Origin:origin,'Content-Type':'application/json'
    },body:JSON.stringify({password})});
    assert.equal(res.status,200);
    const cookie=res.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('bridge_session='));
    const {csrf}=await res.json();
    assert.ok(csrf);
    res=await fetch(origin+'/api/snapshot?month=2026-10',{headers:{Cookie:cookie}});
    assert.equal(res.status,200);
    const snapshot=await res.json();
    assert.deepEqual(snapshot.items,[]);
    res=await fetch(origin+'/api/sync',{method:'POST',headers:{
      Origin:origin,Cookie:cookie,'Content-Type':'application/json'
    },body:'{}'});
    assert.equal(res.status,403);
    res=await fetch(origin+'/api/plaid/webhook',{method:'POST',headers:{
      'Content-Type':'application/json'
    },body:JSON.stringify({webhook_type:'TRANSACTIONS',item_id:'unknown'})});
    assert.equal(res.status,401);
    const controller=new AbortController();
    try {
      res=await fetch(origin+'/api/events',{headers:{Cookie:cookie},signal:controller.signal});
      assert.equal(res.status,200);
      assert.match(res.headers.get('content-type'),'text/event-stream');
      const chunk=await res.body.getReader().read();
      assert.match(new TextDecoder().decode(chunk.value),'event: refresh');
    } finally {controller.abort();}
    res=await fetch(origin+'/api/logout',{method:'POST',headers:{
      Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'
    },body:'{}'});
    assert.equal(res.status,200);
    res=await fetch(origin+'/api/snapshot?month=2026-10',{headers:{Cookie:cookie}});
    assert.equal(res.status,401,'server must reject a previously valid session after logout');
  } finally {
    child.kill('SIGTERM');
    if(child.exitCode === null) {
      await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,2000))]);
    }
    rmSync(directory,{recursive:true,force:true});
  }
});
