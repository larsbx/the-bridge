defmodule Bridge.SecurityTest do
  use ExUnit.Case, async: true
  alias Bridge.Security

  test "AES-GCM tokens are nondeterministic, authenticated and never plaintext" do
    token = "access-sandbox-secret"
    a = Security.seal(token)
    b = Security.seal(token)
    assert a != b
    refute a =~ token
    assert Security.unseal(a) == token
    [v, iv, tag, ciphertext] = String.split(a, ".")
    tampered = Enum.join([v, iv, tag, Security.encode(Security.decode(ciphertext) <> "x")], ".")
    assert_raise RuntimeError, fn -> Security.unseal(tampered) end
  end

  test "session signatures reject tampering, expiry and malformed input" do
    payload = "v1.#{Security.now() + 60}.nonce"
    token = payload <> "." <> Security.mac(payload)
    assert Security.valid_signature?(token)
    refute Security.valid_signature?(token <> "x")
    old = "v1.#{Security.now() - 1}.nonce"
    refute Security.valid_signature?(old <> "." <> Security.mac(old))
    refute Security.valid_signature?(nil)
    assert Security.csrf?(token, Security.csrf(token))
    refute Security.csrf?(token, "wrong")
    refute Security.csrf?(token <> "x", Security.csrf(token))
  end

  test "password checks reject malformed and incorrect values" do
    assert Security.password?(Security.settings().password)
    refute Security.password?("wrong")
    refute Security.password?(nil)
    refute Security.password?(String.duplicate("x", 513))
  end

  test "untrusted financial strings are escaped in HTML" do
    assert Bridge.Web.HTML.escape(~s(<script a="'">&)) ==
             "&lt;script a=&quot;&#39;&quot;&gt;&amp;"
  end
end
