import { render } from 'svelte/server';
import { snapshot } from '#lib/server/backend.js';
import Finance from '#lib/components/Finance.svelte';

export async function GET(event) {
  const data = await snapshot(event);
  if (!data) return new Response('Authentication required', { status: 401 });
  const { body } = await render(Finance, { props: { data } });
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
