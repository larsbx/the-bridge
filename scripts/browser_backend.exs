# Only the opt-in browser suite may start this destructive, synthetic fixture.
# Production code and routes never import this file or Req.Test.
unless Mix.env() == :test and System.get_env("BRIDGE_BROWSER_TEST") == "1" and
         URI.parse(System.fetch_env!("DATABASE_URL")).path == "/bridge_browser_test" do
  raise "Browser fixture requires MIX_ENV=test, BRIDGE_BROWSER_TEST=1 and bridge_browser_test DB"
end

Ecto.Adapters.SQL.Sandbox.mode(Bridge.Repo, :auto)

Application.put_env(:bridge, :settings, %{
  Bridge.Security.settings()
  | origin: "http://127.0.0.1:3173",
    password: "fixture-passphrase-long-enough"
})

{:ok, _} = Agent.start_link(fn -> %{} end, name: Bridge.BrowserState)
Req.Test.set_req_test_to_shared()
Req.default_options(plug: {Req.Test, Bridge.BrowserPlaid})

Req.Test.stub(Bridge.BrowserPlaid, fn conn ->
  {:ok, raw, conn} = Plug.Conn.read_body(conn)
  body = Jason.decode!(raw)

  result =
    case conn.request_path do
      "/link/token/create" ->
        Agent.update(Bridge.BrowserState, &Map.update!(&1, :links, fn xs -> xs ++ [body] end))
        %{link_token: "link-sandbox-fixture"}

      "/item/public_token/exchange" ->
        Agent.update(Bridge.BrowserState, &Map.update!(&1, :exchanges, fn xs -> xs ++ [body] end))
        %{item_id: "fixture-item", access_token: "access-sandbox-fixture"}

      "/accounts/get" ->
        state = Agent.get(Bridge.BrowserState, & &1)

        %{
          item: %{item_id: "fixture-item"},
          accounts: [
            %{
              account_id: state.account_id,
              name:
                if(state.account_id == "checking",
                  do: "Current checking",
                  else: "Replacement account"
                ),
              mask: "1234",
              type: "depository",
              balances: %{current: state.balance / 100, iso_currency_code: "USD"}
            }
          ]
        }

      "/transactions/sync" ->
        %{
          added: [
            %{
              transaction_id: "fixture-transaction",
              account_id: "checking",
              date: Date.to_iso8601(Date.utc_today()),
              name: "Fixture purchase",
              amount: 6.78,
              pending: false,
              iso_currency_code: "USD",
              personal_finance_category: %{primary: "GENERAL_MERCHANDISE"}
            }
          ],
          modified: [],
          removed: [],
          next_cursor: "fixture-cursor",
          has_more: false
        }

      path ->
        raise "Unexpected fixture Plaid path: #{path}"
    end

  Req.Test.json(conn, result)
end)

defmodule Bridge.BrowserFixture do
  use Plug.Router
  plug(:match)
  plug(:dispatch)

  def reset do
    wait_for_sync(100)
    Bridge.Repo.query!("TRUNCATE TABLE transactions, accounts, items, sessions")

    Agent.update(Bridge.BrowserState, fn _ ->
      %{balance: 12345, account_id: "checking", links: [], exchanges: []}
    end)

    Bridge.Store.save_item(
      "fixture-item",
      "access-sandbox-fixture",
      "<img src=x onerror=alert(1)>"
    )

    {:ok, _} = Bridge.Sync.run("fixture-item")
  end

  defp wait_for_sync(left) do
    if map_size(:sys.get_state(Bridge.Sync)) != 0 do
      if left == 0, do: raise("Sync fixture did not become idle")
      Process.sleep(20)
      wait_for_sync(left - 1)
    end
  end

  post "/__test/reset" do
    reset()
    send_resp(conn, 200, "{}")
  end

  post "/__test/change" do
    {:ok, raw, conn} = read_body(conn)
    body = Jason.decode!(raw)
    Agent.update(Bridge.BrowserState, &Map.put(&1, :balance, body["balance"]))
    {:ok, _} = Bridge.Sync.run("fixture-item")
    send_resp(conn, 200, "{}")
  end

  post "/__test/replace" do
    Agent.update(Bridge.BrowserState, &Map.put(&1, :account_id, "replacement"))
    {:ok, _} = Bridge.Sync.run("fixture-item")
    send_resp(conn, 200, "{}")
  end

  post "/__test/relink" do
    wait_for_sync(100)
    Bridge.Store.change(Bridge.Store.item("fixture-item"), %{status: "needs_relink"})
    Bridge.Events.publish()
    send_resp(conn, 200, "{}")
  end

  post "/__test/state" do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(Agent.get(Bridge.BrowserState, & &1)))
  end

  match _ do
    Bridge.Web.Router.call(conn, [])
  end
end

Bridge.BrowserFixture.reset()
{:ok, _} = Bandit.start_link(plug: Bridge.BrowserFixture, ip: {127, 0, 0, 1}, port: 4174)
IO.puts("Synthetic Plaid + real Ash browser backend ready")

# mix run --no-halt keeps the VM alive, but its evaluation process can finish.
# Keep the fixture owner alive for linked Bandit/Agent processes and Req.Test ownership.
Process.sleep(:infinity)
