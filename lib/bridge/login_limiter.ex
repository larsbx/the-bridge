defmodule Bridge.LoginLimiter do
  use GenServer
  def start_link(_), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  def init(state), do: {:ok, state}
  def allow?(ip), do: GenServer.call(__MODULE__, {:attempt, ip})

  def handle_call({:attempt, ip}, _, state) do
    now = System.monotonic_time(:second)
    state = Map.reject(state, fn {_, {_, expires}} -> expires <= now end)
    {count, expires} = Map.get(state, ip, {0, now + 900})
    # Bound memory and serialize attempts, including successful attempts.
    allowed = count < 5 and (Map.has_key?(state, ip) or map_size(state) < 10_000)
    {:reply, allowed, if(allowed, do: Map.put(state, ip, {count + 1, expires}), else: state)}
  end
end
