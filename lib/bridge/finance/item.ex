defmodule Bridge.Finance.Item do
  use Ash.Resource,
    domain: Bridge.Finance,
    data_layer: AshPostgres.DataLayer,
    authorizers: [Ash.Policy.Authorizer]

  postgres do
    table "items"
    repo Bridge.Repo
  end

  actions do
    defaults [:read, :destroy]

    create :put do
      primary? true
      accept [:item_id, :encrypted_token, :institution, :cursor, :status, :updated_at]
      upsert? true
      upsert_fields [:encrypted_token, :institution, :cursor, :status, :updated_at]
    end

    update :change do
      primary? true
      accept [:encrypted_token, :institution, :cursor, :status, :updated_at]
      require_atomic? false
    end
  end

  policies do
    policy action_type(:read) do
      authorize_if actor_attribute_equals(:role, :sync)
      authorize_if actor_attribute_equals(:role, :owner)
    end

    policy action_type([:create, :update, :destroy]) do
      authorize_if actor_attribute_equals(:role, :sync)
    end
  end

  attributes do
    attribute :item_id, :string do
      allow_nil? false
      primary_key? true
    end

    attribute :encrypted_token, :string do
      allow_nil? false
      sensitive? true
    end

    attribute :institution, :string do
      allow_nil? false
    end

    attribute :cursor, :string do
      allow_nil? true
    end

    attribute :status, :string do
      allow_nil? false
    end

    attribute :updated_at, :utc_datetime_usec do
      allow_nil? false
    end
  end
end
