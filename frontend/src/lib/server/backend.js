import { env } from 'node:process';
import { error } from '@sveltejs/kit';

const requestHeaders = ['cookie', 'origin', 'content-type', 'x-csrf-token', 'plaid-verification', 'last-event-id', 'accept'];
const responseHeaders = ['content-type', 'location', 'x-accel-buffering'];

// Only fixed application routes call this module; the browser cannot choose a host.
export async function backend(event, path, method = event.request.method) {
  const base = new URL(env.BRIDGE_API_ORIGIN || 'http://127.0.0.1:4000');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash) error(503, 'Invalid backend configuration');
  const headers = new Headers();
  for (const name of requestHeaders) {
    const value = event.request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  let body;
  if (!['GET', 'HEAD'].includes(method)) {
    // Preserve webhook bytes exactly, with the same 128 KiB ceiling as Ash.
    const reader = event.request.body?.getReader();
    const chunks = [];
    let length = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      // Drain over-limit bytes without retaining them. Cancelling Node's request
      // reader destroys the socket before a 413 response can be delivered.
      if (length <= 131072) chunks.push(value);
    }
    if (length > 131072) error(413, 'Request too large');
    body = Buffer.concat(chunks, length);
  }
  try {
    return await fetch(new URL(path, base), {
      method, headers, body,
      redirect: 'manual', signal: event.request.signal
    });
  } catch {
    error(502, 'Backend unavailable');
  }
}

export async function forward(event, path) {
  const upstream = await backend(event, path);
  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const name of responseHeaders) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) headers.append('set-cookie', cookie);
  // Do not buffer SSE: cancellation/backpressure flow through the upstream body.
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function snapshot(event) {
  const response = await backend(event, '/api/snapshot' + event.url.search, 'GET');
  if (response.status === 401) return null;
  if (response.status === 400) error(400, 'Invalid dashboard filters');
  if (!response.ok) error(502, 'Dashboard unavailable');
  const data = await response.json();
  data.account_filters = data.account_filters.map(account => ({
    ...account,
    value: Buffer.from(JSON.stringify([account.item_id, account.account_id])).toString('base64url')
  }));
  return data;
}
