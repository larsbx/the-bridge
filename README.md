# The Bridge

Private, single-owner, read-only Plaid dashboard built with **Elixir, Ash 3, AshPostgres and SvelteKit**. PostgreSQL stores the ledger. The compiled SvelteKit Node adapter serves the public application; Bandit/Plug serves the private Ash API. [Quick start and deployment](docs/deployment.md).

## Browser budget

SvelteKit renders authenticated pages and refresh fragments at request time with `prerender = false` and **`csr = false`**. Shared Svelte components render the dashboard from the authenticated Ash snapshot API. Forms, filters and existing financial views work without JavaScript. Accounting and authorization stay in Ash; financial HTML stays on the server.

The only first-party browser script progressively adds SSE invalidation/refetch and Plaid Link. The build enforces a **2 KiB gzip budget** and rejects accidental Svelte hydration. There is no chart library, client store, browser financial cache, service worker or client-side accounting. Charts use native HTML progress elements with explicit numeric values. Plaid's third-party SDK is fetched only after Connect/Reconnect is clicked; its size is outside our budget.

## Reconciliation contract

Each refresh consumes an **unfiltered, complete `/accounts/get` response** whose Item ID matches the requested Item. A missing/null/malformed account array, duplicate identifier, mismatched Item or failed API response is an error, never an empty snapshot. The request deliberately sends no account-ID selection options.

A PostgreSQL transaction-scoped advisory lock serializes the fetch and commit for an Item, including across application instances. Account reconciliation, all transaction pages and the final cursor commit together. A failed validation or write rolls everything back. Reads use a repeatable-read snapshot so the dashboard cannot combine portions of two committed refreshes.

- Present accounts are inserted/updated and marked active.
- Previously active accounts absent from a complete snapshot become inactive with `removed_at`; an empty array retires all accounts for that Item.
- Current cards and USD balance totals include **active accounts only**.
- Account rows and their transactions are retained. Historical transactions remain searchable, appear with a historical label and remain in spending calculations.
- A new account ID is treated as a new identity. The application does not guess identity equivalence or reassign old transactions. Reappearance of the same ID reactivates its account.
- Both account and transaction primary keys include `item_id`. One Item's snapshot, pending replacement or removal cannot alter another Item's records.
- Repeated snapshots do not duplicate balances or transactions, and repeated absence preserves the original removal timestamp.
- Plaid's explicit transaction removals still remove those transaction records, including historical ones. Pending-to-posted replacement remains Item-scoped.

Account churn alone cannot prove duplicate transaction identity. Cross-ID/cross-Item transaction deduplication and detecting separately linked duplicates require a separate reconciliation policy; no unsupported matching is applied here.

## Security boundaries

Ash resources require authorization by default. Only the server's sync principal can mutate financial resources; the authenticated owner can read. HTTP bodies cannot supply actor roles. Responses project explicit public fields, never token ciphertext or plaintext. AES-256-GCM access tokens stay server-side. The versioned ciphertext format remains compatible with the old token encoding, but this does not constitute a database migration.

Sessions are HMAC-signed, 12-hour, HttpOnly, SameSite=Strict cookies with server-side hashed session records and revocation. HTTPS enables Secure cookies. Mutations require an exact configured Origin plus session-bound CSRF protection. Login attempts are serialized and rate-limited by the actual API peer address (the SvelteKit gateway in this deployment); browser forwarding headers are dropped. Attempts through one gateway share its limit. Password comparisons use PBKDF2-HMAC-SHA256 and constant-time comparison. The single-owner password is an environment secret, not a multi-user identity system.

SSE carries only refresh/sign-out notifications. Streams recheck session validity on updates and heartbeats, and close on logout/expiry. Financial HTML and API responses are `no-store`. CSP allows only self-hosted scripts and Plaid's official CDN; HTML data is escaped. Provider payloads, credentials and changesets are not logged by application error handlers.

Plaid webhooks require ES256/P-256 signature verification, a matching non-expired verification key, a five-minute issue-time window and an exact SHA-256 of the raw body. Transaction pagination mutation discards every collected page and retries from the original committed cursor, with bounded retries/pages. Failed pulls retain previous data and mark the Item for attention.

## Local Sandbox setup

Requirements: Elixir 1.19 / OTP 27, PostgreSQL 16, and Node 24 for the SvelteKit build and runtime. Dependencies are locked in `mix.lock` and `frontend/package-lock.json`.

1. Export the variables listed in `.env.example` through your secret manager or local shell. Mix does not automatically load `.env`.
2. Supply separate Plaid **Sandbox** credentials. ChatGPT's Finances connection does not transfer credentials to this app.
3. Generate two distinct keys with `openssl rand -hex 32`; keep `DATA_KEY` stable across restarts. Set a unique password of at least 16 characters.
4. Build and start:

```sh
npm ci --prefix frontend --ignore-scripts
npm run check --prefix frontend
PUBLIC_URL=http://localhost:3000 npm run build --prefix frontend
mix deps.get --check-locked
mix ecto.create
mix ecto.migrate
BRIDGE_API_HOST=127.0.0.1 BRIDGE_API_PORT=4000 mix run --no-halt
```

In a second terminal:

```sh
BRIDGE_API_ORIGIN=http://127.0.0.1:4000 HOST=127.0.0.1 PORT=3000 npm start --prefix frontend
```

Build SvelteKit with the same `PUBLIC_URL` used by Ash (a changed origin requires a rebuild). Open the configured `PUBLIC_URL` (default `http://localhost:3000`). Sign in and connect a Sandbox institution. `PUBLIC_URL` is a fixed origin, not derived from an incoming Host header. Bind to loopback by default. For deployment, use HTTPS with an appropriately configured reverse proxy, secret management, encrypted database storage/backups and restricted network access. `MIX_ENV=prod` requires an HTTPS origin.

## Verification

```sh
MIX_ENV=test mix compile --warnings-as-errors
MIX_ENV=test mix format --check-formatted
MIX_ENV=test mix hex.audit
npm audit --prefix frontend --audit-level=moderate
npm run build:test --prefix frontend
npm run test:integration --prefix frontend
npm exec --prefix frontend -- playwright install chromium
npm run test:browser --prefix frontend
MIX_ENV=test mix ecto.create
MIX_ENV=test mix ecto.migrate
MIX_ENV=test mix test
# Crypto, webhook and parsing checks without PostgreSQL:
MIX_ENV=test mix test --no-start test/unit
```

The Ash suite uses PostgreSQL, not an in-memory substitute. The additional production-Node HTTP/browser contract tests use an explicit deterministic backend fixture and intercepted Plaid SDK; see the deployment guide for their boundaries. CI provides a separate PostgreSQL 16 service. See `docs/sveltekit-validation.md` for actual executed evidence and remaining gates. A successful source build alone does not establish production readiness.

## Formal methods

The [TLA+ reconciliation specification](formal/README.md) checks concurrent refresh safety with a pinned TLC toolchain, six counterexample controls and a dedicated CI gate. PostgreSQL model-conformance tests connect the abstract contract to real resource writes and advisory locks. The scope and assumptions are explicit: finite model checking is not a proof of the deployed application.

```sh
python3 scripts/check_formal.py
```

## Existing SQLite data

This PR changes the persistence engine. **No automatic SQLite-to-PostgreSQL import is implemented.** Existing SQLite files are neither opened nor deleted by the Elixir application. Back up the file and its `DATA_KEY`; do not relink and discard the old ledger as a substitute for migration. If a prior prototype has real or valuable data, an explicitly validated import of Items, accounts, transactions and cursors is an acceptance gate before cutover. Sessions should be reissued. Test historical preservation here concerns records in the new PostgreSQL ledger, not an unexecuted legacy import.

## Remaining acceptance gates

This is a review candidate, **not production-ready**. Require green PostgreSQL integration CI, security review and actual Plaid Sandbox evidence (Link, exchange, two Items, repeated sync, signed webhook delivery and relink). Account-ID churn should also be exercised with deterministic fixtures because Sandbox does not guarantee it can simulate every bank behavior.

OAuth redirect/resume, durable sync jobs with retry/backoff, connection removal/token revocation, key rotation, session cleanup, operational recovery, legacy import when applicable and broader deployment controls remain follow-up gates. The current supervised work queue is in memory; startup/15-minute polling recovers missed notices. Long-running pulls occupy a database connection while holding the Item lock; load testing and a durable queue are required before scaling beyond the private single-owner scope.

USD aggregates exclude unknown/non-USD currencies; no FX conversion is performed. Spending excludes recognized income/transfers/loan payments and pending transactions, and includes refunds. Balances are latest snapshots, not live available funds, total net worth or affordability advice. There are no payment, transfer or trading endpoints.

## References

- [Plaid account snapshots](https://plaid.com/docs/api/accounts/)
- [Plaid transaction sync](https://plaid.com/docs/api/products/transactions/)
- [Plaid webhook verification](https://plaid.com/docs/api/webhooks/webhook-verification/)
- [SvelteKit page options](https://svelte.dev/docs/kit/page-options)
- [Ash policies](https://ash.hexdocs.pm/policies.html)
