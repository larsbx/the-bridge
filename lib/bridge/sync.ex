defmodule Bridge.Sync do
  use GenServer
  alias Bridge.{Store, Security, Events}
  def start_link(_), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  def init(state) do
    if Application.get_env(:bridge, :poll), do: send(self(), :poll)
    {:ok, state}
  end

  def schedule(id), do: GenServer.cast(__MODULE__, {:sync, id})
  def all, do: for(item <- Store.items(Store.sync_actor()), do: schedule(item.item_id))

  def handle_cast({:sync, id}, state) do
    if Map.has_key?(state, id) do
      {:noreply, state}
    else
      task = Task.Supervisor.async_nolink(Bridge.Tasks, fn -> run(id) end)
      {:noreply, Map.put(state, id, task.ref)}
    end
  end

  def handle_info(:poll, state) do
    all()
    Process.send_after(self(), :poll, 15 * 60_000)
    {:noreply, state}
  end

  def handle_info({ref, _}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    {:noreply, Map.reject(state, fn {_, r} -> r == ref end)}
  end

  def handle_info({:DOWN, ref, _, _, _}, state),
    do: {:noreply, Map.reject(state, fn {_, r} -> r == ref end)}

  def run(id, client \\ Bridge.Plaid) do
    result =
      Store.with_item_lock(id, fn ->
        item = Store.item(id)
        token = Security.unseal(item.encrypted_token)
        response = client.accounts(token)
        {pages, cursor} = client.sync_pages(token, item.cursor)
        Store.commit_refresh!(id, response, pages, cursor)
      end)

    Events.publish()
    result
  rescue
    error ->
      # Never log provider payloads, tokens or changesets containing financial data.
      status =
        if match?(%Bridge.PlaidError{code: "ITEM_LOGIN_REQUIRED"}, error),
          do: "needs_relink",
          else: "sync_error"

      Store.with_item_lock(id, fn -> Store.change(Store.item(id), %{status: status}) end)
      Events.publish()
      {:error, status}
  end
end
