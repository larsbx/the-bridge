defmodule Bridge.Finance.Session do
  use Ash.Resource,
    domain: Bridge.Finance,
    data_layer: AshPostgres.DataLayer,
    authorizers: [Ash.Policy.Authorizer]

  postgres do
    table "sessions"
    repo Bridge.Repo
  end

  actions do
    defaults [:read, :destroy]

    create :put do
      primary? true
      accept [:token_hash, :expires_at]
      upsert? true
      upsert_fields [:expires_at]
    end

    update :change do
      primary? true
      accept [:expires_at]
      require_atomic? false
    end
  end

  policies do
    policy action_type(:read) do
      authorize_if actor_attribute_equals(:role, :auth)
    end

    policy action_type([:create, :update, :destroy]) do
      authorize_if actor_attribute_equals(:role, :auth)
    end
  end

  attributes do
    attribute :token_hash, :string do
      allow_nil? false
      primary_key? true
    end

    attribute :expires_at, :integer do
      allow_nil? false
    end
  end
end
