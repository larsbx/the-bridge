import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const origin = 'http://127.0.0.1:3173';
export const password = 'fixture-passphrase-long-enough';
export const sdkURL = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

// A deterministic HTTP contract fixture, not a replacement for the Ash/database tests
// or evidence of a connection to Plaid Sandbox. Control endpoints live only here.
export function createBackend() {
  const state = { sessions: new Map(), streams: new Set(), requests: [], links: [], exchanges: [], webhooks: [], balance: 12345, snapshotFailure: 0 };
  const broadcast = (event = 'refresh') => {
    for (const { response, token } of state.streams) {
      response.write(`event: ${state.sessions.has(token) ? event : 'signed-out'}\ndata: {}\n\n`);
      if (!state.sessions.has(token)) response.end();
    }
  };
  const reset = () => {
    for (const stream of state.streams) stream.response.end();
    state.sessions.clear(); state.streams.clear();
    state.requests.length = state.links.length = state.exchanges.length = state.webhooks.length = 0;
    state.balance = 12345; state.snapshotFailure = 0;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const json = (status, data, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      response.end(JSON.stringify(data));
    };
    const redirect = headers => { response.writeHead(303, { location: '/', ...headers }); response.end(); };
    let body;
    try { body = request.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw.toString() || '{}') : Object.fromEntries(new URLSearchParams(raw.toString())); }
    catch { return json(400, { error: 'invalid_request' }); }
    if (url.pathname.startsWith('/__test/')) {
      if (url.pathname === '/__test/reset') reset();
      if (url.pathname === '/__test/change') { state.balance = body.balance || 45678; broadcast(); }
      if (url.pathname === '/__test/drop') for (const stream of state.streams) stream.response.end();
      if (url.pathname === '/__test/revoke') { state.sessions.clear(); broadcast(); }
      return json(200, { links: state.links, exchanges: state.exchanges, streams: state.streams.size, balance: state.balance });
    }
    state.requests.push({ path: request.url, method: request.method, headers: request.headers });
    const token = request.headers.cookie?.match(/(?:^|;\s*)bridge_session=([^;]+)/)?.[1];
    const csrf = state.sessions.get(token);
    if (url.pathname === '/healthz') return json(200, { status: 'ok' });
    if (url.pathname === '/api/session') return json(200, csrf ? { authenticated: true, csrf } : { authenticated: false });
    if (url.pathname === '/login') {
      if (request.headers.origin !== origin) return json(403, { error: 'origin_rejected' });
      if (body.password !== password) return json(401, { error: 'invalid_credentials' });
      const token = randomUUID();
      state.sessions.set(token, 'csrf-' + token);
      return redirect({ 'set-cookie': `bridge_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200` });
    }
    if (url.pathname === '/api/plaid/webhook') {
      state.webhooks.push({ raw, signature: request.headers['plaid-verification'] });
      return json(401, { error: 'fixture_does_not_verify_signatures' });
    }
    if (!csrf) return json(401, { error: 'authentication_required' });
    if (request.method === 'POST' && (request.headers.origin !== origin || (request.headers['x-csrf-token'] || body.csrf) !== csrf)) return json(403, { error: 'csrf_or_origin_rejected' });
    if (url.pathname === '/logout') {
      state.sessions.delete(token); broadcast();
      return redirect({ 'set-cookie': 'bridge_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
    }
    if (url.pathname === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      response.write('retry: 50\nevent: refresh\ndata: {}\n\n');
      const stream = { response, token };
      state.streams.add(stream);
      response.on('close', () => state.streams.delete(stream));
      return;
    }
    if (url.pathname === '/api/plaid/link-token') {
      state.links.push(body);
      return json(200, { link_token: 'link-sandbox-fixture', update_mode: !!body.item_id });
    }
    if (url.pathname === '/api/plaid/exchange') {
      state.exchanges.push(body);
      return json(200, { connected: true });
    }
    if (url.pathname === '/api/sync' || url.pathname === '/sync') {
      state.balance += 100;
      broadcast();
      return url.pathname === '/sync' ? redirect() : json(202, { scheduled: true });
    }
    if (url.pathname === '/api/snapshot') {
      if (state.snapshotFailure) return json(state.snapshotFailure, { error: 'fixture_unavailable' });
      if (url.searchParams.get('month') === 'invalid') return json(400, { error: 'invalid_request' });
      const month = url.searchParams.get('month') || '2026-10';
      return json(200, {
        month,
        items: [{ item_id: 'fixture-item', institution: '<img src=x onerror=alert(1)>', status: 'needs_relink' }],
        accounts: [{ item_id: 'fixture-item', account_id: 'checking', name: 'Current checking', mask: '1234', type: 'depository', currency: 'USD', current_cents: state.balance, updated_at: '2026-10-21T00:00:00Z' }],
        account_filters: [{ item_id: 'fixture-item', account_id: 'checking', name: 'Current checking', active: true }, { item_id: 'fixture-item', account_id: 'closed', name: 'Closed account', active: false }],
        transactions: [{ date: month + '-01', name: 'Fixture purchase', account_name: 'Closed account', historical: true, pending: false, category: 'GENERAL_MERCHANDISE', amount_cents: 678, currency: 'USD' }],
        categories: [{ category: 'GENERAL_MERCHANDISE', amount_cents: 678 }], months: [{ month, amount_cents: 678 }],
        balancesIncomplete: false, totals: { cash_cents: state.balance, card_debt_cents: 0, net_liquid_cents: state.balance, spending_cents: 678 }, generated_at: '2026-10-21T00:00:00Z'
      });
    }
    json(404, { error: 'not_found' });
  });
  return { server, state, broadcast, reset };
}

export async function startApp({ backendPort = 0, externalBackendOrigin } = {}) {
  const backend = createBackend();
  if (!externalBackendOrigin) {
    backend.server.listen(backendPort, '127.0.0.1');
    await once(backend.server, 'listening');
  }
  const backendOrigin = externalBackendOrigin || `http://127.0.0.1:${backend.server.address().port}`;
  const child = spawn(process.execPath, ['build'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '3173', BRIDGE_API_ORIGIN: backendOrigin, SHUTDOWN_TIMEOUT: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  const close = async () => {
    backend.reset();
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    if (!externalBackendOrigin) {
      backend.server.closeAllConnections();
      await new Promise(resolve => backend.server.close(resolve));
    }
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Node server exited: ${output}`);
      try { if ((await fetch(origin + '/healthz')).status === 200) return { ...backend, backendOrigin, close, output: () => output }; }
      catch { /* Start-up race. */ }
      await delay(50);
    }
    throw new Error(`Node server did not become ready: ${output}`);
  } catch (error) { await close(); throw error; }
}
