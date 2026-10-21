defmodule Bridge.Finance.Transaction do
  use Ash.Resource,
    domain: Bridge.Finance,
    data_layer: AshPostgres.DataLayer,
    authorizers: [Ash.Policy.Authorizer]

  postgres do
    table "transactions"
    repo Bridge.Repo

    custom_indexes do
      index [:date]
      index [:item_id, :account_id]
    end
  end

  relationships do
    belongs_to :item, Bridge.Finance.Item do
      source_attribute :item_id
      destination_attribute :item_id
      define_attribute? false
      attribute_type :string
      allow_nil? false
    end
  end

  actions do
    defaults [:read, :destroy]

    create :put do
      primary? true

      accept [
        :item_id,
        :transaction_id,
        :account_id,
        :date,
        :name,
        :merchant,
        :amount_cents,
        :pending,
        :category,
        :currency,
        :updated_at
      ]

      upsert? true

      upsert_fields [
        :account_id,
        :date,
        :name,
        :merchant,
        :amount_cents,
        :pending,
        :category,
        :currency,
        :updated_at
      ]
    end

    update :change do
      primary? true

      accept [
        :account_id,
        :date,
        :name,
        :merchant,
        :amount_cents,
        :pending,
        :category,
        :currency,
        :updated_at
      ]

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

    attribute :transaction_id, :string do
      allow_nil? false
      primary_key? true
    end

    attribute :account_id, :string do
      allow_nil? false
    end

    attribute :date, :date do
      allow_nil? false
    end

    attribute :name, :string do
      allow_nil? false
    end

    attribute :merchant, :string do
      allow_nil? true
    end

    attribute :amount_cents, :integer do
      allow_nil? false
    end

    attribute :pending, :boolean do
      allow_nil? false
    end

    attribute :category, :string do
      allow_nil? false
    end

    attribute :currency, :string do
      allow_nil? true
    end

    attribute :updated_at, :utc_datetime_usec do
      allow_nil? false
    end
  end
end
