# The Bridge — private financial dashboard

A self-hosted **Server-Sent Events (SSE)** financial dashboard backed by a **direct Plaid integration**. The first slice is deliberately single-owner, read-only and deployable in Plaid Sandbox. It exposes no transfer, payment-initiation or trading functionality.

The Bridge does **not** reuse the Plaid connection established inside ChatGPT Finances. A separate Plaid Link authorization is required for this app. Never put Plaid secrets, bank access tokens, copied transactions or live financial records into this public repository.

## Capabilities

- Plaid Link creates a connection; the backend exchanges public tokens for server-only access tokens.
- Access tokens are encrypted with AES-256-GCM in a local SQLite database. Secrets never reach the frontend or SSE payloads.
- Transaction updates use Plaid's cursor-based Transactions Sync API (added, modified and removed transactions). All pages commit atomically. Pagination mutation restarts at the original cursor.
- Signed Plaid webhooks are validated against Plaid verification keys, the JWT signature, a five-minute age window, and an exact SHA-256 of the incoming raw body.
- Latest available checking/savings and credit-card balance snapshots, categorized monthly spending, a six-month trend, account filters, merchant search and a posted/pending transaction table.
- SSE at GET /api/events informs authenticated browser clients that a refresh is available; clients then fetch GET /api/snapshot. Heartbeats and native EventSource reconnection work without polling the browser.
- Single-owner password sign-in, HMAC-signed HTTP-only sessions, CSRF protection, strict same-site cookies, basic login throttling and a restrictive Content Security Policy.
- Tests cover encryption, authentication primitives, transaction idempotency, database rollback, pagination-mutation recovery and signed webhooks.

**Scope limits:** This is an initial audited-code candidate, not an approved production deployment. Spending excludes Plaid transactions categorized as income, recognized transfers and loan payments, and excludes pending transactions. Net spending includes refunds. The balance card shows checking/savings snapshots less reported credit-card balances; it is **not** net worth, live available cash, or affordability advice. The snapshot can be incomplete when the bank or Plaid has not returned a balance. No exchange-rate conversion is provided. Prior to production use, restrict the connected accounts to USD or implement currency partitioning.

## Local quickstart (Sandbox)

Requires **Node.js 22.13+** (tested by CI with Node 22.16; uses the built-in node:sqlite module). No npm dependencies are required.

1. Copy **.env.example** to **.env**.
2. Create a Plaid developer account and put your **Sandbox** PLAID_CLIENT_ID and PLAID_SECRET in .env.
3. Set DASHBOARD_PASSWORD to a long unique passphrase (at least 16 characters).
4. Generate **two different** cryptographic keys, one for SESSION_KEY and one for DATA_KEY, with:

   ~~~sh
   openssl rand -hex 32
   openssl rand -hex 32
   ~~~

5. Start the app:

   ~~~sh
   node --env-file=.env src/server.mjs
   ~~~

6. Open **http://localhost:3000**, sign in with the passphrase, and click **Connect bank** to complete Plaid Link. Use Plaid Sandbox institutions/test credentials; do not connect live bank accounts while evaluating the first slice.

For automated tests:

~~~sh
npm run check
npm test
~~~

**Environment configuration:**

| Variable | Purpose |
| --- | --- |
| PLAID_ENV | sandbox (default) or production |
| PLAID_CLIENT_ID / PLAID_SECRET | Server-side Plaid API credentials |
| DASHBOARD_PASSWORD | Single-owner login secret, minimum 16 characters |
| SESSION_KEY / DATA_KEY | Distinct 32-byte cryptographic keys encoded in hex |
| DB_PATH | SQLite database path (default ./data/bridge.sqlite, ignored by Git) |
| PORT | Listening TCP port (default 3000) |
| PUBLIC_URL | Public HTTPS origin, required in production; used for Plaid webhooks and origin checks |
| PLAID_REDIRECT_URI | Optional registered redirect URL for future OAuth flow support |

## HTTP and SSE surface

| Endpoint | Method | Access | Purpose |
| --- | --- | --- | --- |
| / | GET | Public | UI shell |
| /healthz | GET | Public | Health check only; no bank data |
| /api/login | POST | Public, origin checked | Owner session |
| /api/session | GET | Any | Authenticated state and session-scoped CSRF token |
| /api/logout | POST | Owner + CSRF | Clear session cookie |
| /api/plaid/link-token | POST | Owner + CSRF | Create initial/update Plaid Link token |
| /api/plaid/exchange | POST | Owner + CSRF | Exchange public token, encrypt access token |
| /api/snapshot | GET | Owner | Accounts, selected-month spending, trend and transactions |
| /api/sync | POST | Owner + CSRF | Pull latest available Plaid balances and transaction updates |
| /api/events | GET | Owner | SSE refresh notifications (no account data in events) |
| /api/plaid/webhook | POST | Valid signed Plaid webhook | Schedule an incremental pull |

POST requests from the browser require the expected same-origin Origin header. All authenticated POST requests also require an X-CSRF-Token header derived from the active signed session. EventSource uses the session cookie, and stream connections expire with the session. The Link browser SDK is loaded from the official Plaid CDN.

## Operational architecture

The server requests a Plaid link_token and sends it to the browser. Plaid Link returns a short-lived public_token. The server exchanges it once for an access_token and persists that token only as AES-256-GCM ciphertext. The server obtains account snapshots and paginated transaction changes using that token. A SQLite transaction applies each group of changes and its cursor together. Changes emit an SSE invalidation to authenticated clients, which retrieve the latest snapshot over HTTP.

Plaid is not a continuous push stream of bank account activity. Plaid ingests financial-institution updates on its own schedule. A signed SYNC_UPDATES_AVAILABLE webhook or a user-triggered update prompts the server to pull what Plaid currently has. The server also checks on startup and every 15 minutes to recover from missed webhook notices. Because this slice does not yet have a durable job queue, a server interruption can defer updates until the next scheduled check; the persisted cursor prevents missing committed changes.

**Security requirements for any public deployment:** use TLS termination and a dedicated host, encrypted persistent storage and backups for the SQLite file, protected environment secrets, filesystem permissions, process isolation, restricted inbound traffic and access logs without credentials or financial payloads. Preserve DATA_KEY across restarts: losing it makes the saved Plaid tokens undecryptable. Do not rotate keys by simply changing environment variables. This is a single-owner application; do not publish to multiple users without per-user authorization boundaries, separate Plaid Items and a security review.

## Explicit follow-on gates

1. Run the full tests under CI and conduct a security review (CSRF, login throttling behind proxies, session lifetime, key rotation, backup/deletion, webhook durability, dependency freshness and Plaid terms).
2. Provide a supported OAuth redirect/resume flow for institutions that require OAuth. The optional redirect URI variable by itself does not complete that workflow.
3. Build a durable webhook queue with retry/backoff and a migration framework before production, plus connection removal and access-token revocation.
4. Add currency-aware aggregation, optional investments/liabilities/recurring product scopes, multi-owner identities and a transaction drilldown with pagination only after separate acceptance criteria.
5. Add deployment/reverse-proxy examples and verify real Sandbox Link and webhook delivery end-to-end with operator-supplied Plaid credentials.

### References

- Plaid Link API: https://plaid.com/docs/api/link/
- Transactions Sync API: https://plaid.com/docs/api/products/transactions/
- Plaid Transactions webhooks: https://plaid.com/docs/transactions/webhooks/
- Plaid signed webhook verification: https://plaid.com/docs/api/webhooks/webhook-verification/
