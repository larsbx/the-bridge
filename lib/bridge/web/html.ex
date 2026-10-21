defmodule Bridge.Web.HTML do
  @moduledoc "Escaped server-rendered financial fragments inside the build-time SvelteKit shell."
  def escape(nil), do: ""

  def escape(value),
    do:
      value
      |> to_string()
      |> String.replace("&", "&amp;")
      |> String.replace("<", "&lt;")
      |> String.replace(">", "&gt;")
      |> String.replace("\"", "&quot;")
      |> String.replace("'", "&#39;")

  def page(content, csrf \\ "") do
    :bridge
    |> Application.app_dir("priv/static/index.html")
    |> File.read!()
    |> String.replace("BRIDGE_CSRF", escape(csrf))
    |> String.replace("BRIDGE_CONTENT", content)
  end

  def login do
    ~s(<section class="login-panel"><p class="eyebrow">Your private financial overview</p><h1>Welcome back.</h1><form action="/login" method="post"><label for="password">Dashboard passphrase</label><input id="password" name="password" type="password" minlength="16" maxlength="512" autocomplete="current-password" required><button class="primary">Unlock dashboard →</button></form></section>)
  end

  def money(nil, _), do: "Unavailable"

  def money(value, currency) do
    sign = if value < 0, do: "−", else: ""
    cents = abs(value)

    sign <>
      escape(currency || "Unknown currency") <>
      " " <>
      Integer.to_string(div(cents, 100)) <>
      "." <> String.pad_leading(Integer.to_string(rem(cents, 100)), 2, "0")
  end

  defp form(path, label, csrf),
    do:
      ~s(<form class="inline" method="post" action="#{path}"><input type="hidden" name="csrf" value="#{escape(csrf)}"><button class="subtle">#{label}</button></form>)

  def dashboard(data, csrf, filters) do
    options =
      Enum.map_join(data.account_filters, fn a ->
        value = Jason.encode!([a.item_id, a.account_id]) |> Base.url_encode64(padding: false)
        selected = if filters["account"] == value, do: " selected", else: ""

        ~s(<option value="#{value}"#{selected}>#{escape(a.name)}#{if a.active, do: "", else: " · historical"}</option>)
      end)

    ~s(<section class="intro"><div><p class="eyebrow">Personal finance / Overview</p><h1>See the whole picture.</h1></div><div>#{form("/sync", "Check updates", csrf)}#{form("/logout", "Sign out", csrf)}<button class="primary" data-connect="">+ Connect bank</button></div></section>) <>
      ~s(<p id="status" class="status-line" role="status" aria-live="polite"></p><noscript>Live updates and connecting a bank need JavaScript. Existing accounts, filters, sign-in and manual refresh work without it.</noscript>) <>
      ~s(<form class="filters" method="get" action="/"><label>Month<input type="month" name="month" value="#{escape(data.month)}" required></label><label>Account<select name="account"><option value="">All accounts</option>#{options}</select></label><label>Merchant<input type="search" name="q" maxlength="100" value="#{escape(filters["q"])}"></label><button>Apply filters</button></form>) <>
      finance(data)
  end

  def finance(data) do
    cards = [
      {"Cash accounts (USD)", data.totals.cash_cents},
      {"Credit balances (USD)", data.totals.card_debt_cents},
      {"Cash less card balances", data.totals.net_liquid_cents},
      {"Net categorized spending", data.totals.spending_cents}
    ]

    kpis =
      Enum.map_join(cards, fn {name, amount} ->
        ~s(<article class="kpi"><div class="kpi-label">#{name}</div><div class="kpi-value">#{money(amount, "USD")}</div></article>)
      end)

    accounts =
      Enum.map_join(data.accounts, fn a ->
        ~s(<article class="account-card"><h3>#{escape(a.name)} #{escape(a.mask)}</h3><p>#{escape(a.type)}</p><div class="account-balance">#{money(a.current_cents, a.currency)}</div><p class="account-updated">Updated #{escape(a.updated_at)}</p></article>)
      end)

    states =
      Enum.map_join(data.items, fn i ->
        button =
          if i.status == "needs_relink",
            do: ~s(<button data-connect="#{escape(i.item_id)}">Reconnect</button>),
            else: ""

        ~s(<p>#{escape(i.institution)} · #{escape(i.status)} #{button}</p>)
      end)

    rows =
      Enum.map_join(data.transactions, fn t ->
        ~s(<tr><td>#{escape(t.date)}</td><td>#{escape(t.merchant || t.name)}#{if t.pending, do: " · pending", else: ""}</td><td>#{escape(t.account_name)}#{if t.historical, do: ~s( <span class="historical">Historical</span>), else: ""}</td><td>#{escape(t.category)}</td><td class="right">#{money(t.amount_cents, t.currency)}</td></tr>)
      end)

    rows = if rows == "", do: ~s(<tr><td colspan="5">No matching activity.</td></tr>), else: rows

    ~s(<section id="finance"><div class="kpis">#{kpis}</div><p class="muted">USD totals only. Spending excludes pending activity and recognized income, transfers and loan payments; refunds reduce spending. Historical account transactions remain included.</p>) <>
      if(data.balancesIncomplete,
        do:
          ~s(<p class="notice">Totals are incomplete: some current balances or currencies are unavailable or non-USD.</p>),
        else: ""
      ) <>
      ~s(<div class="content-grid"><section class="panel span-7"><h2>Spending trend</h2><p>Six months · posted USD · earlier history may be incomplete</p>#{bars(data.months, :month)}</section><section class="panel span-5"><h2>Where it goes</h2>#{bars(data.categories, :category)}</section></div>) <>
      ~s(<section class="panel"><h2>Current accounts</h2>#{states}<div class="account-cards">#{if accounts == "", do: "No current accounts returned by Plaid.", else: accounts}</div></section>) <>
      ~s(<section class="panel"><h2>Transaction activity</h2><p>Up to 75 matching rows</p><div class="table-scroll"><table><thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Category</th><th class="right">Amount</th></tr></thead><tbody>#{rows}</tbody></table></div></section><p class="muted">Generated #{escape(data.generated_at)}</p></section>)
  end

  defp bars(rows, label) do
    maximum = rows |> Enum.map(&abs(&1.amount_cents)) |> Enum.max(fn -> 1 end) |> max(1)

    content =
      Enum.map_join(rows, fn r ->
        ~s(<div class="category-row"><div class="category-meta"><span>#{escape(Map.fetch!(r, label))}</span><span>#{money(r.amount_cents, "USD")}</span></div><progress aria-label="#{escape(Map.fetch!(r, label))} magnitude" max="#{maximum}" value="#{abs(r.amount_cents)}"></progress></div>)
      end)

    ~s(<div class="bars">#{content}</div>)
  end
end
