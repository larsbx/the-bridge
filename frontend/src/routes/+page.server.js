import { backend, snapshot } from '#lib/server/backend.js';
import { error } from '@sveltejs/kit';

export async function load(event) {
  const response = await backend(event, '/api/session', 'GET');
  if (!response.ok) error(502, 'Session unavailable');
  const session = await response.json();
  if (!session.authenticated) return { authenticated: false };
  const data = await snapshot(event);
  if (!data) return { authenticated: false };
  return {
    authenticated: true, csrf: session.csrf, snapshot: data,
    filters: { account: event.url.searchParams.get('account') || '', q: event.url.searchParams.get('q') || '' }
  };
}
