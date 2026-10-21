defmodule Bridge.Actor do
  @moduledoc "Server-constructed principals. No HTTP input is used to populate roles."
  @enforce_keys [:role]
  defstruct [:role]
end
