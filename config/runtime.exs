import Config

config :bridge, Bridge.Repo,
  url: System.get_env("DATABASE_URL", "ecto://postgres:postgres@localhost/bridge_#{config_env()}")

if config_env() != :test do
  key = fn name ->
    case Base.decode16(System.fetch_env!(name), case: :mixed) do
      {:ok, bytes} when byte_size(bytes) == 32 -> bytes
      _ -> raise "#{name} must contain 64 hex digits"
    end
  end

  session_key = key.("SESSION_KEY")
  data_key = key.("DATA_KEY")
  if session_key == data_key, do: raise("SESSION_KEY and DATA_KEY must differ")
  password = System.fetch_env!("DASHBOARD_PASSWORD")
  if byte_size(password) not in 16..512, do: raise("DASHBOARD_PASSWORD must be at least 16 bytes")
  origin = System.get_env("PUBLIC_URL", "http://localhost:3000") |> String.trim_trailing("/")
  uri = URI.parse(origin)

  unless uri.scheme in ["http", "https"] and is_binary(uri.host) and uri.path in [nil, ""] and
           is_nil(uri.query) and is_nil(uri.userinfo), do: raise("PUBLIC_URL must be an origin")

  if config_env() == :prod and uri.scheme != "https", do: raise("Production requires HTTPS")
  env = System.get_env("PLAID_ENV", "sandbox")
  unless env in ["sandbox", "production"], do: raise("Invalid PLAID_ENV")

  {:ok, host} =
    :inet.parse_address(String.to_charlist(System.get_env("BRIDGE_API_HOST", "127.0.0.1")))

  config :bridge, :settings, %{
    password: password,
    session_key: session_key,
    data_key: data_key,
    origin: origin,
    secure: uri.scheme == "https",
    port: String.to_integer(System.get_env("BRIDGE_API_PORT", "4000")),
    host: host,
    plaid_env: env,
    client_id: System.fetch_env!("PLAID_CLIENT_ID"),
    secret: System.fetch_env!("PLAID_SECRET")
  }
end
