--------------------------- MODULE Reconciliation ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Items, Workers, Old, New, Mutation
ASSUME /\ Items # {} /\ Workers # {} /\ Old # New
       /\ Mutation \in {"None", "StaleAccounts", "DeleteHistory", "CrossItem",
                        "EarlyCursor", "NoLock", "EarlyNotification"}
Accounts == {Old, New}
Empty == [active |-> {}, history |-> {}, cursor |-> 0]
DefaultItem == CHOOSE i \in Items : TRUE
EmptyRequest == [snapshot |-> {}, added |-> {}, removed |-> {}]
Requests == {
  EmptyRequest,
  [snapshot |-> {Old}, added |-> {Old}, removed |-> {}],
  [snapshot |-> {New}, added |-> {New}, removed |-> {}],
  [snapshot |-> Accounts, added |-> Accounts, removed |-> {}],
  [snapshot |-> {}, added |-> {}, removed |-> {Old}],
  [snapshot |-> {}, added |-> {Old}, removed |-> {}]
}
Ledger == [active : SUBSET Accounts, history : SUBSET Accounts, cursor : 0..1]
VARIABLES db, specDB, phase, item, request, before, staged, frameOK, earlyNotice
vars == <<db, specDB, phase, item, request, before, staged, frameOK, earlyNotice>>

\* specDB is the abstract atomic ledger. db is the externally visible concrete
\* ledger; before/staged are private transaction state. Transaction identifiers
\* are abstracted to one fixed transaction per account, not inferred identities.
Init ==
  /\ db = [i \in Items |-> Empty]
  /\ specDB = db
  /\ phase = [w \in Workers |-> "idle"]
  /\ item = [w \in Workers |-> DefaultItem]
  /\ request = [w \in Workers |-> EmptyRequest]
  /\ before = [w \in Workers |-> Empty]
  /\ staged = before
  /\ frameOK = TRUE
  /\ earlyNotice = FALSE

HoldsLock(w) == phase[w] \in {"fetched", "staged"}
Free(i) == ~\E w \in Workers : HoldsLock(w) /\ item[w] = i

\* A complete validated fetch is inside the Item lock, before any public write.
Begin(w, i, r) ==
  /\ phase[w] = "idle"
  /\ (Mutation = "NoLock" \/ Free(i))
  /\ phase' = [phase EXCEPT ![w] = "fetched"]
  /\ item' = [item EXCEPT ![w] = i]
  /\ request' = [request EXCEPT ![w] = r]
  /\ before' = [before EXCEPT ![w] = db[i]]
  /\ UNCHANGED <<db, specDB, staged, frameOK, earlyNotice>>

Stage(w) ==
  /\ phase[w] = "fetched"
  /\ LET r == request[w]
         b == before[w]
         history == (b.history \ r.removed) \cup r.added
     IN staged' = [staged EXCEPT ![w] =
          [active |-> IF Mutation = "StaleAccounts"
                      THEN b.active \cup r.snapshot ELSE r.snapshot,
           history |-> IF Mutation = "DeleteHistory"
                       THEN history \cap r.snapshot ELSE history,
           cursor |-> 1 - b.cursor]]
  /\ phase' = [phase EXCEPT ![w] = "staged"]
  /\ db' = IF Mutation = "EarlyCursor"
           THEN [db EXCEPT ![item[w]].cursor = 1 - before[w].cursor] ELSE db
  /\ earlyNotice' = (earlyNotice \/ Mutation = "EarlyNotification")
  /\ UNCHANGED <<specDB, item, request, before, frameOK>>

\* The reference transition is intentionally independent of staged/db writes.
AtomicSpec(i, r) ==
  [active |-> r.snapshot,
   history |-> (specDB[i].history \ r.removed) \cup r.added,
   cursor |-> 1 - specDB[i].cursor]

Commit(w) ==
  /\ phase[w] = "staged"
  /\ LET i == item[w]
         nextDB == IF Mutation = "CrossItem"
                   THEN [j \in Items |-> staged[w]]
                   ELSE [db EXCEPT ![i] = staged[w]]
     IN /\ db' = nextDB
        /\ specDB' = [specDB EXCEPT ![i] = AtomicSpec(i, request[w])]
        /\ frameOK' = \A j \in Items \ {i} : nextDB[j] = db[j]
  /\ phase' = [phase EXCEPT ![w] = "committed"]
  /\ request' = [request EXCEPT ![w] = EmptyRequest]
  /\ before' = [before EXCEPT ![w] = Empty]
  /\ staged' = [staged EXCEPT ![w] = Empty]
  /\ UNCHANGED <<item, earlyNotice>>

\* Release the worker after the post-commit invalidation; no financial payload.
Notify(w) ==
  /\ phase[w] = "committed"
  /\ phase' = [phase EXCEPT ![w] = "idle"]
  /\ item' = [item EXCEPT ![w] = DefaultItem]
  /\ UNCHANGED <<db, specDB, request, before, staged, frameOK, earlyNotice>>

\* Provider/validation/write failures may occur before or after private staging.
\* PostgreSQL rollback discards private writes without changing visible state.
Abort(w) ==
  /\ HoldsLock(w)
  /\ phase' = [phase EXCEPT ![w] = "idle"]
  /\ item' = [item EXCEPT ![w] = DefaultItem]
  /\ request' = [request EXCEPT ![w] = EmptyRequest]
  /\ before' = [before EXCEPT ![w] = Empty]
  /\ staged' = [staged EXCEPT ![w] = Empty]
  /\ UNCHANGED <<db, specDB, frameOK, earlyNotice>>

Next == \E w \in Workers :
          (\E i \in Items, r \in Requests : Begin(w, i, r))
          \/ Stage(w) \/ Commit(w) \/ Notify(w) \/ Abort(w)
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ db \in [Items -> Ledger] /\ specDB \in [Items -> Ledger]
  /\ phase \in [Workers -> {"idle", "fetched", "staged", "committed"}]
  /\ item \in [Workers -> Items] /\ request \in [Workers -> Requests]
  /\ before \in [Workers -> Ledger] /\ staged \in [Workers -> Ledger]
  /\ frameOK \in BOOLEAN /\ earlyNotice \in BOOLEAN
ActiveMatchesSnapshot == \A i \in Items : db[i].active = specDB[i].active
HistoryMatchesSync == \A i \in Items : db[i].history = specDB[i].history
CursorAtomic == \A i \in Items : db[i].cursor = specDB[i].cursor
ItemIsolation == frameOK
NoEarlyNotification == ~earlyNotice
PerItemMutex == \A x, y \in Workers :
  (HoldsLock(x) /\ HoldsLock(y) /\ item[x] = item[y]) => x = y
\* Unit balances give an explicit aggregate projection. Amounts/FX are outside
\* this model; exact active membership is stronger than its cardinality alone.
NoObsoleteBalances == \A i \in Items :
  Cardinality(db[i].active) = Cardinality(specDB[i].active)
=============================================================================
