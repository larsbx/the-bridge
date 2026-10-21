import Config
config :bridge, ecto_repos: [Bridge.Repo], ash_domains: [Bridge.Finance]
config :bridge, Bridge.Repo, pool_size: 10, show_sensitive_data_on_connection_error: false
config :bridge, http: config_env() != :test, poll: config_env() != :test
config :logger, level: :warning
config :ash, :disable_async?, true
config :ash, default_string_length_count: :codepoints
import_config "#{config_env()}.exs"
