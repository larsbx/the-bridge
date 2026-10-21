/* Progressive enhancement only. Financial calculations and rendering stay in Elixir. */
(() => {
  const csrf = document.querySelector('meta[name="bridge-csrf"]')?.content;
  if (!csrf) return;
  const status = message => { const el = document.getElementById('status'); if (el) el.textContent = message; };
  const post = async (url, body = {}) => {
    const response = await fetch(url, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Request failed');
    return response.json();
  };
  let request;
  const refresh = async () => {
    request?.abort();
    request = new AbortController();
    try {
      const response = await fetch('/fragment' + location.search, { signal: request.signal, cache: 'no-store' });
      if (response.status === 401) { location.replace('/'); return; }
      if (!response.ok) throw new Error();
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = doc.getElementById('finance');
      if (next) document.getElementById('finance')?.replaceWith(next);
    } catch (error) { if (error.name !== 'AbortError') status('Live update unavailable. Reload to retry.'); }
  };
  const stream = new EventSource('/api/events');
  stream.addEventListener('refresh', refresh);
  stream.addEventListener('signed-out', () => { stream.close(); location.replace('/'); });
  stream.onerror = () => status('Live connection interrupted; reconnecting…');
  stream.onopen = () => status('Live updates connected.');
  addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  addEventListener('pagehide', () => { stream.close(); request?.abort(); });
  let sdk;
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-connect]');
    if (!button) return;
    button.disabled = true;
    try {
      sdk ||= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
        script.onload = resolve; script.onerror = () => { sdk = null; script.remove(); reject(new Error()); };
        document.head.append(script);
      });
      await sdk;
      const item = button.dataset.connect;
      const result = await post('/api/plaid/link-token', item ? { item_id: item } : {});
      const link = window.Plaid.create({ token: result.link_token,
        onSuccess: async (public_token, metadata) => {
          try {
            if (!result.update_mode) await post('/api/plaid/exchange', { public_token, institution: metadata.institution?.name });
            await post('/api/sync');
            status('Connection accepted. Waiting for account updates.');
          } catch { status('Could not finish linking. Check updates and retry.'); }
          finally { link.destroy(); button.disabled = false; }
        }, onExit: () => { link.destroy(); button.disabled = false; } });
      link.open();
    } catch { status('Could not open Plaid Link. Please retry.'); button.disabled = false; }
  });
})();
