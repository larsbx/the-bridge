defmodule Bridge.MixProject do
  use Mix.Project

  def project do
    [
      app: :bridge,
      version: "0.2.0",
      elixir: "~> 1.18",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: [setup: ["deps.get", "ecto.create", "ecto.migrate"]]
    ]
  end

  def application,
    do: [extra_applications: [:logger, :crypto, :ssl], mod: {Bridge.Application, []}]

  defp deps do
    [
      {:picosat_elixir, "~> 0.2"},
      {:ash, "~> 3.36.1"},
      {:ash_postgres, "~> 2.15.1"},
      {:postgrex, "~> 0.22"},
      {:bandit, "~> 1.13.1"},
      {:plug, "~> 1.19"},
      {:jason, "~> 1.4"},
      {:req, "~> 0.5"},
      {:decimal, ">= 3.1.2 and < 4.0.0"}
    ]
  end
end
