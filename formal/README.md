# Reconciliation specification and assurance boundary

This is an executable TLA+ safety specification, checked with TLC. It is a finite model check, **not a machine-checked proof of the Elixir program or of production readiness**. It adds no browser dependencies or JavaScript.

## Contract

For an Item `i`, let `S` be a complete validated account snapshot, `A` the transaction additions and `R` the explicit transaction removals. The atomic abstract transition is:

- `active'[i] = S`
- `history'[i] = (history[i] − R) ∪ A`
- `cursor'[i] = next_cursor`
- For every `j ≠ i`, `ledger'[j] = ledger[j]`.

Here each transaction identity has a fixed account association. Account disappearance does not remove transactions; only an explicit transaction removal does. A returning account may become active again. A replacement account identifier remains distinct. Replaying identical account/transaction inputs is idempotent in membership; cursor and observation timestamps need not be identical.

`Reconciliation.tla` separates the public ledger `db`, private transaction state `before`/`staged`, and the abstract committed ledger `specDB`. Two workers may interleave fetch, private writes, failure, commit and notification. The same Item must remain locked from before fetch until commit or rollback. Different Items may proceed concurrently. Failure before or after staging discards private state. A notification follows commit and contains no financial record in this abstraction.

## Checked properties and implementation correspondence

| Formal check | Meaning | Implementation / executable evidence |
| --- | --- | --- |
| `TypeOK` | Every reachable state has the declared types | Ash resource schemas; snapshot/page validation tests |
| `ActiveMatchesSnapshot` | Visible membership equals the last committed complete snapshot | `Store.reconcile_accounts!`; removal, empty, replacement, repeated-sync tests; 216 request sequences |
| `HistoryMatchesSync` | Account churn preserves history; explicit transaction removals remain effective | `Store.apply_pages!`; historical, pending/posted, repeated-removal tests; sequence oracle |
| `CursorAtomic` | The visible cursor never advances ahead of the abstract commit | `Store.commit_refresh!` inside `with_item_lock`; late-failure rollback and private-write visibility tests |
| `ItemIsolation` | A commit cannot change another Item | Composite resource keys, scoped queries; overlapping-ID regressions and sequence frame checks |
| `PerItemMutex` | At most one worker fetches/stages a given Item | PostgreSQL transaction advisory lock; separate-connection test observes an actual ungranted `pg_locks` advisory lock |
| `NoEarlyNotification` | No success invalidation is emitted before commit | `Sync.run` calls `Events.publish` after `with_item_lock`; reviewed correspondence, not a runtime trace proof |
| `NoObsoleteBalances` | Unit-balance aggregate uses exactly current membership | `Snapshot.build` active-account projection; sequence tests also use unequal real cent amounts |

`specDB` provides a separate atomic transition against which staged writes are compared; it is not copied from the implementation's staged result. `db = specDB` is decomposed into membership, history and cursor checks. This is a model-level refinement argument. No source-to-model refinement theorem has been established.

## Finite scope and assumptions

The checked configuration contains **2 Items, 2 workers, 2 account identities and 6 request shapes**: old, replacement, both, empty, explicit historical removal, and a transaction arriving for an absent account. The same account/transaction identifiers can occur in different Items. TLC explores the complete reachable finite graph, including cycles and repeated synchronizations; there is no trace-depth cutoff or symmetry reduction.

Each account represents one fixed transaction identity; amounts are unit weights; cursor values are a two-value parity abstraction. This checks atomic visibility, not cursor ordering, pagination content, arbitrary monetary arithmetic, FX or large/unbounded identity spaces. Pending-to-posted replacement, payload validation and pagination restart are covered by implementation regressions, not this model.

The model assumes complete, Item-matched input; authorized internal callers; PostgreSQL transactional isolation/rollback; and the advisory lock covering fetch plus commit. The implementation tests discharge specific examples of those assumptions, not a universal proof. Cryptographic algorithms, session authorization, SSE delivery/reconnect, the memory work queue, external Plaid behavior and legacy import are outside the formal model. Failure/status invalidations are not success ledger commits.

This is a **safety** check. No fairness or liveness claim is made: arbitrary failures, process loss or unavailable providers can prevent eventual synchronization. Transaction crashes are abstracted as rollback; a crash after commit but before notification can lose an invalidation. Durable jobs/recovery and operational acceptance remain separate gates.

## Reproduction and negative controls

```sh
python3 scripts/check_formal.py
# Optional already-downloaded artifact; the same SHA-256 is still mandatory:
TLA2TOOLS_JAR=/path/to/tla2tools.jar python3 scripts/check_formal.py
```

Requires Python 3 and Java (validated locally on Java 17). The runner downloads the fixed upstream **TLA+ 1.7.4** release and checks SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` before execution. The downloaded release also matched the SHA-1 published in its upstream release notes. There is no nightly/latest fallback and no skipped-success path for missing tooling or network failure.

The positive run must finish with exit 0, TLC's successful-completion marker, and an empty state queue. Each negative control must produce exit 12, a counterexample trace, and the **specific named invariant violation** below. A parse error, unrelated violation, timeout, or absent tool fails the gate.

| Injected defect | Required counterexample |
| --- | --- |
| Union old accounts with the incoming snapshot (original P1) | `ActiveMatchesSnapshot` |
| Cascade history deletion when an account disappears | `HistoryMatchesSync` |
| Write one Item's refresh into every Item | `ItemIsolation` |
| Publish a cursor during private staging | `CursorAtomic` |
| Permit overlapping workers for one Item | `PerItemMutex` |
| Emit a success notification during staging | `NoEarlyNotification` |

The runner writes logs (including counterexamples), input/tool hashes and state counts under `_build/formal/`. CI executes the same runner in the `formal` job and uploads its evidence even on failure. `evidence.json` records the checked local run; fresh CI output is the authority for a changed head.

The PostgreSQL suite additionally executes every length-three sequence over the six request shapes (**216 sequences / 648 refreshes**) against an independent set-based oracle. A second test uses independently checked-out database connections, verifies private writes are invisible, observes same-Item lock waiting, allows another Item to commit, then checks that the waiting worker reads the preceding committed cursor/history. These strengthen implementation correspondence; neither exhaustive short traces nor a scheduled concurrency example is an unbounded implementation proof.

## Sources

- [TLA+ model checking](https://nightly.tlapl.us/doc/model/model.html)
- [TLC configuration](https://docs.tlapl.us/using:tlc:config_file)
- [Pinned upstream release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)
