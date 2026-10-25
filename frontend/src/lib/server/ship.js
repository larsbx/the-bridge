// Optional handoff only. Ship owns authentication, approval, execution and recovery.
// This process never proxies finance cookies, CSRF tokens or deployment credentials.
export function shipControlURL(value, bridgePublicURL) {
  if (!value || !bridgePublicURL) return null;
  try {
    const url = new URL(value);
    const bridge = new URL(bridgePublicURL);
    if (!['http:', 'https:'].includes(bridge.protocol) || bridge.username || bridge.password ||
        bridge.pathname !== '/' || bridge.search || bridge.hash) return null;
    // Cookies are hostname-scoped, never port-scoped. Referrer suppression and
    // SameSite do not isolate two services sharing a hostname.
    const hostname = target => target.hostname.toLowerCase().replace(/\.$/, '');
    if (hostname(url) === hostname(bridge)) return null;
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback)) return null;
    return url.origin + '/';
  } catch {
    return null;
  }
}
