defmodule Bridge.Application do
  use Application

  def start(_, _) do
    children = [
      Bridge.Repo,
      {Registry, keys: :duplicate, name: Bridge.Streams},
      {Task.Supervisor, name: Bridge.Tasks},
      Bridge.LoginLimiter,
      Bridge.Sync
    ]

    children =
      if Application.get_env(:bridge, :http) do
        cfg = Bridge.Security.settings()
        children ++ [{Bandit, plug: Bridge.Web.Router, port: cfg.port, ip: cfg.host}]
      else
        children
      end

    Supervisor.start_link(children, strategy: :one_for_one, name: Bridge.Supervisor)
  end
end
