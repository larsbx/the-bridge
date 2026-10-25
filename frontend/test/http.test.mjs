import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp, origin, password } from './support/app.mjs';
import { shipControlURL } from '../src/lib/server/ship.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.close(); });
beforeEach(() => app.reset());
const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options });
async function login() {
  const response = await request('/login', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }) });
  assert.equal(response.status, 303);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=43200/);
  assert.equal(response.headers.get('location'), '/');
  const cookie = setCookie.split(';')[0];
  const { csrf } = await (await request('/api/session', { headers: { cookie } })).json();
  return { cookie, csrf };
}

// All requests hit the production adapter-node build, never Vite's dev server.
test('public SSR login has no finance, enhancement script, hydration, or placeholders', async () => {
  const response = await request('/');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(html, /ship\.example\.test|Deployments in Ship/);
  assert.match(html, /action="\/login"/);
  assert.doesNotMatch(html, /id="finance"|BRIDGE_CONTENT|BRIDGE_CSRF|src="\/bridge.js"|import\s*\(|_app\/.*\.js/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await request('/', { method: 'HEAD' })).status, 200);
});

test('native login forwards cookie protections; authenticated Svelte SSR escapes financial data', async () => {
  const { cookie } = await login();
  const response = await request('/?month=2026-09&q=Fixture', { headers: { cookie } });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="finance"/);
  assert.match(html, /href="https:\/\/ship\.example\.test\/" rel="noreferrer">Deployments in Ship/);
  assert.match(html, /USD 123\.45/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x|encrypted_token|access-sandbox|BRIDGE_CONTENT|_app\/.*\.js|import\s*\(/);
  assert.match(html, /Historical/);
  assert.match(html, /value="2026-09"/);
  assert.match(html, /src="\/bridge.js"/);
  const fragment = await request('/fragment?month=2026-08', { headers: { cookie } });
  assert.match(await fragment.text(), /2026-08-01/);
  assert.equal(fragment.headers.get('cache-control'), 'no-store');
});

test('Ship handoff accepts only configured origins and never carries finance credentials', () => {
  assert.equal(shipControlURL('https://ship.example.test'), 'https://ship.example.test/');
  assert.equal(shipControlURL('http://127.0.0.1:8787'), 'http://127.0.0.1:8787/');
  for (const value of [undefined, '', 'javascript:alert(1)', 'http://remote.example',
    'https://user:password@ship.example', 'https://ship.example/deploy',
    'https://ship.example/?token=secret', 'https://ship.example/#secret']) assert.equal(shipControlURL(value), null);
});

test('private snapshot, fragment, and SSE reject forged and missing cookies', async () => {
  for (const path of ['/fragment', '/api/snapshot', '/api/events']) {
    for (const headers of [{}, { cookie: 'bridge_session=forged' }]) assert.equal((await request(path, { headers })).status, 401);
  }
});

test('mutations retain session, exact Origin, and session-bound CSRF checks', async () => {
  const { cookie, csrf } = await login();
  for (const [testOrigin, testCSRF] of [[origin, 'wrong'], ['https://evil.example', csrf], ['', csrf]]) {
    const response = await request('/api/sync', { method: 'POST', headers: { cookie, origin: testOrigin, 'x-csrf-token': testCSRF, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.equal((await request('/api/sync', { method: 'POST', headers: { cookie, origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: '{}' })).status, 202);
});

test('SSE is streamed immediately and reconnecting receives a new refresh snapshot', async () => {
  const { cookie, csrf } = await login();
  const controller = new AbortController();
  const response = await request('/api/events', { headers: { cookie, 'last-event-id': '17' }, signal: controller.signal });
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: refresh/);
  assert.equal(app.state.requests.at(-1).headers['last-event-id'], '17');
  app.state.balance = 98765;
  app.broadcast();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: refresh/);
  assert.match(await (await request('/fragment', { headers: { cookie } })).text(), /USD 987\.65/);
  controller.abort();
  await assert.rejects(reader.read());
  for (let i = 0; app.state.streams.size && i < 100; i++) await delay(10);
  assert.equal(app.state.streams.size, 0, 'cancelled browser stream must release the upstream connection');
  const second = new AbortController();
  const reconnected = await request('/api/events', { headers: { cookie }, signal: second.signal });
  const nextReader = reconnected.body.getReader();
  assert.match(new TextDecoder().decode((await nextReader.read()).value), /event: refresh/);
  await request('/logout', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) });
  assert.match(new TextDecoder().decode((await nextReader.read()).value), /event: signed-out/);
  second.abort();
  assert.equal((await request('/api/events', { headers: { cookie } })).status, 401);
});

test('Plaid Link create/exchange and relink use protected server endpoints', async () => {
  const { cookie, csrf } = await login();
  const headers = { cookie, origin, 'x-csrf-token': csrf, 'content-type': 'application/json' };
  const initial = await (await request('/api/plaid/link-token', { method: 'POST', headers, body: '{}' })).json();
  assert.deepEqual(initial, { link_token: 'link-sandbox-fixture', update_mode: false });
  const exchange = await request('/api/plaid/exchange', { method: 'POST', headers, body: JSON.stringify({ public_token: 'public-sandbox-fixture', institution: 'Fixture bank' }) });
  assert.equal(exchange.status, 200);
  const relink = await (await request('/api/plaid/link-token', { method: 'POST', headers, body: JSON.stringify({ item_id: 'fixture-item' }) })).json();
  assert.equal(relink.update_mode, true);
  assert.equal(app.state.exchanges.length, 1);
});

test('webhooks preserve exact raw bytes and verification header without requiring a browser session', async () => {
  const raw = '{ "item_id" : "fixture-item", "extra": "é" }\n';
  const response = await request('/api/plaid/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'plaid-verification': 'fixture-jwt' }, body: raw });
  assert.equal(response.status, 401); // Fixture deliberately performs no signature verification.
  assert.deepEqual(app.state.webhooks[0].raw, Buffer.from(raw));
  assert.equal(app.state.webhooks[0].signature, 'fixture-jwt');
});

test('oversized request is rejected before it can reach the private backend', async () => {
  const response = await request('/api/plaid/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(131073) });
  assert.equal(response.status, 413);
  assert.equal(app.state.webhooks.length, 0);
});

test('gateway has a fixed route allowlist and drops untrusted forwarding headers', async () => {
  assert.equal((await request('/api/__test/reset')).status, 404);
  assert.equal((await request('/api/session', { method: 'POST', headers: { origin }, body: '{}' })).status, 404);
  assert.equal((await request('/api/sync', { method: 'GET' })).status, 404);
  await request('/api/session?host=https://evil.example', { headers: { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-host': 'evil.example', authorization: 'untrusted' } });
  const seen = app.state.requests.at(-1).headers;
  assert.equal(seen['x-forwarded-for'], undefined);
  assert.equal(seen['x-forwarded-host'], undefined);
  assert.equal(seen.authorization, undefined);
});

test('invalid filters and upstream failures fail closed without exposing error payloads', async () => {
  const { cookie } = await login();
  assert.equal((await request('/?month=invalid', { headers: { cookie } })).status, 400);
  app.state.snapshotFailure = 502;
  const response = await request('/', { headers: { cookie } });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /fixture_unavailable|encrypted_token|stack/);
});

test('logout deletes the session cookie and a revoked page returns the login component', async () => {
  const { cookie, csrf } = await login();
  const response = await request('/logout', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) });
  assert.equal(response.status, 303);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  const html = await (await request('/', { headers: { cookie } })).text();
  assert.match(html, /action="\/login"/);
  assert.doesNotMatch(html, /id="finance"/);
});

test('cent strings render exactly beyond the JavaScript safe-integer range', async () => {
  const { cookie } = await login();
  app.state.balance = '9007199254740993';
  const html = await (await request('/', { headers: { cookie } })).text();
  assert.match(html, /USD 90071992547409\.93/);
  assert.doesNotMatch(html, /90071992547409\.92/);
});

