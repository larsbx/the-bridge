// Optional handoff only. Ship owns authentication, approval, execution and recovery.
// This process never proxies finance cookies, CSRF tokens or deployment credentials.
export function shipControlURL(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)) return null;
    return url.origin + '/';
  } catch {
    return null;
  }
}
