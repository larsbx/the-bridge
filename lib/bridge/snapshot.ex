defmodule Bridge.Snapshot do
  alias Bridge.Finance.{Item, Account, Transaction}
  require Ash.Query
  @excluded ~w(INCOME TRANSFER_IN TRANSFER_OUT LOAN_PAYMENTS)
  def build(actor, month, item_id \\ "", account_id \\ "", search \\ "") do
    unless is_binary(month) and Regex.match?(~r/^\d{4}-(0[1-9]|1[0-2])$/, month),
      do: raise(ArgumentError, "Invalid month")

    if byte_size(search) > 100, do: raise(ArgumentError, "Search too long")
    start = Date.from_iso8601!(month <> "-01")
    finish = Date.shift(start, month: 1)
    first = Date.shift(start, month: -5)
    nested? = Bridge.Repo.in_transaction?()

    {:ok, result} =
      Bridge.Repo.transaction(fn ->
        # All reads see one committed refresh, even if a writer commits between queries.
        unless nested? or Bridge.Repo.config()[:pool] == Ecto.Adapters.SQL.Sandbox,
          do:
            Ecto.Adapters.SQL.query!(
              Bridge.Repo,
              "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
              []
            )

        items =
          Ash.read!(Item, actor: actor)
          |> Enum.map(&Map.take(&1, [:item_id, :institution, :status, :updated_at]))

        all_accounts = Ash.read!(Account, actor: actor)

        if account_id != "" and
             not Enum.any?(all_accounts, &(&1.account_id == account_id and &1.item_id == item_id)),
           do: raise(ArgumentError, "Unknown account")

        accounts = Enum.filter(all_accounts, & &1.active)

        tx =
          Transaction
          |> Ash.Query.filter(date >= ^first and date < ^finish)
          |> Ash.read!(actor: actor)

        tx =
          Enum.filter(tx, fn t ->
            (account_id == "" or (t.account_id == account_id and t.item_id == item_id)) and
              String.contains?(
                String.downcase((t.merchant || "") <> " " <> t.name),
                String.downcase(search)
              )
          end)

        spending =
          Enum.filter(
            tx,
            &(not &1.pending and &1.currency == "USD" and &1.category not in @excluded)
          )

        selected = Enum.filter(tx, &(Date.compare(&1.date, start) != :lt))

        groups =
          spending
          |> Enum.filter(&(Date.compare(&1.date, start) != :lt))
          |> Enum.group_by(& &1.category)
          |> Enum.map(fn {cat, rows} ->
            %{category: cat, amount_cents: Enum.sum(Enum.map(rows, & &1.amount_cents))}
          end)
          |> Enum.sort_by(& &1.amount_cents, :desc)

        months =
          for n <- 0..5 do
            date = Date.shift(first, month: n) |> Date.to_iso8601() |> String.slice(0, 7)

            %{
              month: date,
              amount_cents:
                spending
                |> Enum.filter(&String.starts_with?(Date.to_iso8601(&1.date), date))
                |> Enum.map(& &1.amount_cents)
                |> Enum.sum()
            }
          end

        total = fn type ->
          accounts
          |> Enum.filter(&(&1.type == type and &1.currency == "USD"))
          |> Enum.map(&(&1.current_cents || 0))
          |> Enum.sum()
        end

        names = Map.new(all_accounts, &{{&1.item_id, &1.account_id}, &1})

        transactions =
          selected
          |> Enum.sort_by(&{&1.date, &1.transaction_id}, :desc)
          |> Enum.take(75)
          |> Enum.map(fn t ->
            account = names[{t.item_id, t.account_id}]

            Map.take(t, [
              :item_id,
              :transaction_id,
              :account_id,
              :date,
              :name,
              :merchant,
              :amount_cents,
              :pending,
              :category,
              :currency
            ])
            |> Map.merge(%{
              account_name: if(account, do: account.name, else: "Historical account"),
              historical: is_nil(account) or not account.active
            })
          end)

        %{
          month: month,
          items: items,
          accounts:
            Enum.map(
              accounts,
              &Map.take(&1, [
                :item_id,
                :account_id,
                :name,
                :mask,
                :type,
                :subtype,
                :currency,
                :current_cents,
                :updated_at
              ])
            ),
          account_filters:
            Enum.map(all_accounts, &Map.take(&1, [:item_id, :account_id, :name, :active])),
          transactions: transactions,
          categories: groups,
          months: months,
          balancesIncomplete:
            Enum.any?(accounts, &(is_nil(&1.current_cents) or &1.currency != "USD")),
          totals: %{
            cash_cents: total.("depository"),
            card_debt_cents: total.("credit"),
            net_liquid_cents: total.("depository") - total.("credit"),
            spending_cents: Enum.sum(Enum.map(groups, & &1.amount_cents))
          },
          generated_at: DateTime.utc_now()
        }
      end)

    result
  end
end
