defmodule Bridge.Web.Router do
  use Plug.Router
  alias Bridge.{Security, Store, Snapshot, Plaid, Sync}
  plug(:headers)
  plug(:match)
  plug(:dispatch)

  defp headers(conn, _) do
    conn
    |> put_resp_header("cache-control", "no-store")
    |> put_resp_header("x-content-type-options", "nosniff")
    |> put_resp_header("referrer-policy", "no-referrer")
    |> put_resp_header(
      "content-security-policy",
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://cdn.plaid.com; frame-src https://*.plaid.com; connect-src 'self' https://*.plaid.com; img-src 'self' data: https://*.plaid.com; style-src 'self'"
    )
  end

  defp token(conn), do: fetch_cookies(conn).req_cookies["bridge_session"]
  defp owner(conn), do: if(Security.active?(token(conn)), do: %Bridge.Actor{role: :owner})
  defp origin?(conn), do: get_req_header(conn, "origin") == [Security.settings().origin]

  defp json(conn, status, data),
    do:
      conn |> put_resp_content_type("application/json") |> send_resp(status, Jason.encode!(data))

  defp redirect(conn, path), do: conn |> put_resp_header("location", path) |> send_resp(303, "")

  defp cookie(conn, token, age),
    do:
      put_resp_cookie(conn, "bridge_session", token,
        http_only: true,
        secure: Security.settings().secure,
        same_site: "Strict",
        max_age: age,
        path: "/"
      )

  defp body(conn) do
    case read_body(conn, length: 131_072, read_length: 131_072, read_timeout: 10_000) do
      {:ok, raw, conn} -> {raw, conn}
      _ -> raise ArgumentError, "Request too large"
    end
  end

  defp params(conn) do
    {raw, conn} = body(conn)
    type = get_req_header(conn, "content-type") |> List.first() || ""

    payload =
      cond do
        String.starts_with?(type, "application/json") -> Jason.decode!(raw)
        String.starts_with?(type, "application/x-www-form-urlencoded") -> URI.decode_query(raw)
        true -> raise ArgumentError, "Unsupported body"
      end

    unless is_map(payload), do: raise(ArgumentError, "Expected object")
    {payload, conn}
  end

  defp guarded(conn, fun) do
    try do
      if actor = owner(conn),
        do: fun.(conn, actor),
        else: json(conn, 401, %{error: "authentication_required"})
    rescue
      _ in [ArgumentError, Jason.DecodeError] -> json(conn, 400, %{error: "invalid_request"})
      _ -> json(conn, 502, %{error: "request_failed"})
    end
  end

  defp mutation(conn, fun) do
    guarded(conn, fn conn, actor ->
      {p, conn} = params(conn)
      csrf = List.first(get_req_header(conn, "x-csrf-token")) || p["csrf"]

      if origin?(conn) and Security.csrf?(token(conn), csrf),
        do: fun.(conn, actor, p),
        else: json(conn, 403, %{error: "csrf_or_origin_rejected"})
    end)
  end

  defp snapshot(conn, actor) do
    p = fetch_query_params(conn).query_params

    {item, account} =
      case p["account"] do
        nil ->
          {"", ""}

        "" ->
          {"", ""}

        encoded ->
          case Jason.decode!(Base.url_decode64!(encoded, padding: false)) do
            [i, a] when is_binary(i) and is_binary(a) -> {i, a}
            _ -> raise ArgumentError, "Invalid account"
          end
      end

    Snapshot.build(
      actor,
      p["month"] || String.slice(Date.to_iso8601(Date.utc_today()), 0, 7),
      item,
      account,
      p["q"] || ""
    )
  end

  get("/healthz", do: json(conn, 200, %{status: "ok"}))

  get("/api/snapshot",
    do:
      guarded(conn, fn conn, actor -> json(conn, 200, cents_as_strings(snapshot(conn, actor))) end)
  )

  # JSON numbers cannot preserve the ledger's full signed-64-bit cent range in JS.
  # This is a wire/display conversion only; accounting stays in Snapshot/Store.
  defp cents_as_strings(data) when is_map(data) and not is_struct(data) do
    Map.new(data, fn {key, value} ->
      if String.ends_with?(to_string(key), "_cents") and is_integer(value),
        do: {key, Integer.to_string(value)},
        else: {key, cents_as_strings(value)}
    end)
  end

  defp cents_as_strings(data) when is_list(data), do: Enum.map(data, &cents_as_strings/1)
  defp cents_as_strings(data), do: data

  get "/api/session" do
    json(
      conn,
      200,
      if(owner(conn),
        do: %{authenticated: true, csrf: Security.csrf(token(conn))},
        else: %{authenticated: false}
      )
    )
  end

  post "/login" do
    try do
      cond do
        not origin?(conn) ->
          json(conn, 403, %{error: "origin_rejected"})

        not Bridge.LoginLimiter.allow?(conn.remote_ip) ->
          json(conn, 429, %{error: "too_many_attempts"})

        true ->
          {p, conn} = params(conn)

          if Security.password?(p["password"]),
            do: conn |> cookie(Security.create_session(), 43_200) |> redirect("/"),
            else: json(conn, 401, %{error: "invalid_credentials"})
      end
    rescue
      _ -> json(conn, 400, %{error: "invalid_request"})
    end
  end

  post("/logout",
    do:
      mutation(conn, fn conn, _, _ ->
        Security.revoke(token(conn))
        conn |> cookie("", 0) |> redirect("/")
      end)
  )

  post("/sync",
    do:
      mutation(conn, fn conn, _, _ ->
        Sync.all()
        redirect(conn, "/")
      end)
  )

  post "/api/plaid/link-token" do
    mutation(conn, fn conn, _, p ->
      item = if p["item_id"], do: Store.item(p["item_id"])

      if p["item_id"] && !item do
        json(conn, 404, %{error: "unknown_item"})
      else
        json(conn, 200, %{
          link_token: Plaid.link_token(if(item, do: Security.unseal(item.encrypted_token))),
          update_mode: not is_nil(item)
        })
      end
    end)
  end

  post "/api/plaid/exchange" do
    mutation(conn, fn conn, _, p ->
      unless is_binary(p["public_token"]) and byte_size(p["public_token"]) in 1..500,
        do: raise(ArgumentError, "Invalid public token")

      result = Plaid.exchange(p["public_token"])

      institution =
        if is_binary(p["institution"]),
          do: String.slice(p["institution"], 0, 100),
          else: "Linked institution"

      Store.save_item(result["item_id"], result["access_token"], institution)
      Sync.schedule(result["item_id"])
      json(conn, 200, %{connected: true})
    end)
  end

  post("/api/sync",
    do:
      mutation(conn, fn conn, _, _ ->
        Sync.all()
        json(conn, 202, %{scheduled: true})
      end)
  )

  post "/api/plaid/webhook" do
    try do
      {raw, conn} = body(conn)

      if Plaid.verify_webhook(raw, List.first(get_req_header(conn, "plaid-verification"))) do
        p = Jason.decode!(raw)
        if is_binary(p["item_id"]) && Store.item(p["item_id"]), do: Sync.schedule(p["item_id"])
        json(conn, 200, %{received: true})
      else
        json(conn, 401, %{error: "invalid_webhook_signature"})
      end
    rescue
      _ -> json(conn, 400, %{error: "invalid_request"})
    end
  end

  get "/api/events" do
    guarded(conn, fn conn, _ ->
      case Bridge.Events.subscribe() do
        {:ok, _} ->
          conn =
            conn
            |> put_resp_content_type("text/event-stream")
            |> put_resp_header("x-accel-buffering", "no")
            |> send_chunked(200)

          try do
            {:ok, conn} = chunk(conn, "retry: 5000\nevent: refresh\ndata: {}\n\n")
            stream(conn, token(conn))
          after
            Bridge.Events.unsubscribe()
          end

        _ ->
          json(conn, 429, %{error: "too_many_streams"})
      end
    end)
  end

  defp stream(conn, token) do
    receive do
      event when event in [:refresh, :session_changed] ->
        stream_write(conn, token, "event: refresh\ndata: {}\n\n")
    after
      15_000 -> stream_write(conn, token, ": heartbeat\n\n")
    end
  end

  defp stream_write(conn, token, data) do
    if Security.active?(token) do
      case chunk(conn, data) do
        {:ok, conn} -> stream(conn, token)
        {:error, _} -> conn
      end
    else
      case chunk(conn, "event: signed-out\ndata: {}\n\n") do
        {:ok, conn} -> conn
        _ -> conn
      end
    end
  end

  match(_, do: json(conn, 404, %{error: "not_found"}))
end
