export async function handle({ event, resolve }) {
  const response = await resolve(event);
  response.headers.set('cache-control', 'no-store');
  response.headers.set('x-content-type-options', 'nosniff');
  // no-referrer makes native form navigations send Origin: null in Chromium.
  // Keep the same-origin CSRF signal while sending no referrer to external sites.
  response.headers.set('referrer-policy', 'same-origin');
  response.headers.set('content-security-policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://cdn.plaid.com; frame-src https://*.plaid.com; connect-src 'self' https://*.plaid.com; img-src 'self' data: https://*.plaid.com; style-src 'self'");
  return response;
}

// Upstream errors can contain provider data; expose and log no raw error payload.
export const handleError = () => ({ message: 'Request failed' });
