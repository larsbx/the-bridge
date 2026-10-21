defmodule Bridge.Finance.Account do
  use Ash.Resource,
    domain: Bridge.Finance,
    data_layer: AshPostgres.DataLayer,
    authorizers: [Ash.Policy.Authorizer]

  postgres do
    table "accounts"
    repo Bridge.Repo

    custom_indexes do
      index [:item_id, :active]
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
        :account_id,
        :name,
        :mask,
        :type,
        :subtype,
        :currency,
        :current_cents,
        :available_cents,
        :limit_cents,
        :active,
        :removed_at,
        :updated_at
      ]

      upsert? true

      upsert_fields [
        :name,
        :mask,
        :type,
        :subtype,
        :currency,
        :current_cents,
        :available_cents,
        :limit_cents,
        :active,
        :removed_at,
        :updated_at
      ]
    end

    update :change do
      primary? true

      accept [
        :name,
        :mask,
        :type,
        :subtype,
        :currency,
        :current_cents,
        :available_cents,
        :limit_cents,
        :active,
        :removed_at,
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

    attribute :account_id, :string do
      allow_nil? false
      primary_key? true
    end

    attribute :name, :string do
      allow_nil? false
    end

    attribute :mask, :string do
      allow_nil? true
    end

    attribute :type, :string do
      allow_nil? false
    end

    attribute :subtype, :string do
      allow_nil? true
    end

    attribute :currency, :string do
      allow_nil? true
    end

    attribute :current_cents, :integer do
      allow_nil? true
    end

    attribute :available_cents, :integer do
      allow_nil? true
    end

    attribute :limit_cents, :integer do
      allow_nil? true
    end

    attribute :active, :boolean do
      allow_nil? false
    end

    attribute :removed_at, :utc_datetime_usec do
      allow_nil? true
    end

    attribute :updated_at, :utc_datetime_usec do
      allow_nil? false
    end
  end
end
