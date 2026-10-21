defmodule Bridge.Plaid do
  @moduledoc "Read-only Plaid transport with bounded pagination and signed webhook verification."
  alias Bridge.Security

  def post(path, body) do
    cfg = Security.settings()

    response =
      Req.post!("https://#{cfg.plaid_env}.plaid.com" <> path,
        headers: [{"plaid-client-id", cfg.client_id}, {"plaid-secret", cfg.secret}],
        json: body,
        receive_timeout: 25_000,
        retry: false,
        redirect: false
      )

    if response.status != 200,
      do: raise(Bridge.PlaidError, code: response.body["error_code"] || "PLAID_HTTP_ERROR")

    response.body
  end

  def link_token(access_token \\ nil) do
    cfg = Security.settings()

    body = %{
      client_name: "The Bridge",
      country_codes: ["US"],
      language: "en",
      user: %{client_user_id: "owner"}
    }

    body =
      if access_token,
        do: Map.put(body, :access_token, access_token),
        else: Map.merge(body, %{products: ["transactions"], transactions: %{days_requested: 730}})

    body =
      if cfg.secure, do: Map.put(body, :webhook, cfg.origin <> "/api/plaid/webhook"), else: body

    post("/link/token/create", body)["link_token"]
  end

  def exchange(token), do: post("/item/public_token/exchange", %{public_token: token})
  def accounts(token), do: post("/accounts/get", %{access_token: token})

  def sync_pages(token, initial_cursor, request \\ &post/2) do
    attempts(token, initial_cursor, request, 3)
  end

  defp attempts(token, cursor, request, left) do
    paginate(token, cursor, request, [], 0, MapSet.new())
  rescue
    e in Bridge.PlaidError ->
      if e.code == "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" and left > 1,
        do: attempts(token, cursor, request, left - 1),
        else: reraise(e, __STACKTRACE__)
  end

  defp paginate(_, _, _, _, 1000, _), do: raise(ArgumentError, "Page limit exceeded")

  defp paginate(token, cursor, request, pages, count, seen) do
    body = %{access_token: token, count: 500}
    body = if cursor in [nil, ""], do: body, else: Map.put(body, :cursor, cursor)
    page = request.("/transactions/sync", body)

    unless is_map(page) and is_boolean(page["has_more"]) and is_binary(page["next_cursor"]) and
             Enum.all?(~w(added modified removed), &is_list(page[&1])),
           do: raise(ArgumentError, "Malformed sync response")

    next = page["next_cursor"]

    if page["has_more"] do
      if next == "" or next == cursor or MapSet.member?(seen, next),
        do: raise(ArgumentError, "Pagination did not advance")

      paginate(token, next, request, [page | pages], count + 1, MapSet.put(seen, next))
    else
      {Enum.reverse([page | pages]), next}
    end
  end

  def verify_webhook(raw, jwt, request \\ &post/2, now \\ Security.now()) do
    with true <- is_binary(jwt) and byte_size(jwt) <= 4096,
         [header64, claims64, signature64] <- String.split(jwt, "."),
         %{"alg" => "ES256", "kid" => kid} when is_binary(kid) and byte_size(kid) <= 128 <-
           Jason.decode!(Security.decode(header64)),
         %{"key" => key} <- request.("/webhook_verification_key/get", %{key_id: kid}),
         %{"kid" => ^kid, "alg" => "ES256", "kty" => "EC", "crv" => "P-256", "use" => "sig"} <-
           key,
         true <-
           is_nil(key["expired_at"]) or
             (is_integer(key["expired_at"]) and key["expired_at"] > now),
         <<r::unsigned-big-integer-size(256), s::unsigned-big-integer-size(256)>> <-
           Security.decode(signature64),
         <<x::binary-size(32)>> <- Security.decode(key["x"]),
         <<y::binary-size(32)>> <- Security.decode(key["y"]) do
      der = :public_key.der_encode(:"ECDSA-Sig-Value", {:"ECDSA-Sig-Value", r, s})

      valid =
        :crypto.verify(:ecdsa, :sha256, header64 <> "." <> claims64, der, [
          <<4, x::binary, y::binary>>,
          :secp256r1
        ])

      claims = Jason.decode!(Security.decode(claims64))

      valid and is_integer(claims["iat"]) and claims["iat"] <= now + 30 and
        now - claims["iat"] <= 300 and
        Security.equal?(claims["request_body_sha256"], Security.hash(raw))
    else
      _ -> false
    end
  rescue
    _ -> false
  end
end

defmodule Bridge.PlaidError do
  defexception [:code]
  def message(_), do: "Plaid request failed"
end
