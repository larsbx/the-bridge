# Validation record — 2026-10-21

This change updates PR #1 from inspected head `4b681cdb3ada8e9370dcd4d47046de94f7f34e31`. It replaces the Node/SQLite implementation with Elixir/Ash/PostgreSQL and a SvelteKit-built, non-hydrated page shell.

## Executed locally

| Check | Evidence |
| --- | --- |
| Previous Node implementation | All 7 original tests passed on Node 24.19.0 before replacement. This is baseline evidence only. |
| Elixir build | Clean/forced compilation with `--warnings-as-errors` passed on Elixir 1.19.0 / OTP 27.3.4; a subsequent incremental compile also passed. |
| Formatting | `MIX_ENV=test mix format --check-formatted` passed. |
| Schema drift | `MIX_ENV=test mix ash_postgres.generate_migrations --check` passed against the committed resource snapshots. Generated migrations were inspected; this is not evidence that they have executed against PostgreSQL. |
| Unit/security tests | `MIX_ENV=test mix test --no-start test/unit`: 12 tests, 0 failures. |
| SvelteKit | Production static build and `svelte-check` passed with 0 errors and 0 warnings. |
| Browser JavaScript | 1,349 bytes gzip for the first-party enhancement; enforced ceiling 2,048 bytes. Generated HTML loads no Svelte hydration bundle. The third-party Plaid SDK is loaded on demand and excluded from this figure. |
| npm audit | 0 vulnerabilities across the locked frontend dependency tree. |
| Hex release verification | All 35 locked archives match Hex release checksums; no retirement or published security-advisory entries. See `security-audit-2026-10-21.json`. |
| `mix hex.audit` | Printed no retired/advisory packages, but registry requests failed through this runner's proxy. This command alone is **inconclusive** here; the independent release-API checks above retrieved and validated every package's metadata. CI also runs a fail-closed API audit. |

The 12 executed tests cover AES-GCM tamper detection, session signatures/expiry/CSRF, password comparison, HTML escaping, pagination-mutation restart, malformed/nonadvancing pagination, complete-snapshot validation, signed webhook body/signature/key/time checks, unauthenticated private-route/SSE access, forged cookies, rejected origins, unsigned webhooks and the non-hydrated login shell.

## Not yet executed

- **PostgreSQL integration:** the runner has PostgreSQL binaries but cannot switch to an unprivileged OS user. Starting a dedicated instance failed, and its escalation policy rejected the requested unprivileged launch. No PostgreSQL service or credentials were supplied. The committed tests require PostgreSQL and are not silently skipped or replaced by an in-memory data layer.
- **Live Plaid Sandbox:** no Plaid credentials were present. Browser Link, token exchange, Item relinking, provider-delivered signed webhooks and actual Sandbox transaction flows remain unexecuted.
- **Browser end-to-end:** the static build and security checks are not a substitute for a full browser walkthrough against the running backend.
- **Legacy SQLite import:** not implemented or executed. Existing files are preserved on disk; no claim is made that their records have moved into PostgreSQL.

## PostgreSQL regressions committed for CI

The reconciliation suite exercises account removal; account-ID replacement without doubled balances; empty complete snapshots; overlapping account IDs across two linked Items; retained, labeled historical transactions; repeated sync and reactivation; rollback of accounts, transactions and cursor after a late transaction failure; rejection of malformed/duplicate/wrong-Item snapshots; pending-to-posted replacement and explicit transaction removals on historical accounts; and Ash read/write authorization.

The HTTP integration suite exercises valid session reads, CSRF and fixed-Origin checks, logout revocation including SSE access, escaping of stored financial strings, no-store responses, native HTML form login/logout and rejection of unsigned webhooks. CI supplies PostgreSQL 16 and builds the actual SvelteKit shell before running these tests.

## Acceptance

Keep this PR as a draft until the PostgreSQL/HTTP integration suite and review pass. Do not treat compilation, the unit suite, or static assets as production acceptance. Before production, also require the Sandbox evidence, OAuth redirect/resume, durable sync work, token revocation/removal, key/session lifecycle controls, recovery/load testing and any needed legacy-data import described in the README.
