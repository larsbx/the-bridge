import Config
config :bridge, Bridge.Repo, pool: Ecto.Adapters.SQL.Sandbox

config :bridge, :settings, %{
  password: "test-passphrase-long-enough",
  session_key: :binary.copy(<<1>>, 32),
  data_key: :binary.copy(<<2>>, 32),
  origin: "http://localhost:3000",
  secure: false,
  port: 3000,
  host: {127, 0, 0, 1},
  plaid_env: "sandbox",
  client_id: "test",
  secret: "test"
}
