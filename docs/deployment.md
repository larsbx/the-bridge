# SvelteKit + Ash deployment

The public HTTP application is the **compiled SvelteKit Node adapter**. Ash/Bandit is a private API on port 4000, with PostgreSQL and Plaid credentials available only to that process. SvelteKit receives only `BRIDGE_API_ORIGIN`, its own listener settings and the public build origin. Keep the API listener on loopback or a private container network; never publish it on an Internet-facing port.

## Quick start

Use Node 24, Elixir 1.19/OTP 27 and PostgreSQL 16. Export the secrets from `.env.example` into the **Ash process environment**, and set `PUBLIC_URL=http://localhost:3000`. `DATA_KEY` and `SESSION_KEY` must be distinct 32-byte keys, and the password must be at least 16 bytes. Mix and the production Node adapter do not automatically read `.env`.

```sh
# Build the public application with the exact browser origin.
npm ci --prefix frontend --ignore-scripts
npm run check --prefix frontend
PUBLIC_URL=http://localhost:3000 npm run build --prefix frontend

# Create/migrate the Ash ledger, then start the private API.
mix deps.get --check-locked
mix ecto.create
mix ecto.migrate
BRIDGE_API_HOST=127.0.0.1 BRIDGE_API_PORT=4000 mix run --no-halt
```

In a second terminal, start the actual production frontend:

```sh
BRIDGE_API_ORIGIN=http://127.0.0.1:4000 HOST=127.0.0.1 PORT=3000 npm start --prefix frontend
```

Visit `http://localhost:3000`. Sign-in, filters, manual refresh and logout use native forms. SSE and connecting/reconnecting a bank use the small enhancement script. Public snapshot fields ending in `_cents` are decimal strings (or null), preserving exact cents across JSON/JavaScript. Accounting remains integer-based in Elixir. SSR and refresh fragments use the same Svelte financial components; there is no template-placeholder substitution or Svelte hydration.

For UI development, `npm run dev --prefix frontend -- --port 3000` uses the same private API. Live Plaid Link requires separate developer Sandbox credentials; ChatGPT's connected financial accounts do not supply them.

## Small private HTTPS deployment

1. Use a private host with PostgreSQL and two supervised processes: an Elixir release for Ash and `node frontend/build` for SvelteKit. Run them under a non-root service account. The repository does not create or modify a deployment automatically.
2. Set the final `PUBLIC_URL=https://your-private-host.example` **before building SvelteKit** and in Ash's runtime environment. SvelteKit 3 fixes its canonical origin through `paths.origin` at build time; changing the site origin requires a rebuild. Ash checks the original browser `Origin` against that same value. Do not disable SvelteKit's CSRF checks.
3. Run migrations once with the production database URL before starting the new release (`MIX_ENV=prod mix ecto.migrate`, or an equivalent release migration task). Back up the database and stable encryption key first. Existing SQLite data requires the separately validated import described in the README; this change does not import it.
4. Bind the SvelteKit listener to loopback and put a TLS reverse proxy in front of it. Forward **all** public paths to SvelteKit. It owns `/`, `/fragment`, `/login`, `/logout`, `/sync`, `/healthz` and the explicit `/api/*` routes. The gateway preserves cookies, the browser's `Origin`, CSRF and Plaid verification headers, raw webhook bytes, redirects and status codes. Only Ash validates sessions or holds Plaid access tokens.
5. Disable proxy response buffering/compression for `/api/events`, and allow an idle time above Ash's 15-second heartbeat. Forward streaming responses immediately. The Node gateway forwards backpressure and cancellation; SSE reconnects request a complete fresh snapshot, so there is no financial-event replay dependency.
6. Restrict access at the network/TLS layer as appropriate for a single-owner financial dashboard. Check `/healthz`, login/logout, cookie flags, an SSE disconnect/reconnect and a graceful restart before accepting the deployment.

A minimal Nginx location configuration, inside the TLS virtual host:

```nginx
location /api/events {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 60s;
}
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    client_max_body_size 128k;
}
```

Use `Referrer-Policy: same-origin` on HTML. `no-referrer` makes Chromium send `Origin: null` on native form navigation, which correctly fails the exact-Origin CSRF check. The same-origin policy preserves form authentication and sends no referrer to external sites.

The configured canonical origin is used instead of trusting forwarded host/protocol headers. SvelteKit passes no `X-Forwarded-For` identity to Ash. The existing Ash login limiter therefore applies to the gateway's actual peer address and aggregates login attempts through that gateway. This is deliberately stricter for this single-owner deployment; configure additional edge rate limits if needed. Arbitrary browser forwarding headers cannot bypass it. Do not expose the private API directly to avoid splitting that limit across entry points.

The frontend request ceiling is 128 KiB; set `BODY_SIZE_LIMIT=128K` on Node and a matching edge limit. The server also checks the body before forwarding. Webhooks pass through byte-for-byte; they do not require a browser Origin/session, but Ash still requires its ES256 signature, key/time checks and exact raw-body hash.

## Reproducible verification

```sh
npm run check --prefix frontend
npm run build:test --prefix frontend
npm run test:integration --prefix frontend
npm exec --prefix frontend -- playwright install chromium
npm run test:browser --prefix frontend
npm audit --prefix frontend --audit-level=moderate
MIX_ENV=test mix test
# Full browser integration with a real Ash process and an isolated disposable DB:
DATABASE_URL=ecto://postgres:postgres@localhost/bridge_browser_test MIX_ENV=test mix ecto.create
DATABASE_URL=ecto://postgres:postgres@localhost/bridge_browser_test MIX_ENV=test mix ecto.migrate
DATABASE_URL=ecto://postgres:postgres@localhost/bridge_browser_test npm run test:browser:ash --prefix frontend
python3 scripts/check_formal.py
```

The HTTP and browser contract tests run the compiled Node adapter with a deterministic HTTP backend fixture. They exercise real browser forms, cookies, no-JavaScript rendering, escaping, lazy Plaid SDK loading, update mode, exchange, SDK failure/retry, SSE cancellation/reconnection and fragment updates. The Plaid SDK is intercepted in browser tests. These checks do **not** constitute Plaid Sandbox acceptance or an end-to-end test of the Ash process; the separate PostgreSQL-backed ExUnit/conformance suite checks that backend.

The additional `test:browser:ash` suite runs the same Node build against a real Bandit/Ash process and PostgreSQL, with only the outbound Plaid transport and browser SDK replaced by deterministic fixtures. It exercises signed sessions, encrypted access-token storage, Link/exchange/update mode, post-commit SSE, account-ID replacement without doubled balances, retained historical transactions and logout while the stream is open. Its opt-in fixture refuses to start outside `MIX_ENV=test` or without the specifically named disposable `bridge_browser_test` database; it has no production route registration.

CI runs all three suites. Never use `build:test` output as a production artifact: it embeds the test origin `http://127.0.0.1:3173`. Build again with the production `PUBLIC_URL`. `npm run build` outputs `frontend/build`; run that directory with Node plus `frontend/package.json` (type=module). All server dependencies in this package are bundled by the adapter; Plaid/ledger secrets belong only in Ash.

## Plaid Sandbox acceptance still required

Record the test time, revision, institution, sanitized Item IDs and observed outcomes for: Link open/cancel/success; public-token exchange; first snapshot and transactions; two Items; repeated sync; update-mode relink without exchange; signed webhook acceptance/rejection; logout while SSE is open; reconnect and complete dashboard refetch. Do not record access/public tokens, credentials, session cookies or verification JWTs. Automated fixtures are not provider evidence.

The existing formal reconciliation safety scope, durable-job and operational gates remain as documented in `formal/README.md` and the README. No production deployment or live Plaid flow is claimed by this implementation.

Official references: [SvelteKit routing](https://svelte.dev/docs/kit/routing), [Node adapter](https://svelte.dev/docs/kit/adapter-node), [page options](https://svelte.dev/docs/kit/page-options).
