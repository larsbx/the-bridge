defmodule Bridge.ReconciliationTest do
  use ExUnit.Case, async: false
  alias Bridge.{Store, Snapshot, Security}
  alias Bridge.Finance.{Account, Transaction, Item}
  @owner %Bridge.Actor{role: :owner}
  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Bridge.Repo, isolation: "REPEATABLE READ")
    Store.save_item("i1", "secret-one", "One")
    Store.save_item("i2", "secret-two", "Two")
    :ok
  end

  def account(id, amount \\ 100),
    do: %{
      "account_id" => id,
      "name" => id,
      "type" => "depository",
      "balances" => %{"current" => amount, "iso_currency_code" => "USD"}
    }

  def response(item, accounts), do: %{"item" => %{"item_id" => item}, "accounts" => accounts}

  def page(added \\ [], cursor \\ "c1"),
    do: %{
      "added" => added,
      "modified" => [],
      "removed" => [],
      "next_cursor" => cursor,
      "has_more" => false
    }

  def tx(id, account, amount \\ 12),
    do: %{
      "transaction_id" => id,
      "account_id" => account,
      "date" => "2026-10-01",
      "name" => "Groceries",
      "amount" => amount,
      "pending" => false,
      "iso_currency_code" => "USD"
    }

  def refresh(item, accounts, p \\ page()),
    do: Store.refresh(item, response(item, accounts), [p], p["next_cursor"])

  def snapshot, do: Snapshot.build(@owner, "2026-10")

  test "removal retains history and excludes obsolete balances and cards" do
    refresh("i1", [account("a"), account("b", 50)], page([tx("t", "a")]))
    refresh("i1", [account("b", 50)])
    assert Enum.map(snapshot().accounts, & &1.account_id) == ["b"]
    assert snapshot().totals.cash_cents == 5000
    assert [%{historical: true, account_name: "a", amount_cents: 1200}] = snapshot().transactions
    assert snapshot().totals.spending_cents == 1200
    assert [%{removed_at: %DateTime{}}] = Enum.filter(Store.rows(Account, "i1"), &(!&1.active))
  end

  test "replacement identifier never doubles balances or rewrites transaction associations" do
    refresh("i1", [account("old")], page([tx("t", "old")]))
    refresh("i1", [account("new")])
    assert snapshot().totals.cash_cents == 10000
    assert [%{account_id: "old", historical: true}] = snapshot().transactions
    assert Enum.map(snapshot().accounts, & &1.account_id) == ["new"]
  end

  test "empty complete snapshot retires all accounts for only that Item" do
    refresh("i1", [account("same")], page([tx("t1", "same")]))
    refresh("i2", [account("same", 25)], page([tx("t2", "same")]))
    refresh("i1", [])
    assert [%{item_id: "i2", account_id: "same"}] = snapshot().accounts
    assert snapshot().totals.cash_cents == 2500
    assert length(snapshot().transactions) == 2
  end

  test "repeating snapshots is idempotent and returning accounts reactivate" do
    refresh("i1", [account("a")], page([tx("t", "a")]))
    refresh("i1", [])
    [retired] = Store.rows(Account, "i1")
    refresh("i1", [])
    assert hd(Store.rows(Account, "i1")).removed_at == retired.removed_at
    for _ <- 1..3, do: refresh("i1", [account("a", 7)], page([tx("t", "a")]))
    assert [%{active: true, removed_at: nil}] = Store.rows(Account, "i1")
    assert length(Store.rows(Transaction, "i1")) == 1
    assert snapshot().totals.cash_cents == 700
  end

  test "late transaction error rolls back account removal, additions, transactions and cursor" do
    refresh("i1", [account("a")], page([tx("t", "a")], "before"))
    bad = page([tx("valid", "new"), %{tx("bad", "new") | "date" => "bad"}], "after")
    assert_raise ArgumentError, fn -> refresh("i1", [account("new")], bad) end
    assert Store.item("i1").cursor == "before"
    assert [%{account_id: "a", active: true}] = Store.rows(Account, "i1")
    assert [%{transaction_id: "t"}] = Store.rows(Transaction, "i1")
  end

  test "malformed and duplicate snapshots fail closed without retiring current accounts" do
    refresh("i1", [account("a")])

    for r <- [%{}, response("other", []), response("i1", [account("x"), account("x")])] do
      assert_raise ArgumentError, fn -> Store.refresh("i1", r, [page()], "c1") end
      assert hd(Store.rows(Account, "i1")).active
    end
  end

  test "pending replacement and explicit removal still apply to historical accounts" do
    pending = Map.put(tx("pending", "a"), "pending", true)
    refresh("i1", [account("a")], page([pending]))
    posted = Map.put(tx("posted", "a"), "pending_transaction_id", "pending")
    refresh("i1", [], page([posted]))
    assert [%{transaction_id: "posted"}] = Store.rows(Transaction, "i1")
    refresh("i1", [], Map.put(page(), "removed", [%{"transaction_id" => "posted"}]))
    assert Store.rows(Transaction, "i1") == []
  end

  test "owner may read but cannot mutate; unauthenticated reads denied" do
    assert {:error, _} = Ash.read(Item)
    assert {:ok, _} = Ash.read(Item, actor: @owner)

    assert {:error, _} =
             Store.item("i1")
             |> Ash.Changeset.for_update(:change, %{status: "forged"})
             |> Ash.update(actor: @owner)

    assert Security.unseal(Store.item("i1").encrypted_token) == "secret-one"
    refute Jason.encode!(snapshot()) =~ "secret-one"
    refute Jason.encode!(snapshot()) =~ "encrypted_token"
  end
end
