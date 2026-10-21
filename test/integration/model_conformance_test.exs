defmodule Bridge.ModelConformanceTest do
  use ExUnit.Case, async: false
  alias Bridge.{Repo, Store, Snapshot}
  alias Bridge.Finance.{Account, Transaction}

  # Independent executable observations of formal/Reconciliation.tla's six
  # request shapes. The oracle uses sets, never Store's reconciliation helpers.
  @requests [
    {[], [], []},
    {["old"], ["old"], []},
    {["new"], ["new"], []},
    {["old", "new"], ["old", "new"], []},
    {[], [], ["old"]},
    {[], ["old"], []}
  ]
  @actor %Bridge.Actor{role: :owner}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Repo, isolation: "REPEATABLE READ")
    :ok
  end

  defp account(id) do
    %{
      "account_id" => id,
      "name" => id,
      "type" => "depository",
      "balances" => %{
        "current" => if(id == "old", do: 100, else: 250),
        "iso_currency_code" => "USD"
      }
    }
  end

  defp transaction(id) do
    %{
      "transaction_id" => id,
      "account_id" => id,
      "date" => "2026-10-01",
      "name" => id,
      "amount" => 10,
      "pending" => false,
      "iso_currency_code" => "USD"
    }
  end

  defp refresh(item, {snapshot, added, removed}, cursor) do
    response = %{"item" => %{"item_id" => item}, "accounts" => Enum.map(snapshot, &account/1)}

    page = %{
      "added" => Enum.map(added, &transaction/1),
      "modified" => [],
      "removed" => Enum.map(removed, &%{"transaction_id" => &1}),
      "next_cursor" => cursor,
      "has_more" => false
    }

    Store.refresh(item, response, [page], cursor)
  end

  @tag timeout: 120_000
  test "all 216 length-three model request sequences agree with the PostgreSQL ledger" do
    for a <- @requests, b <- @requests, c <- @requests do
      assert {:error, :trace_complete} =
               Repo.transaction(fn ->
                 Store.save_item("model", "token", "Model")
                 Store.save_item("other", "token", "Other")
                 refresh("other", {["old", "new"], ["old", "new"], []}, "untouched")
                 other_accounts = Store.rows(Account, "other")
                 other_transactions = Store.rows(Transaction, "other")

                 Enum.with_index([a, b, c], 1)
                 |> Enum.reduce({MapSet.new(), MapSet.new()}, fn {{snapshot, added, removed} =
                                                                    operation, n},
                                                                 {history, known} ->
                   refresh("model", operation, "cursor-#{n}")

                   history =
                     history
                     |> MapSet.difference(MapSet.new(removed))
                     |> MapSet.union(MapSet.new(added))

                   known = MapSet.union(known, MapSet.new(snapshot))
                   accounts = Store.rows(Account, "model")
                   assert MapSet.new(accounts, & &1.account_id) == known

                   assert accounts |> Enum.filter(& &1.active) |> MapSet.new(& &1.account_id) ==
                            MapSet.new(snapshot)

                   assert MapSet.new(Store.rows(Transaction, "model"), & &1.transaction_id) ==
                            history

                   assert Store.item("model").cursor == "cursor-#{n}"
                   assert Store.item("other").cursor == "untouched"
                   assert Store.rows(Account, "other") == other_accounts
                   assert Store.rows(Transaction, "other") == other_transactions
                   view = Snapshot.build(@actor, "2026-10")

                   expected =
                     Enum.sum(Enum.map(snapshot, &if(&1 == "old", do: 10_000, else: 25_000)))

                   assert view.totals.cash_cents == 35_000 + expected
                   observed = view.transactions |> Enum.filter(&(&1.item_id == "model"))
                   assert MapSet.new(observed, & &1.transaction_id) == history
                   assert Enum.all?(observed, &(&1.historical == &1.account_id not in snapshot))
                   {history, known}
                 end)

                 Repo.rollback(:trace_complete)
               end)
    end
  end
end
