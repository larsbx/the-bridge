ExUnit.start()
if Process.whereis(Bridge.Repo), do: Ecto.Adapters.SQL.Sandbox.mode(Bridge.Repo, :manual)
