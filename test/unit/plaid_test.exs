defmodule Bridge.PlaidTest do
  use ExUnit.Case, async: true
  alias Bridge.{Plaid, Security, Store}

  def page(cursor, more \\ false),
    do: %{
      "next_cursor" => cursor,
      "has_more" => more,
      "added" => [],
      "modified" => [],
      "removed" => []
    }

  test "pagination mutation discards all prior pages and retries original cursor" do
    Process.put(:calls, [])

    request = fn _, body ->
      calls = Process.get(:calls)
      Process.put(:calls, calls ++ [body.cursor])

      case length(calls) do
        0 -> page("intermediate", true)
        1 -> raise Bridge.PlaidError, code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"
        2 -> page("final")
      end
    end

    assert Plaid.sync_pages("secret", "original", request) == {[page("final")], "final"}
    assert Process.get(:calls) == ["original", "intermediate", "original"]
  end

  test "pagination rejects missing fields and nonadvancing cursors" do
    assert_raise ArgumentError, fn -> Plaid.sync_pages("secret", nil, fn _, _ -> %{} end) end

    assert_raise ArgumentError, fn ->
      Plaid.sync_pages("secret", "same", fn _, _ -> page("same", true) end)
    end
  end

  test "missing snapshots are not interpreted as empty; response Item must match" do
    assert Store.validate_accounts!("i", %{"item" => %{"item_id" => "i"}, "accounts" => []}) == []

    for response <- [
          %{},
          %{"accounts" => []},
          %{"item" => %{"item_id" => "other"}, "accounts" => []},
          %{"item" => %{"item_id" => "i"}, "accounts" => nil}
        ] do
      assert_raise ArgumentError, fn -> Store.validate_accounts!("i", response) end
    end
  end

  test "signed webhook validates algorithm, key, body digest, age and signature" do
    {pub, private} = :crypto.generate_key(:ecdh, :secp256r1)
    <<4, x::binary-size(32), y::binary-size(32)>> = pub

    key = %{
      "kid" => "k",
      "alg" => "ES256",
      "kty" => "EC",
      "crv" => "P-256",
      "use" => "sig",
      "x" => Security.encode(x),
      "y" => Security.encode(y),
      "expired_at" => nil
    }

    raw = ~s({"item_id":"i"})
    now = Security.now()

    jwt = fn claims, header ->
      unsigned =
        Security.encode(Jason.encode!(header)) <> "." <> Security.encode(Jason.encode!(claims))

      der = :crypto.sign(:ecdsa, :sha256, unsigned, [private, :secp256r1])
      {:"ECDSA-Sig-Value", r, s} = :public_key.der_decode(:"ECDSA-Sig-Value", der)
      unsigned <> "." <> Security.encode(<<r::256, s::256>>)
    end

    claims = %{"iat" => now, "request_body_sha256" => Security.hash(raw)}
    header = %{"alg" => "ES256", "kid" => "k"}
    token = jwt.(claims, header)
    request = fn _, _ -> %{"key" => key} end
    assert Plaid.verify_webhook(raw, token, request, now)
    refute Plaid.verify_webhook(raw <> " ", token, request, now)
    refute Plaid.verify_webhook(raw, token <> "x", request, now)
    refute Plaid.verify_webhook(raw, jwt.(%{claims | "iat" => now - 301}, header), request, now)
    refute Plaid.verify_webhook(raw, jwt.(%{claims | "iat" => now + 31}, header), request, now)
    refute Plaid.verify_webhook(raw, jwt.(claims, %{header | "alg" => "HS256"}), request, now)

    refute Plaid.verify_webhook(
             raw,
             token,
             fn _, _ -> %{"key" => %{key | "expired_at" => now}} end,
             now
           )
  end
end
