# Historical Ash/reconciliation validation — 2026-10-21

The current request-time Node-adapter implementation and its evidence are recorded in [SvelteKit validation](sveltekit-validation.md). The static-build results below describe merged PR #1 and are retained as historical baseline evidence.

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

## Executed in GitHub Actions

[Run 39656851082](https://github.com/larsbx/the-bridge/actions/runs/39656851082) passed on application commit `8cad54d548fb0eae846cd41dd8892fc6a8750b47`:

- PostgreSQL 16 database creation and all migrations succeeded.
- Full ExUnit suite: **24 tests, 0 failures**, including all reconciliation and HTTP integration regressions below.
- Compilation with warnings as errors, formatting and Ash migration drift checks passed.
- Both Hex audit checks passed; all 35 locked package checksums and retirement/advisory metadata were verified.
- Frontend type checks, static build, npm audit (0 vulnerabilities), and the browser budget passed: **1,349 bytes gzip**, no Svelte hydration.

The first database run exposed Ash's default missing-record exception behavior. Lookups that intentionally allow absence now explicitly use `not_found_error?: false` for first-time Item linking, revoked sessions and repeated transaction removals. The passing rerun includes repeated removal coverage. This correction does not suppress authorization or other database errors.

## Not yet executed

- **Local PostgreSQL execution:** the local runner could not switch to an unprivileged OS user, and its escalation policy rejected the requested launch. The full database suite instead executed successfully in GitHub Actions; it was not skipped or replaced by an in-memory data layer.
- **Live Plaid Sandbox:** no Plaid credentials were present. Browser Link, token exchange, Item relinking, provider-delivered signed webhooks and actual Sandbox transaction flows remain unexecuted.
- **Browser end-to-end:** the static build and security checks are not a substitute for a full browser walkthrough against the running backend.
- **Legacy SQLite import:** not implemented or executed. Existing files are preserved on disk; no claim is made that their records have moved into PostgreSQL.

## PostgreSQL regressions committed for CI

The reconciliation suite exercises account removal; account-ID replacement without doubled balances; empty complete snapshots; overlapping account IDs across two linked Items; retained, labeled historical transactions; repeated sync and reactivation; rollback of accounts, transactions and cursor after a late transaction failure; rejection of malformed/duplicate/wrong-Item snapshots; pending-to-posted replacement and explicit transaction removals on historical accounts; and Ash read/write authorization.

The HTTP integration suite exercises valid session reads, CSRF and fixed-Origin checks, logout revocation including SSE access, escaping of stored financial strings, no-store responses, native HTML form login/logout and rejection of unsigned webhooks. CI supplies PostgreSQL 16 and builds the actual SvelteKit shell before running these tests.

## Formal reconciliation checks

The [formal specification and correspondence map](../formal/README.md) now define the reconciliation safety contract. The pinned TLC 1.7.4 run completed locally with **142,884 distinct reachable states** and no invariant violations. All six deliberately broken variants produced the required named invariant violation and a counterexample; parser errors and timeouts are rejected. Tool/input hashes and exact counts are recorded in `formal/evidence.json`.

[Run 39662433777](https://github.com/larsbx/the-bridge/actions/runs/39662433777) passed both jobs on commit `5be28522a1e4d141318c3c43c05dc74f2e91d73d`:

- `formal`: 142,884 reachable states checked; all six negative controls produced their required counterexamples. Eight evidence files were uploaded as `reconciliation-model-evidence`.
- `test`: **26 tests, 0 failures** in 6.7 seconds, including all 216 length-three model request sequences (648 refreshes) and the real separate-connection lock-wait/private-write visibility test.
- Compilation, formatting, schema drift, migrations, frontend checks, JavaScript budget and dependency security checks passed again. First-party browser JavaScript remains 1,349 bytes gzip.

The local unit/security suite also passed (12 tests). Database execution used the CI PostgreSQL service because of the local runner restriction described above. This later record supersedes the earlier 24-test baseline for the expanded suite.

This is a finite safety model check and concrete implementation correspondence testing, not a verified compiler, an unbounded proof of the Elixir implementation, a liveness theorem, or live Plaid acceptance.

## Acceptance

The PostgreSQL/HTTP integration gate is now green. Keep this PR as a draft pending review and the remaining acceptance gates. Do not treat passing deterministic tests as production acceptance. Before production, also require the Sandbox evidence, OAuth redirect/resume, durable sync work, token revocation/removal, key/session lifecycle controls, recovery/load testing and any needed legacy-data import described in the README.
