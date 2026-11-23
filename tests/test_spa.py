"""SPA serving, config injection, CSP, base URL handling and the uniform error bodies."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from annotamate.server import Settings, create_app
from annotamate.server.security import SESSION_COOKIE
from conftest import CSRF, PASSWORD

THEME_SCRIPT = "document.documentElement.classList.toggle('dark', localStorage.theme !== 'light')"
INDEX = f"""<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="./favicon.ico" />
    <title>Annotamate</title>
    <script>{THEME_SCRIPT}</script>
    <!--annotamate:config-->
    <script type="module" crossorigin src="./assets/app-abc.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
"""
INLINE_SCRIPT = re.compile(r"<script(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script>", re.DOTALL)
CONFIG = re.compile(r"<script>window\.__ANNOTAMATE__=(\{.*?\})</script>")


@pytest.fixture
def static_dir(tmp_path: Path) -> Path:
    folder = tmp_path / "static"
    (folder / "assets").mkdir(parents=True)
    (folder / "index.html").write_text(INDEX, encoding="utf-8")
    (folder / "assets" / "app-abc.js").write_text("console.log('app')", encoding="utf-8")
    (folder / "favicon.ico").write_bytes(b"\x00\x00\x01\x00")
    (tmp_path / "secret.txt").write_text("top secret", encoding="utf-8")
    return folder


def spa_client(tmp_path: Path, static_dir: Path | None, base_url: str = "/") -> TestClient:
    settings = Settings(data_dir=tmp_path / "data", roots=[str(tmp_path)], base_url=base_url,
                        static_dir=static_dir or tmp_path / "missing")
    return TestClient(create_app(settings))


def csp_directive(csp: str, name: str) -> str:
    for part in csp.split(";"):
        part = part.strip()
        if part.startswith(name + " "):
            return part
    raise AssertionError(f"{name} missing from {csp!r}")


def sha256_source(script: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode() + "'"


@pytest.mark.parametrize("path", ["/", "/p/1/annotate/5", "/login", "/index.html", "/messages/3?x=1"])
def test_index_is_served_for_client_routes(tmp_path, static_dir, path):
    with spa_client(tmp_path, static_dir) as client:
        response = client.get(path)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-cache"
    html = response.text
    assert "<!--annotamate:config-->" not in html
    config = CONFIG.search(html)
    assert config is not None
    assert json.loads(config.group(1)) == {"baseUrl": "/"}
    assert '<base href="/">' in html
    assert html.index('<base href="/">') < html.index('<link rel="icon"')  # before every relative URL


def test_csp_allows_exactly_the_inline_scripts(tmp_path, static_dir):
    with spa_client(tmp_path, static_dir) as client:
        response = client.get("/p/2")
    script_src = csp_directive(response.headers["content-security-policy"], "script-src")
    inline = INLINE_SCRIPT.findall(response.text)
    assert THEME_SCRIPT in inline
    assert any("__ANNOTAMATE__" in s for s in inline)
    for script in inline:
        assert sha256_source(script) in script_src
    assert "'unsafe-inline'" not in script_src
    assert "'self'" in script_src
    csp = response.headers["content-security-policy"]
    assert "img-src 'self' blob: data:" in csp
    assert "connect-src 'self' ws: wss:" in csp


def test_static_files_and_cache_headers(tmp_path, static_dir):
    with spa_client(tmp_path, static_dir) as client:
        asset = client.get("/assets/app-abc.js")
        assert asset.status_code == 200
        assert asset.text == "console.log('app')"
        assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"
        # fixed types, independent of the OS registry (Windows may map .js to text/plain)
        assert asset.headers["content-type"].startswith("text/javascript")
        icon = client.get("/favicon.ico")
        assert icon.status_code == 200
        assert icon.headers["cache-control"] == "no-cache"
        missing = client.get("/assets/x.js")
        assert missing.status_code == 404
        assert missing.json()["code"] == "not_found"
        head = client.head("/p/1")
        assert head.status_code == 200


@pytest.mark.parametrize("path", ["/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/..%5csecret.txt",
                                  "/assets/%2e%2e/%2e%2e/secret.txt"])
def test_static_paths_cannot_escape(tmp_path, static_dir, path):
    with spa_client(tmp_path, static_dir) as client:
        response = client.get(path)
    assert "top secret" not in response.text


def test_unknown_api_paths_are_json_404(tmp_path, static_dir):
    with spa_client(tmp_path, static_dir) as client:
        for path in ("/api/nope", "/api", "/api/projects/1/nothing/here"):
            response = client.get(path)
            assert response.status_code in (401, 404), path
            assert response.headers["content-type"].startswith("application/json")
        response = client.get("/api/nope")
        assert response.status_code == 404
        assert response.json() == {"detail": response.json()["detail"], "code": "not_found"}


def test_missing_build_shows_instructions(tmp_path):
    with spa_client(tmp_path, None) as client:
        response = client.get("/p/1/annotate")
        assert response.status_code == 200
        assert "npm run build" in response.text
        assert response.headers["cache-control"] == "no-cache"
        assert client.get("/api/health").json()["status"] == "ok"


def test_security_headers_on_api_and_spa(tmp_path, static_dir):
    with spa_client(tmp_path, static_dir) as client:
        for path in ("/api/health", "/", "/assets/app-abc.js", "/api/nope"):
            headers = client.get(path).headers
            assert headers["x-content-type-options"] == "nosniff", path
            assert headers["referrer-policy"] == "same-origin", path
            assert headers["x-frame-options"] == "DENY", path
            assert "default-src 'self'" in headers["content-security-policy"], path


# ------------------------------------------------------------------------------------------- base URL


def test_base_url_prefixes_everything(tmp_path, static_dir):
    with spa_client(tmp_path, static_dir, base_url="/x") as client:
        health = client.get("/x/api/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"

        index = client.get("/x/")
        assert index.status_code == 200
        assert json.loads(CONFIG.search(index.text).group(1)) == {"baseUrl": "/x/"}
        assert '<base href="/x/">' in index.text
        deep = client.get("/x/p/1/annotate/2")
        assert '<base href="/x/">' in deep.text
        assert client.get("/x/assets/app-abc.js").status_code == 200

        for outside in ("/x", "/"):
            redirect = client.get(outside, follow_redirects=False)
            assert redirect.status_code in (301, 302, 307, 308), outside
            assert redirect.headers["location"] == "/x/"

        not_api = client.get("/api/health")
        assert not (not_api.status_code == 200 and not_api.headers["content-type"].startswith("application/json")
                    and not_api.json().get("status") == "ok")
        assert client.get("/x/api/nope").json()["code"] == "not_found"


def test_base_url_cookie_csrf_and_websocket(tmp_path, static_dir):
    with spa_client(tmp_path, static_dir, base_url="/x/") as client:
        body = {"username": "admin", "display_name": "Admin", "password": PASSWORD}
        refused = client.post("/x/api/auth/setup", json=body)
        assert refused.status_code == 403
        assert refused.json()["code"] == "csrf"

        response = client.post("/x/api/auth/setup", json=body, headers=CSRF)
        assert response.status_code == 200, response.text
        set_cookie = response.headers["set-cookie"]
        assert "Path=/x/" in set_cookie
        assert "HttpOnly" in set_cookie
        assert "samesite=lax" in set_cookie.lower()
        assert "Secure" not in set_cookie
        token = response.cookies[SESSION_COOKIE]
        client.cookies.clear()

        me = client.get("/x/api/me", headers={"Cookie": f"{SESSION_COOKIE}={token}"})
        assert me.json()["username"] == "admin"
        with client.websocket_connect("/x/api/ws", headers={"cookie": f"{SESSION_COOKIE}={token}"}) as ws:
            hello = ws.receive_json()
            assert hello["type"] == "hello"
            assert hello["user_id"] == me.json()["id"]


def test_secure_cookies_flag(tmp_path, static_dir):
    settings = Settings(data_dir=tmp_path / "data", roots=[str(tmp_path)], secure_cookies=True, static_dir=static_dir)
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/auth/setup", headers=CSRF,
                               json={"username": "admin", "display_name": "Admin", "password": PASSWORD})
        assert "Secure" in response.headers["set-cookie"]


# ------------------------------------------------------------------------------------------- error bodies


def test_validation_errors_have_the_documented_shape(client):
    response = client.post("/api/auth/login", json={}, headers=CSRF)
    assert response.status_code == 422
    body = response.json()
    assert body["code"] == "validation_error"
    assert isinstance(body["detail"], str)
    assert body["errors"]
    for error in body["errors"]:
        assert set(error) == {"loc", "msg"}
        assert all(isinstance(part, str) for part in error["loc"])
    assert ["body", "username"] in [e["loc"] for e in body["errors"]]


def test_unexpected_errors_become_internal_error(settings, monkeypatch):
    app = create_app(settings)

    def explode(_session):
        raise RuntimeError("boom")

    monkeypatch.setattr("annotamate.server.routes.auth.user_count", explode)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/auth/state")
    assert response.status_code == 500
    assert response.json() == {"detail": "Internal server error.", "code": "internal_error"}
    assert "boom" not in response.text


def test_http_errors_use_the_uniform_body(client):
    unauthenticated = client.get("/api/me")
    assert unauthenticated.status_code == 401
    assert unauthenticated.json()["code"] == "unauthenticated"
    wrong_method = client.delete("/api/health", headers=CSRF)
    assert wrong_method.status_code == 405
    assert wrong_method.json()["code"] == "method_not_allowed"
