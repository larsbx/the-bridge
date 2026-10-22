defmodule Bridge.HTTPSecurityTest do
  use ExUnit.Case, async: true
  import Plug.Test
  import Plug.Conn

  test "all private read surfaces fail closed before touching PostgreSQL" do
    for path <- ["/api/snapshot", "/api/events"] do
      response = conn(:get, path) |> Bridge.Web.Router.call([])
      assert response.status == 401
      assert get_resp_header(response, "cache-control") == ["no-store"]
      refute response.resp_body =~ "encrypted_token"
    end
  end

  test "forged cookies and unauthenticated mutations cannot reach Plaid" do
    for {method, path} <- [
          {:get, "/api/snapshot"},
          {:post, "/api/plaid/link-token"},
          {:post, "/api/plaid/exchange"},
          {:post, "/api/sync"}
        ] do
      response =
        conn(method, path, "{}")
        |> put_req_header("cookie", "bridge_session=forged")
        |> Bridge.Web.Router.call([])

      assert response.status == 401
    end
  end

  test "login rejects a forged Origin and an unsigned webhook is not admitted" do
    response =
      conn(:post, "/login", "{}")
      |> put_req_header("origin", "https://evil.example")
      |> Bridge.Web.Router.call([])

    assert response.status == 403

    response =
      conn(:post, "/api/plaid/webhook", ~s({"item_id":"x"})) |> Bridge.Web.Router.call([])

    assert response.status == 401
  end

  test "backend does not expose a second frontend or static build artifacts" do
    response = conn(:get, "/") |> Bridge.Web.Router.call([])
    assert response.status == 404
    refute response.resp_body =~ ~s(id="finance")
    assert conn(:get, "/bridge.js") |> Bridge.Web.Router.call([]) |> Map.fetch!(:status) == 404

    assert get_resp_header(response, "content-security-policy") |> hd() =~
             "frame-ancestors 'none'"
  end
end
