defmodule Bridge.Finance do
  use Ash.Domain, otp_app: :bridge

  authorization do
    authorize :always
  end

  resources do
    resource Bridge.Finance.Item
    resource Bridge.Finance.Account
    resource Bridge.Finance.Transaction
    resource Bridge.Finance.Session
  end
end
