defmodule Bridge.Store do
  @moduledoc "Item-scoped, transactional reconciliation through authorized Ash actions."
  alias Bridge.Finance.{Item, Account, Transaction}
  alias Bridge.{Repo, Security}
  require Ash.Query
  @sync %Bridge.Actor{role: :sync}
  def sync_actor, do: @sync
  def now, do: DateTime.utc_now()

  def put(resource, attrs),
    do: resource |> Ash.Changeset.for_create(:put, attrs) |> Ash.create!(actor: @sync)

  def change(record, attrs),
    do: record |> Ash.Changeset.for_update(:change, attrs) |> Ash.update!(actor: @sync)

  def items(actor), do: Ash.read!(Item, actor: actor)
  def item(id), do: Ash.get!(Item, id, actor: @sync, not_found_error?: false)

  def save_item(id, token, institution) do
    # Re-linking must never reset a committed transaction cursor.
    case item(id) do
      nil ->
        put(Item, %{
          item_id: id,
          encrypted_token: Security.seal(token),
          institution: institution,
          status: "connected",
          cursor: nil,
          updated_at: now()
        })

      old ->
        change(old, %{
          encrypted_token: Security.seal(token),
          institution: institution,
          status: "connected",
          updated_at: now()
        })
    end
  end

  def rows(resource, item_id),
    do: resource |> Ash.Query.filter(item_id == ^item_id) |> Ash.read!(actor: @sync)

  def cents(nil), do: nil

  def cents(value) when is_number(value) or is_binary(value) do
    value
    |> to_string()
    |> Decimal.new()
    |> Decimal.mult(100)
    |> Decimal.round(0, :half_up)
    |> Decimal.to_integer()
  end

  def cents(_), do: raise(ArgumentError, "Invalid amount")

  defp id!(value) when is_binary(value) and byte_size(value) > 0 and byte_size(value) <= 200,
    do: value

  defp id!(_), do: raise(ArgumentError, "Invalid identifier")

  def validate_accounts!(item_id, response) do
    # Only the COMPLETE, unfiltered /accounts/get response is accepted. Missing is not empty.
    unless is_map(response) and get_in(response, ["item", "item_id"]) == item_id and
             is_list(response["accounts"]),
           do: raise(ArgumentError, "Incomplete account snapshot")

    ids =
      Enum.map(response["accounts"], fn account ->
        unless is_map(account) and is_map(account["balances"]),
          do: raise(ArgumentError, "Malformed account")

        id!(account["account_id"])
      end)

    unless length(ids) == MapSet.size(MapSet.new(ids)),
      do: raise(ArgumentError, "Duplicate account identifier")

    response["accounts"]
  end

  defp reconcile_accounts!(item_id, response) do
    accounts = validate_accounts!(item_id, response)
    incoming = MapSet.new(accounts, & &1["account_id"])
    changed_at = now()

    for old <- rows(Account, item_id),
        old.active and not MapSet.member?(incoming, old.account_id) do
      change(old, %{active: false, removed_at: changed_at})
    end

    for a <- accounts do
      b = a["balances"]

      put(Account, %{
        item_id: item_id,
        account_id: a["account_id"],
        name: a["name"] || "Account",
        mask: a["mask"],
        type: a["type"] || "other",
        subtype: a["subtype"],
        currency: b["iso_currency_code"] || b["unofficial_currency_code"],
        current_cents: cents(b["current"]),
        available_cents: cents(b["available"]),
        limit_cents: cents(b["limit"]),
        active: true,
        removed_at: nil,
        updated_at: changed_at
      })
    end
  end

  defp drop_transaction(item_id, tx_id, pending_only \\ false) do
    record =
      Ash.get!(Transaction, %{item_id: item_id, transaction_id: id!(tx_id)},
        actor: @sync,
        not_found_error?: false
      )

    if record && (not pending_only or record.pending), do: Ash.destroy!(record, actor: @sync)
  end

  defp apply_pages!(item_id, pages) do
    for page <- pages do
      for removed <- page["removed"], do: drop_transaction(item_id, removed["transaction_id"])

      for tx <- page["added"] ++ page["modified"] do
        if tx["pending_transaction_id"],
          do: drop_transaction(item_id, tx["pending_transaction_id"], true)

        unless is_number(tx["amount"]) and is_boolean(tx["pending"]),
          do: raise(ArgumentError, "Malformed transaction")

        put(Transaction, %{
          item_id: item_id,
          transaction_id: id!(tx["transaction_id"]),
          account_id: id!(tx["account_id"]),
          date: Date.from_iso8601!(tx["date"]),
          name: tx["name"] || "Transaction",
          merchant: tx["merchant_name"],
          amount_cents: cents(tx["amount"]),
          pending: tx["pending"],
          category: get_in(tx, ["personal_finance_category", "primary"]) || "UNCATEGORIZED",
          currency: tx["iso_currency_code"] || tx["unofficial_currency_code"],
          updated_at: now()
        })
      end
    end
  end

  def validate_pages!(pages, cursor) do
    unless is_list(pages) and pages != [] and is_binary(cursor),
      do: raise(ArgumentError, "Incomplete sync")

    Enum.with_index(pages)
    |> Enum.each(fn {p, i} ->
      unless is_map(p) and Enum.all?(~w(added modified removed), &is_list(p[&1])) and
               is_binary(p["next_cursor"]) and p["has_more"] == i < length(pages) - 1,
             do: raise(ArgumentError, "Malformed sync page")
    end)

    unless List.last(pages)["next_cursor"] == cursor, do: raise(ArgumentError, "Cursor mismatch")
  end

  def commit_refresh!(item_id, response, pages, cursor) do
    unless Repo.in_transaction?(), do: raise("Refresh requires Item transaction")
    validate_accounts!(item_id, response)
    validate_pages!(pages, cursor)
    reconcile_accounts!(item_id, response)
    apply_pages!(item_id, pages)
    change(item(item_id), %{cursor: cursor, status: "connected", updated_at: now()})
  end

  def with_item_lock(item_id, fun) do
    Repo.transaction(
      fn ->
        # A transaction-scoped PostgreSQL lock serializes fetch AND commit across processes/nodes.
        # Hash collisions serialize unrelated Items; they cannot merge their data.
        Ecto.Adapters.SQL.query!(Repo, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          item_id
        ])

        unless item(item_id), do: raise(ArgumentError, "Unknown Item")
        fun.()
      end,
      timeout: 120_000
    )
  end

  def refresh(item_id, response, pages, cursor),
    do: with_item_lock(item_id, fn -> commit_refresh!(item_id, response, pages, cursor) end)
end
