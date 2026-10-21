# Request-time SvelteKit implementation — 2026-10-21

Base: merged PR #1, main `e0f38da4771b416e578261d961b16e5799d617ed`. The reconciliation repair and finite formal results are already part of that base. This follow-up keeps Ash/PostgreSQL; it does not restore the superseded SQLite prototype or rewrite Item reconciliation, encryption, session validation, webhook verification or synchronization.

The static SvelteKit shell and Elixir HTML string templates are replaced by a Node-adapter SvelteKit application with request-time page loading, shared Svelte components and server endpoints. It forwards only explicit backend routes and selected headers, preserves cookies/redirects/raw webhook bytes, and streams authenticated SSE without buffering. CSR stays disabled. Public `_cents` fields are canonical decimal strings so the Node renderer cannot silently round signed-64-bit ledger amounts; accounting stays in Elixir.

## Executed locally

- Node 24.19.0 production build with `@sveltejs/adapter-node` 6.0.0 and locked SvelteKit 3 dependencies.
- `svelte-check`: zero errors/warnings.
- 12 production-Node HTTP integration checks: authentication/cookie flags, same-origin native forms, escaping, private routes, CSRF/Origin rejection, immediate SSE streaming and cancellation, reconnect refresh, logout/sign-out, Link/exchange/update-mode endpoints, raw webhook forwarding, body limits, route/header allowlists, errors and exact large-cent rendering.
- Four Chromium browser tests: no-JavaScript sign-in/filters/manual sync/logout; SSE reconnection and filtered dashboard updates; lazy Plaid SDK, initial exchange and update mode; SDK failure/retry. Backend and SDK are explicit deterministic fixtures in these four tests.
- Browser regression reproduced and repaired: `Referrer-Policy: no-referrer` caused Chromium native forms to send `Origin: null`. `same-origin` preserves the exact-Origin CSRF signal without sending referrers to external sites. CSRF checks stay enabled.
- First-party browser script remains **1,349 bytes gzip**, below the enforced 2,048-byte budget. HTTP/browser checks confirm no Svelte hydration requests. The lazy third-party SDK is excluded.
- `npm audit`: zero vulnerabilities.
- Elixir 1.19.0 / OTP 27.3.4 compilation with warnings as errors, formatting, migration-drift check and 11 unit/security tests passed.

The normal Playwright browser download failed in this runner. The local browser checks instead used the separately packaged Chromium 153 executable through `BRIDGE_CHROMIUM_PATH`; that package is test tooling outside the repository. CI installs Playwright's own Chromium.

## CI evidence

The workflow retains the existing pinned formal job and PostgreSQL ExUnit/conformance gate, and adds the production-Node HTTP suite plus both browser suites. The additional full-stack browser suite starts **real SvelteKit + Bandit/Ash + PostgreSQL**, substituting only outbound Plaid HTTP and the SDK. Its guarded fixture uses a dedicated disposable `bridge_browser_test` database. It checks signed sessions, encrypted Item token use, Link/exchange/relink, committed SSE refresh, account-ID replacement without duplicate balances, historical labeling and logout with a stream open.

Current-head CI results will be recorded after the run. A passing historical run from PR #1 is not evidence that this follow-up passed. Local PostgreSQL execution is unavailable; the real database/browser checks must pass in CI.

## Unexecuted acceptance

**No live Plaid Sandbox credentials were available.** Real Link institutions, provider token exchange, provider-delivered signed webhooks, OAuth redirect/resume and production deployment acceptance remain unexecuted. Intercepted SDK/HTTP fixtures do not discharge them. The earlier SQLite import, durable-job and operational limitations remain documented in the README and deployment guide.

No deployment or merge is implied by the automated test results. See [deployment and Sandbox acceptance](deployment.md) and the [unchanged formal-methods scope](../formal/README.md).
