defmodule Bridge.Security do
  @moduledoc "Server-only encryption, signed revocable sessions, and session-bound CSRF."
  alias Bridge.Finance.Session
  @auth %Bridge.Actor{role: :auth}
  def settings, do: Application.fetch_env!(:bridge, :settings)
  def now, do: System.system_time(:second)
  def encode(data), do: Base.url_encode64(data, padding: false)
  def decode(data), do: Base.url_decode64!(data, padding: false)
  def hash(data), do: :crypto.hash(:sha256, data) |> Base.encode16(case: :lower)
  def mac(message), do: :crypto.mac(:hmac, :sha256, settings().session_key, message) |> encode()

  def equal?(a, b) when is_binary(a) and is_binary(b),
    do: byte_size(a) == byte_size(b) and Plug.Crypto.secure_compare(a, b)

  def equal?(_, _), do: false

  def password?(input) when is_binary(input) and byte_size(input) <= 512 do
    salt = "bridge-owner-v2"

    :crypto.pbkdf2_hmac(:sha256, input, salt, 600_000, 32)
    |> equal?(:crypto.pbkdf2_hmac(:sha256, settings().password, salt, 600_000, 32))
  end

  def password?(_), do: false

  def seal(plaintext) do
    iv = :crypto.strong_rand_bytes(12)

    {cipher, tag} =
      :crypto.crypto_one_time_aead(:aes_256_gcm, settings().data_key, iv, plaintext, "", true)

    Enum.join(["v1", encode(iv), encode(tag), encode(cipher)], ".")
  end

  def unseal(sealed) do
    ["v1", iv, tag, cipher] = String.split(sealed, ".")

    case :crypto.crypto_one_time_aead(
           :aes_256_gcm,
           settings().data_key,
           decode(iv),
           decode(cipher),
           "",
           decode(tag),
           false
         ) do
      :error -> raise "Invalid encrypted token"
      token -> token
    end
  end

  def create_session do
    expires = now() + 43_200
    payload = "v1.#{expires}.#{encode(:crypto.strong_rand_bytes(20))}"
    token = payload <> "." <> mac(payload)

    Session
    |> Ash.Changeset.for_create(:put, %{token_hash: hash(token), expires_at: expires})
    |> Ash.create!(actor: @auth)

    token
  end

  def valid_signature?(token) when is_binary(token) and byte_size(token) <= 300 do
    with ["v1", expiry, nonce, sig] <- String.split(token, "."),
         {expires, ""} <- Integer.parse(expiry) do
      expires > now() and equal?(sig, mac("v1.#{expiry}.#{nonce}"))
    else
      _ -> false
    end
  end

  def valid_signature?(_), do: false

  def active?(token) do
    valid_signature?(token) and
      not is_nil(Ash.get!(Session, hash(token), actor: @auth, not_found_error?: false))
  end

  def revoke(token) do
    if record = Ash.get!(Session, hash(token), actor: @auth, not_found_error?: false),
      do: Ash.destroy!(record, actor: @auth)

    Bridge.Events.publish(:session_changed)
  end

  def csrf(token), do: mac("csrf:" <> token)
  def csrf?(token, value), do: equal?(csrf(token), value)
end
