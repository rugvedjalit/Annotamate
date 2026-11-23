"""Setup, login/logout, sessions, CSRF, rate limiting, profile and user administration."""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select

from annotamate.server.models import UserSession, utcnow
from annotamate.server.security import SESSION_COOKIE
from conftest import CSRF, PASSWORD, ApiUser, login


def test_health_and_meta(client):
    assert client.get("/api/health").json() == {"status": "ok", "version": "2.0.0"}
    meta = client.get("/api/meta").json()
    assert meta == {"version": "2.0.0", "app_name": "Annotamate", "max_upload_mb": 50}


def test_setup_flow(client):
    state = client.get("/api/auth/state").json()
    assert state == {"setup_required": True, "setup_token_required": True, "user": None}
    response = client.post("/api/auth/setup", json={"username": "Root.User", "display_name": " Root  User ",
                                                    "password": PASSWORD,
                                                    "setup_token": client.app.state.ctx.setup_token}, headers=CSRF)
    assert response.status_code == 200
    user = response.json()
    assert user["username"] == "root.user"
    assert user["display_name"] == "Root User"
    assert user["is_admin"] is True and user["is_active"] is True
    assert user["created_at"].endswith("Z")
    cookie = response.headers["set-cookie"]
    assert f"{SESSION_COOKIE}=" in cookie and "HttpOnly" in cookie and "samesite=lax" in cookie.lower()
    assert "Path=/" in cookie and "Secure" not in cookie
    state = client.get("/api/auth/state").json()
    assert state["setup_required"] is False and state["setup_token_required"] is False
    assert state["user"]["username"] == "root.user"

    client.cookies.clear()
    again = client.post("/api/auth/setup", json={"username": "other", "display_name": "O", "password": PASSWORD},
                        headers=CSRF)
    assert again.status_code == 409 and again.json()["code"] == "setup_done"


def test_setup_validation(client):
    response = client.post("/api/auth/setup", json={"username": "a", "display_name": "", "password": "short"},
                           headers=CSRF)
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    fields = {tuple(e["loc"]) for e in body["errors"]}
    assert ("body", "username") in fields and ("body", "password") in fields
    assert all(isinstance(p, str) for e in body["errors"] for p in e["loc"])


def test_secure_cookie_flag(tmp_path, root):
    from fastapi.testclient import TestClient

    from annotamate.server import Settings, create_app

    app = create_app(Settings(data_dir=tmp_path / "d", roots=[str(root)], secure_cookies=True))
    with TestClient(app) as client:
        response = client.post("/api/auth/setup", json={"username": "admin", "display_name": "A",
                                                        "password": PASSWORD, "setup_token": app.state.ctx.setup_token},
                               headers=CSRF)
        assert "Secure" in response.headers["set-cookie"]


def test_login_logout(client, admin):
    user = login(client, "admin")
    assert user.get("/api/me").json()["username"] == "admin"
    bad = client.post("/api/auth/login", json={"username": "admin", "password": "wrong-password"}, headers=CSRF)
    assert bad.status_code == 401 and bad.json()["code"] == "invalid_credentials"
    unknown = client.post("/api/auth/login", json={"username": "ghost", "password": "whatever1"}, headers=CSRF)
    assert unknown.status_code == 401 and unknown.json()["code"] == "invalid_credentials"

    out = user.post("/api/auth/logout")
    assert out.status_code == 204
    assert f'{SESSION_COOKIE}=""' in out.headers["set-cookie"] or "Max-Age=0" in out.headers["set-cookie"]
    response = user.get("/api/me")
    assert response.status_code == 401 and response.json()["code"] == "unauthenticated"
    assert admin.get("/api/me").status_code == 200  # other sessions are untouched


def test_session_tokens_are_hashed(app, admin):
    with app.state.ctx.db.session() as session:
        stored = session.scalars(select(UserSession.token_hash)).all()
    assert stored and admin.token not in stored
    assert all(len(h) == 64 for h in stored)


def test_sliding_expiry_and_expired_session(app, admin):
    with app.state.ctx.db.session() as session:
        row = session.scalars(select(UserSession)).one()
        row.last_used_at = utcnow() - timedelta(hours=1)
        row.expires_at = utcnow() + timedelta(days=1)
        session.commit()
    response = admin.get("/api/me")
    assert response.status_code == 200
    assert f"{SESSION_COOKIE}=" in response.headers.get("set-cookie", "")
    with app.state.ctx.db.session() as session:
        row = session.scalars(select(UserSession)).one()
        assert row.expires_at > utcnow() + timedelta(days=13)
        row.expires_at = utcnow() - timedelta(seconds=1)
        session.commit()
    assert admin.get("/api/me").status_code == 401


def test_csrf_required_for_mutations(client, admin):
    response = admin.patch("/api/me", json={"display_name": "X"}, csrf=False)
    assert response.status_code == 403 and response.json()["code"] == "csrf"
    response = admin.patch("/api/me", json={"display_name": "X"}, csrf=False, headers={"X-Annotamate-Client": " "})
    assert response.status_code == 403
    assert admin.patch("/api/me", json={"display_name": "X"}, headers={"X-Annotamate-Client": "anything"}) \
        .status_code == 200
    client.cookies.clear()
    login_without = client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
    assert login_without.status_code == 403 and login_without.json()["code"] == "csrf"
    assert admin.get("/api/me", csrf=False).status_code == 200  # reads need no header


def test_login_rate_limit(client, admin):
    for _ in range(10):
        r = client.post("/api/auth/login", json={"username": "admin", "password": "nope-nope"}, headers=CSRF)
        assert r.status_code == 401
    blocked = client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD}, headers=CSRF)
    assert blocked.status_code == 429
    assert blocked.json()["code"] == "rate_limited" and int(blocked.headers["retry-after"]) > 0
    # another username from the same address is not affected
    other = client.post("/api/auth/login", json={"username": "someone", "password": "nope-nope"}, headers=CSRF)
    assert other.status_code == 401
    client.cookies.clear()


def test_rate_limiter_window():
    from annotamate.server.security import LoginRateLimiter

    limiter = LoginRateLimiter(max_failures=2, window=600)
    assert limiter.retry_after("ip", "u") == 0
    limiter.failure("ip", "U")
    limiter.failure("ip", "u")
    assert limiter.retry_after("ip", "u") > 0
    limiter.success("ip", "u")
    assert limiter.retry_after("ip", "u") == 0


def test_profile_and_settings(admin):
    me = admin.patch("/api/me", json={"display_name": "New Name", "email": "ada@example.com",
                                      "avatar_color": "#AABBCC"}).json()
    assert (me["display_name"], me["email"], me["avatar_color"]) == ("New Name", "ada@example.com", "#aabbcc")
    assert admin.patch("/api/me", json={"email": None}).json()["email"] is None
    assert admin.patch("/api/me", json={"avatar_color": "red"}).status_code == 422
    assert admin.patch("/api/me", json={"email": "not-an-email"}).status_code == 422

    assert admin.get("/api/me/settings").json() == {}
    stored = admin.put("/api/me/settings", json={"theme": "light", "shortcuts": {"save": ["Mod+S"]}}).json()
    assert stored["theme"] == "light"
    assert admin.get("/api/me/settings").json() == stored
    big = admin.put("/api/me/settings", json={"blob": "x" * 70000})
    assert big.status_code == 413 and big.json()["code"] == "too_large"
    assert admin.put("/api/me/settings", json=[1, 2]).status_code == 422


def test_change_password_revokes_other_sessions(client, admin):
    other = login(client, "admin")
    wrong = admin.post("/api/me/password", json={"current_password": "nope", "new_password": "new-password"})
    assert wrong.status_code == 400
    short = admin.post("/api/me/password", json={"current_password": PASSWORD, "new_password": "short"})
    assert short.status_code == 422
    ok = admin.post("/api/me/password", json={"current_password": PASSWORD, "new_password": "new-password"})
    assert ok.status_code == 204
    assert admin.get("/api/me").status_code == 200
    assert other.get("/api/me").status_code == 401
    assert login(client, "admin", "new-password").get("/api/me").status_code == 200


def test_user_admin(client, admin, make_user):
    bob = make_user("bob", "Bob Builder")
    created = admin.post("/api/users", json={"username": "carol", "display_name": "Carol", "password": PASSWORD,
                                             "email": "c@example.com"})
    assert created.status_code == 200 and created.json()["email"] == "c@example.com"
    dup = admin.post("/api/users", json={"username": "BOB", "display_name": "B", "password": PASSWORD})
    assert dup.status_code == 409 and dup.json()["code"] == "exists"
    assert bob.post("/api/users", json={"username": "x" * 3, "display_name": "x", "password": PASSWORD}) \
        .status_code == 403

    users = bob.get("/api/users").json()
    assert [u["display_name"] for u in users] == sorted((u["display_name"] for u in users), key=str.lower)
    assert all("online" in u for u in users)
    assert bob.get("/api/users", params={"include_inactive": "true"}).status_code == 403

    carol_id = created.json()["id"]
    patched = admin.patch(f"/api/users/{carol_id}", json={"is_admin": True, "display_name": "Carol C"}).json()
    assert patched["is_admin"] is True and patched["display_name"] == "Carol C"
    assert admin.patch(f"/api/users/{admin.id}", json={"is_active": False}).status_code == 400
    assert admin.patch(f"/api/users/{admin.id}", json={"is_admin": False}).status_code == 400
    assert admin.patch("/api/users/9999", json={"is_admin": True}).status_code == 404

    # deactivation revokes sessions and blocks login
    assert admin.patch(f"/api/users/{bob.id}", json={"is_active": False}).json()["is_active"] is False
    assert bob.get("/api/me").status_code == 401
    denied = client.post("/api/auth/login", json={"username": "bob", "password": PASSWORD}, headers=CSRF)
    assert denied.status_code == 403
    client.cookies.clear()
    names = [u["username"] for u in admin.get("/api/users").json()]
    assert "bob" not in names
    assert "bob" in [u["username"] for u in admin.get("/api/users", params={"include_inactive": True}).json()]

    # admin password reset revokes the user's sessions
    admin.patch(f"/api/users/{bob.id}", json={"is_active": True})
    bob = login(client, "bob")
    assert admin.post(f"/api/users/{bob.id}/password", json={"new_password": "reset-pass"}).status_code == 204
    assert bob.get("/api/me").status_code == 401
    assert login(client, "bob", "reset-pass").get("/api/me").status_code == 200


def test_unauthenticated_requests(client, admin):
    client.cookies.clear()
    for method, url in (("GET", "/api/me"), ("GET", "/api/projects"), ("GET", "/api/users"), ("GET", "/api/dm"),
                        ("GET", "/api/notifications")):
        response = client.request(method, url)
        assert response.status_code == 401, url
        assert response.json() == {"detail": "Please sign in.", "code": "unauthenticated"}
    forged = ApiUser(client, "forged-token", {"id": 0})
    assert forged.get("/api/me").status_code == 401


# ------------------------------------------------------------------------------------- first-run setup token


def _setup_body(**extra):
    return {"username": "root", "display_name": "Root", "password": PASSWORD, **extra}


def test_setup_needs_the_token_from_remote_clients(client):
    ctx = client.app.state.ctx
    assert ctx.setup_token and len(ctx.setup_token) >= 16
    missing = client.post("/api/auth/setup", json=_setup_body(), headers=CSRF)
    assert missing.status_code == 422 and ("body", "setup_token") in {tuple(e["loc"]) for e in missing.json()["errors"]}
    wrong = client.post("/api/auth/setup", json=_setup_body(setup_token="nope"), headers=CSRF)
    assert wrong.status_code == 422
    assert client.get("/api/auth/state").json()["setup_required"] is True
    ok = client.post("/api/auth/setup", json=_setup_body(setup_token=f" {ctx.setup_token} "), headers=CSRF)
    assert ok.status_code == 200
    assert ctx.setup_token is None  # used up


def test_loopback_clients_need_no_token(app):
    from fastapi.testclient import TestClient

    for host in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
        assert TestClient(app, client=(host, 50000)).get("/api/auth/state").json()["setup_token_required"] is False
    local = TestClient(app, client=("127.0.0.1", 50000))
    assert local.post("/api/auth/setup", json=_setup_body(), headers=CSRF).status_code == 200


def test_token_is_logged_at_startup_and_not_created_when_accounts_exist(tmp_path, root, caplog):
    import logging

    from annotamate.server import Settings, create_app

    settings = Settings(data_dir=tmp_path / "d", roots=[str(root)])
    with caplog.at_level(logging.WARNING, logger="annotamate.server"):
        first = create_app(settings)
    assert first.state.ctx.setup_token and first.state.ctx.setup_token in caplog.text
    from fastapi.testclient import TestClient

    TestClient(first, client=("127.0.0.1", 1)).post("/api/auth/setup", json=_setup_body(), headers=CSRF)
    assert create_app(settings).state.ctx.setup_token is None


def test_concurrent_setups_create_exactly_one_administrator(app):
    import threading

    from fastapi.testclient import TestClient

    from annotamate.server.models import User

    results: list[int] = []
    barrier = threading.Barrier(6)

    def attempt(n: int) -> None:
        local = TestClient(app, client=("127.0.0.1", 40000 + n))
        barrier.wait()
        body = _setup_body(username=f"root{n}")
        results.append(local.post("/api/auth/setup", json=body, headers=CSRF).status_code)

    threads = [threading.Thread(target=attempt, args=(n,)) for n in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(results) == [200, 409, 409, 409, 409, 409]
    with app.state.ctx.db.session() as session:
        assert len(list(session.scalars(select(User)))) == 1


def test_user_list_hides_private_fields_from_non_admins(admin, make_user):
    ann = make_user("ann", "Ann")
    seen = ann.get("/api/users").json()
    assert {u["username"] for u in seen} == {"admin", "ann"}
    assert all(set(u) == {"id", "username", "display_name", "avatar_color", "online"} for u in seen)
    full = admin.get("/api/users").json()
    assert all({"email", "is_admin", "is_active", "created_at", "last_seen_at", "online"} <= set(u) for u in full)
    assert ann.get("/api/users", params={"include_inactive": True}).status_code == 403


def test_rate_limiter_limits_an_address_across_usernames():
    from annotamate.server.security import LoginRateLimiter

    limiter = LoginRateLimiter(max_failures=10, window=600, max_ip_failures=5)
    for n in range(5):
        limiter.failure("1.2.3.4", f"user{n}")
    assert limiter.retry_after("1.2.3.4", "someone-new") > 0  # one more username does not help
    assert limiter.retry_after("5.6.7.8", "someone-new") == 0
    limiter.success("1.2.3.4", "user0")  # a good login does not reset the address-wide counter
    assert limiter.retry_after("1.2.3.4", "user0") > 0


def test_password_hashing_is_limited_to_a_few_at_a_time(monkeypatch):
    import threading
    import time

    from annotamate.server import security

    state = {"now": 0, "max": 0}
    guard = threading.Lock()

    class SlowHasher:
        def verify(self, _hash, _password):
            with guard:
                state["now"] += 1
                state["max"] = max(state["max"], state["now"])
            time.sleep(0.05)
            with guard:
                state["now"] -= 1

        def check_needs_rehash(self, _hash):
            return False

    monkeypatch.setattr(security, "hasher", SlowHasher())
    threads = [threading.Thread(target=security.verify_password, args=("h", "pw")) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert 1 < state["max"] <= security.HASH_SLOTS



def test_address_wide_limit_applies_to_public_addresses_only():
    from annotamate.server.security import LoginRateLimiter

    limiter = LoginRateLimiter(max_failures=10, window=600, max_ip_failures=3)
    for address in ("127.0.0.1", "10.0.0.7", "172.17.0.1", "192.168.1.20", "fd00::1"):
        for n in range(5):
            limiter.failure(address, f"user{n}")
        # a proxy or NAT gateway seen as one private address must not lock everybody out ...
        assert limiter.retry_after(address, "someone-else") == 0, address
        # ... while each account keeps its own limit
        for _ in range(10):
            limiter.failure(address, "victim")
        assert limiter.retry_after(address, "victim") > 0
    off = LoginRateLimiter(max_failures=10, window=600, max_ip_failures=0)
    for n in range(50):
        off.failure("1.2.3.4", f"user{n}")
    assert off.retry_after("1.2.3.4", "someone-else") == 0


def test_login_ip_limit_comes_from_the_settings(tmp_path, root):
    from annotamate.server import Settings, create_app

    app = create_app(Settings(data_dir=tmp_path / "d", roots=[str(root)], login_ip_limit=7))
    assert app.state.ctx.limiter.max_ip_failures == 7


def test_proxied_requests_need_the_setup_token_even_from_loopback(app):
    from fastapi.testclient import TestClient

    local = TestClient(app, client=("127.0.0.1", 50000))
    for header in ("X-Forwarded-For", "Forwarded", "X-Real-IP", "Via"):
        headers = {**CSRF, header: "203.0.113.9"}
        assert local.get("/api/auth/state", headers=headers).json()["setup_token_required"] is True, header
        refused = local.post("/api/auth/setup", json=_setup_body(), headers=headers)
        assert refused.status_code == 422, header
    token = app.state.ctx.setup_token
    ok = local.post("/api/auth/setup", json=_setup_body(setup_token=token),
                    headers={**CSRF, "X-Forwarded-For": "203.0.113.9"})
    assert ok.status_code == 200
