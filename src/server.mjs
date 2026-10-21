import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keyFromHex, createSession, readSession, csrfToken, validateCsrf, parseCookies, passwordMatches } from './security.mjs';
import { Store, monthBounds } from './db.mjs';
import { Plaid } from './plaid.mjs';

const env = process.env;
const port = Number(env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
if (!env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD.length < 16) throw new Error('DASHBOARD_PASSWORD must be at least 16 characters');
if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) throw new Error('Missing Plaid credentials');
if (env.NODE_ENV === 'production' && (!env.PUBLIC_URL || !env.PUBLIC_URL.startsWith('https://')))
  throw new Error('Production requires an HTTPS PUBLIC_URL');
const sessionKey = keyFromHex(env.SESSION_KEY, 'SESSION_KEY');
const dataKey = keyFromHex(env.DATA_KEY, 'DATA_KEY');
if (sessionKey.equals(dataKey)) throw new Error('SESSION_KEY and DATA_KEY must differ');
const secureCookie = !!(env.PUBLIC_URL || '').startsWith('https://');
const store = new Store(env.DB_PATH || './data/bridge.sqlite', dataKey);
const plaid = new Plaid({
  env: env.PLAID_ENV || 'sandbox', clientId:env.PLAID_CLIENT_ID, secret:env.PLAID_SECRET,
  publicUrl:env.PUBLIC_URL, redirectUri:env.PLAID_REDIRECT_URI
});
const index = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)));
const js = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)));
const css = readFileSync(fileURLToPath(new URL('../public/style.css', import.meta.url)));
const clients = new Set();
const jobs = new Map();
const loginAttempts = new Map();
let version = 0;

function send(res, status, value, headers={}) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',...headers});
  res.end(JSON.stringify(value));
}
function staticFile(res, type, contents) {
  res.writeHead(200, {'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://cdn.plaid.com; frame-src https://*.plaid.com; connect-src 'self' https://*.plaid.com; img-src 'self' data: https://*.plaid.com; style-src 'self'"});
  res.end(contents);
}
async function bodyBytes(req, max=128*1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json'))
    throw new Error('Expected application/json');
  return JSON.parse((await bodyBytes(req)).toString('utf8'));
}
function cookieFor(token) {
  return 'bridge_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200' +
    (secureCookie ? '; Secure' : '');
}
function session(req) {
  const token = parseCookies(req.headers.cookie).bridge_session;
  return readSession(sessionKey, token) ? token : null;
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    const requested = new URL(origin);
    const expected = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin :
      'http://' + req.headers.host;
    return requested.origin === expected;
  } catch { return false; }
}
function csrfAllowed(req, token) {
  return req.headers['x-csrf-token'] && validateCsrf(sessionKey, token, req.headers['x-csrf-token']);
}
function publish() {
  version++;
  const packet = 'id: ' + version + '\nevent: refresh\ndata: ' + JSON.stringify({version}) + '\n\n';
  for (const client of clients) {
    if (!client.write(packet)) {
      // Clients also receive a heartbeat; slow connections are closed defensively.
      if (client.writableLength > 1024 * 1024) client.end();
    }
  }
}
function syncItem(itemId) {
  if (jobs.has(itemId)) return jobs.get(itemId);
  const job = (async () => {
    const item = store.item(itemId);
    if (!item) return;
    try {
      const [accountResult, syncResult] = await Promise.all([
        plaid.accounts(item.accessToken),
        plaid.syncPages(item.accessToken, item.cursor)
      ]);
      store.saveAccounts(itemId, accountResult.accounts || []);
      store.commitSync(itemId, syncResult.pages, syncResult.cursor);
      publish();
    } catch (error) {
      const state = error.code === 'ITEM_LOGIN_REQUIRED' ? 'needs_relink' : 'sync_error';
      store.markStatus(itemId, state);
      publish();
      throw error;
    }
  })().finally(() => jobs.delete(itemId));
  jobs.set(itemId, job);
  return job;
}
function scheduleSync(itemId) {
  if (!store.item(itemId)) return;
  setImmediate(() => syncItem(itemId).catch(e => {
    console.error('Plaid sync failed:', e.code || 'internal_error');
  }));
}
function syncAll() {
  for (const item of store.items()) scheduleSync(item.item_id);
}
function rateLimited(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || {count:0, until:now+15*60*1000};
  if (now > record.until) { record.count=0; record.until=now+15*60*1000; }
  loginAttempts.set(ip, record);
  return record;
}
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (req.method === 'GET' && pathname === '/') return staticFile(res,'text/html; charset=utf-8',index);
    if (req.method === 'GET' && pathname === '/app.js') return staticFile(res,'text/javascript; charset=utf-8',js);
    if (req.method === 'GET' && pathname === '/style.css') return staticFile(res,'text/css; charset=utf-8',css);
    if (req.method === 'GET' && pathname === '/healthz') return send(res,200,{status:'ok'});
    if (req.method === 'POST' && pathname === '/api/plaid/webhook') {
      const raw = await bodyBytes(req);
      if (!await plaid.verifyWebhook(raw, req.headers['plaid-verification']))
        return send(res,401,{error:'invalid_webhook_signature'});
      const notice = JSON.parse(raw.toString('utf8'));
      if (typeof notice.item_id === 'string' && store.item(notice.item_id)) {
        if (notice.webhook_type === 'TRANSACTIONS' &&
          ['SYNC_UPDATES_AVAILABLE','INITIAL_UPDATE','HISTORICAL_UPDATE','DEFAULT_UPDATE','TRANSACTIONS_REMOVED'].includes(notice.webhook_code))
          scheduleSync(notice.item_id);
        if (notice.webhook_type === 'ITEM' && notice.webhook_code === 'ERROR') {
          store.markStatus(notice.item_id,'needs_relink');
          publish();
        }
      }
      return send(res,200,{received:true});
    }
    if (req.method === 'POST' && !originAllowed(req)) return send(res,403,{error:'origin_rejected'});
    if (req.method === 'POST' && pathname === '/api/login') {
      const record = rateLimited(req.socket.remoteAddress || 'unknown');
      if (record.count >= 5) return send(res,429,{error:'too_many_attempts'});
      const payload = await jsonBody(req);
      if (!passwordMatches(payload.password, env.DASHBOARD_PASSWORD)) {
        record.count++;
        return send(res,401,{error:'invalid_credentials'});
      }
      record.count = 0;
      const token = createSession(sessionKey);
      return send(res,200,{authenticated:true,csrf:csrfToken(sessionKey,token)},
        {'Set-Cookie':cookieFor(token)});
    }
    const token = session(req);
    if (req.method === 'GET' && pathname === '/api/session')
      return send(res,200,token ? {authenticated:true,csrf:csrfToken(sessionKey,token)} : {authenticated:false});
    if (!token) return send(res,401,{error:'authentication_required'});
    if (req.method === 'POST' && !csrfAllowed(req, token)) return send(res,403,{error:'csrf_rejected'});
    if (req.method === 'POST' && pathname === '/api/logout')
      return send(res,200,{logged_out:true},{'Set-Cookie':'bridge_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + (secureCookie ? '; Secure':'')});
    if (req.method === 'GET' && pathname === '/api/snapshot') {
      const url = new URL(req.url,'http://localhost');
      const month = url.searchParams.get('month') ||
        [new Date().getFullYear(),String(new Date().getMonth()+1).padStart(2,'0')].join('-');
      monthBounds(month);
      return send(res,200,store.snapshot(month,url.searchParams.get('account') || '',
        url.searchParams.get('q') || ''));
    }
    if (req.method === 'POST' && pathname === '/api/plaid/link-token') {
      const payload = await jsonBody(req);
      const item = payload.item_id ? store.item(payload.item_id) : null;
      if (payload.item_id && !item) return send(res,404,{error:'unknown_item'});
      const linkToken = await plaid.linkToken(item?.accessToken);
      return send(res,200,{link_token:linkToken,update_mode:!!item});
    }
    if (req.method === 'POST' && pathname === '/api/plaid/exchange') {
      const payload = await jsonBody(req);
      if (typeof payload.public_token !== 'string' || payload.public_token.length > 500 || !payload.public_token)
        return send(res,400,{error:'invalid_public_token'});
      const result = await plaid.exchange(payload.public_token);
      const institution = typeof payload.institution === 'string' ?
        payload.institution.slice(0,100) : 'Linked institution';
      store.saveItem(result.item_id,result.access_token,institution);
      scheduleSync(result.item_id);
      publish();
      return send(res,200,{connected:true});
    }
    if (req.method === 'POST' && pathname === '/api/sync') {
      const items = store.items();
      const results = await Promise.allSettled(items.map(item => syncItem(item.item_id)));
      return send(res,200,{updated:results.filter(r => r.status === 'fulfilled').length,
        failed:results.filter(r => r.status === 'rejected').length});
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      if (clients.size >= 20) return send(res,429,{error:'too_many_streams'});
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8',
        'Cache-Control':'no-cache, no-transform','Connection':'keep-alive',
        'X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'});
      clients.add(res);
      res.write('retry: 5000\nevent: refresh\ndata: ' + JSON.stringify({version}) + '\n\n');
      const heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(': heartbeat\n\n');
      },20000);
      const expiryMs = Math.max(1000, Number(token.split('.')[1]) * 1000 - Date.now());
      const expiry = setTimeout(() => res.end(), expiryMs);
      req.on('close', () => {clients.delete(res);clearInterval(heartbeat);clearTimeout(expiry);});
      return;
    }
    return send(res,404,{error:'not_found'});
  } catch (error) {
    const code = typeof error.code === 'string' ? error.code : null;
    if (code) console.error('Plaid/API error:',code);
    else console.error('Request failed:', error.message === 'Invalid month' ? 'Invalid month' : 'request_error');
    if (!res.headersSent) return send(res,
      ['Invalid month','Unknown account','Search too long','Expected application/json','Request too large'].includes(error.message) || error instanceof SyntaxError ? 400 : 502,
      {error:code || 'request_failed'});
    res.end();
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(port,'0.0.0.0',() => {
  console.log('The Bridge listening on port '+port+' ('+(env.PLAID_ENV||'sandbox')+')');
  syncAll(); // Cursor sync on restart catches missed webhooks.
});
setInterval(syncAll,15*60*1000).unref();
function shutdown() {
  for (const client of clients) client.end();
  server.close(() => {store.close();process.exit(0);});
}
process.once('SIGTERM',shutdown);
process.once('SIGINT',shutdown);
