import { forward } from '#lib/server/backend.js';

const reads = new Set(['session', 'snapshot', 'events']);
const writes = new Set(['sync', 'plaid/link-token', 'plaid/exchange', 'plaid/webhook']);

export function GET(event) {
  if (!reads.has(event.params.path)) return new Response('Not found', { status: 404 });
  return forward(event, '/api/' + event.params.path + event.url.search);
}

export function POST(event) {
  if (!writes.has(event.params.path)) return new Response('Not found', { status: 404 });
  return forward(event, '/api/' + event.params.path);
}
