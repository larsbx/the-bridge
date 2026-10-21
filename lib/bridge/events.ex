defmodule Bridge.Events do
  def subscribe do
    if Registry.count(Bridge.Streams) >= 20,
      do: {:error, :full},
      else: Registry.register(Bridge.Streams, :events, nil)
  end

  def unsubscribe, do: Registry.unregister(Bridge.Streams, :events)

  def publish(event \\ :refresh) do
    Registry.dispatch(Bridge.Streams, :events, fn entries ->
      for {pid, _} <- entries, do: send(pid, event)
    end)
  end
end
