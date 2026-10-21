# Fail closed when advisory metadata cannot be fetched (Hex may otherwise use cache).
{:ok, _} = Application.ensure_all_started(:req)
{lock, _} = Code.eval_file("mix.lock")

lock
|> Task.async_stream(
  fn {name, {:hex, package, version, _, _, _, "hexpm", checksum}} ->
    url = "https://hex.pm/api/packages/#{package}/releases/#{version}"
    response = Req.get!(url, receive_timeout: 25_000, retry: false)
    body = response.body

    unless response.status == 200 and is_map(body) and body["checksum"] == checksum and
             Map.has_key?(body, "retirement") and is_nil(body["retirement"]) and
             body["security_advisories"] == [] do
      raise "Package verification/advisory check failed: #{name} #{version}"
    end

    name
  end,
  max_concurrency: 4,
  timeout: 30_000
)
|> Enum.each(fn
  {:ok, _} -> :ok
  failure -> raise "Registry verification incomplete: #{inspect(failure)}"
end)

IO.puts(
  "Verified checksums and retirement/advisory metadata for #{map_size(lock)} locked packages"
)
