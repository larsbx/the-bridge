defmodule Bridge.LockConformanceTest do
  use ExUnit.Case, async: false
  alias Bridge.{Repo, Store}
  alias Bridge.Finance.{Account, Transaction}
  alias Ecto.Adapters.SQL.Sandbox

  defp payload(item, account, cursor) do
    response = %{
      "item" => %{"item_id" => item},
      "accounts" => [
        %{
          "account_id" => account,
          "name" => account,
          "type" => "depository",
          "balances" => %{"current" => 100, "iso_currency_code" => "USD"}
        }
      ]
    }

    page = %{
      "added" => [
        %{
          "transaction_id" => account,
          "account_id" => account,
          "date" => "2026-10-01",
          "name" => account,
          "amount" => 10,
          "pending" => false,
          "iso_currency_code" => "USD"
        }
      ],
      "modified" => [],
      "removed" => [],
      "next_cursor" => cursor,
      "has_more" => false
    }

    {response, [page], cursor}
  end

  defp commit(item, account, cursor) do
    {response, pages, cursor} = payload(item, account, cursor)
    Store.commit_refresh!(item, response, pages, cursor)
  end

  defp backend_pid do
    %{rows: [[pid]]} = Ecto.Adapters.SQL.query!(Repo, "SELECT pg_backend_pid()", [])
    pid
  end

  defp await_lock_wait(pid, attempts \\ 100)
  defp await_lock_wait(_, 0), do: flunk("Second backend never waited on the Item advisory lock")

  defp await_lock_wait(pid, attempts) do
    %{rows: [[waiting]]} =
      Ecto.Adapters.SQL.query!(
        Repo,
        "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted)",
        [pid]
      )

    unless waiting do
      Process.sleep(20)
      await_lock_wait(pid, attempts - 1)
    end
  end

  @tag timeout: 30_000
  test "separate PostgreSQL connections serialize one Item and hide private writes" do
    suffix = System.unique_integer([:positive])
    item = "lock-#{suffix}"
    other = "independent-#{suffix}"
    parent = self()

    # Shared Sandbox connections would serialize queries artificially and cannot
    # establish the model's locking assumption. These are real committed rows
    # and independent connections, restricted to uniquely named test Items.
    Sandbox.unboxed_run(Repo, fn ->
      Store.save_item(item, "test-token", "Lock")
      Store.save_item(other, "test-token", "Other")

      try do
        first =
          Task.async(fn ->
            Sandbox.unboxed_run(Repo, fn ->
              Store.with_item_lock(item, fn ->
                commit(item, "old", "first")
                send(parent, {:private_writes, backend_pid()})

                receive do
                  :release -> :ok
                after
                  5_000 -> raise "Writer was never released"
                end
              end)
            end)
          end)

        try do
          assert_receive {:private_writes, first_backend}, 5_000
          assert Store.item(item).cursor == nil
          assert Store.rows(Account, item) == []
          assert Store.rows(Transaction, item) == []

          assert {:ok, _} =
                   Store.with_item_lock(other, fn -> commit(other, "old", "independent") end)

          second =
            Task.async(fn ->
              Sandbox.unboxed_run(Repo, fn ->
                send(parent, {:second_backend, backend_pid()})

                Store.with_item_lock(item, fn ->
                  send(parent, {:cursor_after_lock, Store.item(item).cursor})
                  commit(item, "new", "second")
                end)
              end)
            end)

          try do
            assert_receive {:second_backend, second_backend}, 5_000
            refute first_backend == second_backend
            await_lock_wait(second_backend)
            send(first.pid, :release)
            assert {:ok, :ok} = Task.await(first, 5_000)
            assert_receive {:cursor_after_lock, "first"}, 5_000
            assert {:ok, _} = Task.await(second, 5_000)
            assert Store.item(item).cursor == "second"

            assert Store.rows(Account, item)
                   |> Enum.filter(& &1.active)
                   |> Enum.map(& &1.account_id) == ["new"]

            assert MapSet.new(Store.rows(Transaction, item), & &1.transaction_id) ==
                     MapSet.new(["old", "new"])

            assert Store.item(other).cursor == "independent"
            assert [%{account_id: "old", active: true}] = Store.rows(Account, other)
          after
            Task.shutdown(second, :brutal_kill)
          end
        after
          send(first.pid, :release)
          Task.shutdown(first, :brutal_kill)
        end
      after
        for id <- [item, other] do
          for resource <- [Transaction, Account],
              row <- Store.rows(resource, id),
              do: Ash.destroy!(row, actor: Store.sync_actor())

          if row = Store.item(id), do: Ash.destroy!(row, actor: Store.sync_actor())
        end
      end
    end)
  end
end
