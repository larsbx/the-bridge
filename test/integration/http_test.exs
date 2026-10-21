defmodule Bridge.HTTPTest do
  use ExUnit.Case, async: false
  import Plug.Test
  import Plug.Conn
  alias Bridge.{Security, Store}

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Bridge.Repo, isolation: "REPEATABLE READ")
    :ok
  end

  def call(
        method,
        path,
        body \\ nil,
        token \\ nil,
        csrf \\ nil,
        origin \\ "http://localhost:3000"
      ) do
    c =
      conn(method, path, if(body, do: Jason.encode!(body)))
      |> put_req_header("content-type", "application/json")

    c = if token, do: put_req_header(c, "cookie", "bridge_session=" <> token), else: c
    c = if csrf, do: put_req_header(c, "x-csrf-token", csrf), else: c
    c = if origin, do: put_req_header(c, "origin", origin), else: c
    Bridge.Web.Router.call(c, Bridge.Web.Router.init([]))
  end

  test "finance and SSE require an active session; mutations require CSRF and fixed origin" do
    assert call(:get, "/api/snapshot").status == 401
    assert call(:get, "/fragment").status == 401
    assert call(:get, "/api/events").status == 401
    token = Security.create_session()
    assert call(:post, "/api/sync", %{}, token).status == 403

    assert call(:post, "/api/sync", %{}, token, Security.csrf(token), "https://evil.example").status ==
             403

    assert call(:post, "/api/sync", %{}, token, Security.csrf(token), nil).status == 403
    assert call(:get, "/api/session", nil, token).resp_body =~ "true"
    assert call(:post, "/logout", %{}, token, Security.csrf(token)).status == 303
    assert call(:get, "/api/snapshot", nil, token).status == 401
    assert call(:get, "/api/events", nil, token).status == 401
  end

  test "HTML renders without hydration; financial content is escaped and not cacheable" do
    Store.save_item("i", "secret", "<img src=x onerror=alert(1)>")
    token = Security.create_session()
    response = call(:get, "/", nil, token)
    assert response.status == 200
    assert response.resp_body =~ "&lt;img"
    refute response.resp_body =~ "<img src=x"
    refute response.resp_body =~ "secret"
    assert get_resp_header(response, "cache-control") == ["no-store"]
    refute response.resp_body =~ "import("
    assert response.resp_body =~ ~s(method="get")
    assert response.resp_body =~ ~s(method="post")
    assert call(:get, "/fragment", nil, token).resp_body =~ ~s(id="finance")
  end

  test "native form login and logout work without browser JavaScript" do
    c =
      conn(:post, "/login", URI.encode_query(%{password: Security.settings().password}))
      |> put_req_header("content-type", "application/x-www-form-urlencoded")
      |> put_req_header("origin", "http://localhost:3000")
      |> Bridge.Web.Router.call(Bridge.Web.Router.init([]))

    assert c.status == 303
    cookie = c.resp_cookies["bridge_session"]
    assert cookie.http_only
    assert cookie.same_site == "Strict"
    assert Security.active?(cookie.value)

    c =
      conn(:post, "/logout", URI.encode_query(%{csrf: Security.csrf(cookie.value)}))
      |> put_req_header("content-type", "application/x-www-form-urlencoded")
      |> put_req_header("origin", "http://localhost:3000")
      |> put_req_header("cookie", "bridge_session=" <> cookie.value)
      |> Bridge.Web.Router.call(Bridge.Web.Router.init([]))

    assert c.status == 303
    refute Security.active?(cookie.value)
  end

  test "unsigned webhook rejected without scheduling" do
    assert call(:post, "/api/plaid/webhook", %{item_id: "i"}).status == 401
  end
end
