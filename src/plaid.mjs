import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';

export class Plaid {
  constructor(config, fetcher = fetch) {
    if (!['sandbox', 'production'].includes(config.env)) throw new Error('PLAID_ENV must be sandbox or production');
    this.host = 'https://' + config.env + '.plaid.com';
    this.clientId = config.clientId;
    this.secret = config.secret;
    this.publicUrl = config.publicUrl || '';
    this.redirectUri = config.redirectUri || '';
    this.fetcher = fetcher;
    this.keys = new Map();
  }
  async post(path, data) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const res = await this.fetcher(this.host + path, {
        method: 'POST',
        headers: {'Content-Type':'application/json','PLAID-CLIENT-ID':this.clientId,'PLAID-SECRET':this.secret},
        body: JSON.stringify(data), signal: controller.signal
      });
      const reply = await res.json();
      if (!res.ok) {
        const error = new Error(reply.error_code || 'PLAID_HTTP_' + res.status);
        error.code = reply.error_code || 'PLAID_HTTP_' + res.status;
        throw error;
      }
      return reply;
    } finally { clearTimeout(timeout); }
  }
  async linkToken(accessToken = '') {
    const body = {client_name:'The Bridge',country_codes:['US'],language:'en'};
    if (accessToken) body.access_token = accessToken;
    else {
      body.user = {client_user_id:'owner'};
      body.products = ['transactions'];
      body.transactions = {days_requested:730};
    }
    if (this.publicUrl && !accessToken) body.webhook = this.publicUrl.replace(/\/$/, '') + '/api/plaid/webhook';
    if (this.redirectUri) body.redirect_uri = this.redirectUri;
    return (await this.post('/link/token/create', body)).link_token;
  }
  exchange(publicToken) { return this.post('/item/public_token/exchange', {public_token:publicToken}); }
  accounts(token) { return this.post('/accounts/get', {access_token:token}); }
  requestRefresh(token) { return this.post('/transactions/refresh', {access_token:token}); }
  async syncPages(token, initialCursor = null) {
    // A pagination mutation invalidates ALL pages, not only the last page.
    for (let attempt = 0; attempt < 3; attempt++) {
      const pages = [];
      let cursor = initialCursor;
      try {
        for (let page = 0; page < 1000; page++) {
          const data = {access_token:token,count:500};
          if (cursor !== null && cursor !== '') data.cursor = cursor;
          const reply = await this.post('/transactions/sync', data);
          pages.push(reply);
          cursor = reply.next_cursor;
          if (!reply.has_more) return {pages,cursor};
          if (!cursor) throw new Error('Missing Plaid pagination cursor');
        }
        throw new Error('Plaid page cap exceeded');
      } catch (error) {
        if (error.code !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' || attempt === 2) throw error;
      }
    }
    throw new Error('Plaid sync exhausted retry budget');
  }
  async verifyWebhook(body, signedJwt, now = Date.now()) {
    try {
      if (!signedJwt || signedJwt.length > 4096) return false;
      const parts = signedJwt.split('.');
      if (parts.length !== 3) return false;
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (header.alg !== 'ES256' || typeof header.kid !== 'string' || header.kid.length > 128) return false;
      let jwk = this.keys.get(header.kid);
      if (!jwk) {
        jwk = (await this.post('/webhook_verification_key/get', {key_id:header.kid})).key;
        if (jwk?.kid !== header.kid || jwk?.alg !== 'ES256' || jwk?.kty !== 'EC' || jwk?.crv !== 'P-256' || jwk?.use !== 'sig') return false;
        this.keys.set(header.kid, jwk);
      }
      const seconds = Math.floor(now / 1000);
      if (jwk.expired_at !== null && jwk.expired_at !== undefined && jwk.expired_at <= seconds) return false;
      const valid = verifySignature('sha256', Buffer.from(parts[0] + '.' + parts[1]),
        {key:createPublicKey({key:jwk,format:'jwk'}),dsaEncoding:'ieee-p1363'},
        Buffer.from(parts[2], 'base64url'));
      if (!valid) return false;
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (!Number.isInteger(claims.iat) || claims.iat > seconds + 30 || seconds - claims.iat > 300) return false;
      const actual = Buffer.from(createHash('sha256').update(body).digest('hex'));
      const supplied = Buffer.from(String(claims.request_body_sha256 || ''));
      return actual.length === supplied.length && timingSafeEqual(actual, supplied);
    } catch { return false; }
  }
}
