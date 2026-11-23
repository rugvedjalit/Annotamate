"""The ``annotamate`` command line."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
import uvicorn
from sqlalchemy import select

from annotamate import __version__, cli
from annotamate.server.config import Settings
from annotamate.server.db import Database
from annotamate.server.models import User
from annotamate.server.security import verify_password

ALL_INTERFACES = "0.0.0.0"  # noqa: S104 - a host string under test, nothing binds to it


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.startswith("ANNOTAMATE_"):
            monkeypatch.delenv(name)


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    return tmp_path / "data"


def run(*argv: str) -> int:
    return cli.main(list(argv))


def load_user(data_dir: Path, username: str) -> User | None:
    db = Database(Settings(data_dir=data_dir).db_url)
    try:
        with db.session() as session:
            return session.scalar(select(User).where(User.username == username))
    finally:
        db.dispose()


def test_version(capsys):
    assert run("version") == 0
    assert capsys.readouterr().out.strip() == f"annotamate {__version__}"
    assert __version__ == "2.0.0"


def test_user_create_and_list(data_dir, capsys):
    assert run("user", "create", "Bob", "--password", "secret123", "--display-name", "Bob Builder",
               "--data-dir", str(data_dir)) == 0
    assert "Created user 'bob'" in capsys.readouterr().out
    assert run("user", "create", "root", "--admin", "--password", "secret123", "--data-dir", str(data_dir)) == 0
    capsys.readouterr()

    assert run("user", "list", "--data-dir", str(data_dir)) == 0
    lines = capsys.readouterr().out.splitlines()
    bob = next(line for line in lines if line.startswith("bob"))
    assert "Bob Builder" in bob
    assert "(admin)" not in bob
    root = next(line for line in lines if line.startswith("root"))
    assert "(admin)" in root

    user = load_user(data_dir, "bob")
    assert user is not None
    assert user.display_name == "Bob Builder"
    assert verify_password(user.password_hash, "secret123")[0]


def test_user_list_when_empty(data_dir, capsys):
    assert run("user", "list", "--data-dir", str(data_dir)) == 0
    assert "No users yet." in capsys.readouterr().out


def test_user_create_rejects_duplicates_and_bad_input(data_dir, capsys):
    assert run("user", "create", "bob", "--password", "secret123", "--data-dir", str(data_dir)) == 0
    assert run("user", "create", "bob", "--password", "secret123", "--data-dir", str(data_dir)) == 1
    assert "already taken" in capsys.readouterr().err
    assert run("user", "create", "a!", "--password", "secret123", "--data-dir", str(data_dir)) == 2
    assert "username" in capsys.readouterr().err
    assert run("user", "create", "carol", "--password", "short", "--data-dir", str(data_dir)) == 2
    assert "password" in capsys.readouterr().err


def test_user_create_prompts_for_password(data_dir, monkeypatch):
    answers = iter(["short", "longenough1", "mismatch1", "longenough1", "longenough1"])
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt="": next(answers))
    assert run("user", "create", "dana", "--data-dir", str(data_dir)) == 0
    user = load_user(data_dir, "dana")
    assert user is not None
    assert verify_password(user.password_hash, "longenough1")[0]


def test_user_passwd(data_dir, monkeypatch, capsys):
    assert run("user", "create", "bob", "--password", "secret123", "--data-dir", str(data_dir)) == 0
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt="": "brand-new-pw")
    assert run("user", "passwd", "bob", "--data-dir", str(data_dir)) == 0
    assert "Password changed" in capsys.readouterr().out
    user = load_user(data_dir, "bob")
    assert verify_password(user.password_hash, "brand-new-pw")[0]
    assert not verify_password(user.password_hash, "secret123")[0]
    assert run("user", "passwd", "nobody", "--data-dir", str(data_dir)) == 1


def test_password_change_signs_out_sessions(data_dir, monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from annotamate.server import create_app

    assert run("user", "create", "bob", "--password", "secret123", "--data-dir", str(data_dir)) == 0
    app = create_app(Settings(data_dir=data_dir, roots=[str(tmp_path)], static_dir=tmp_path / "none"))
    with TestClient(app) as client:
        login = client.post("/api/auth/login", json={"username": "bob", "password": "secret123"},
                            headers={"X-Annotamate-Client": "web"})
        assert login.status_code == 200
        assert client.get("/api/me").status_code == 200
        monkeypatch.setattr(cli.getpass, "getpass", lambda prompt="": "brand-new-pw")
        assert run("user", "passwd", "bob", "--data-dir", str(data_dir)) == 0
        assert client.get("/api/me").status_code == 401
        relogin = client.post("/api/auth/login", json={"username": "bob", "password": "brand-new-pw"},
                              headers={"X-Annotamate-Client": "web"})
        assert relogin.status_code == 200


def test_desktop_without_extras(monkeypatch, capsys):
    import annotamate.desktop as desktop

    monkeypatch.setattr(desktop.importlib.util, "find_spec", lambda name: None)
    assert run("desktop") == 1
    err = capsys.readouterr().err
    assert 'pip install "annotamate[desktop]"' in err
    assert "customtkinter" in err


def test_parser_defaults():
    parser = cli.build_parser()
    args = parser.parse_args(["serve"])
    assert args.open is False
    assert args.root is None
    assert parser.parse_args(["serve", "--open"]).open is True
    assert parser.parse_args(["serve", "--root", "a", "--root", "b"]).root == ["a", "b"]
    with pytest.raises(SystemExit):
        parser.parse_args(["user"])


def test_bare_command_serves_and_opens(monkeypatch):
    captured = {}

    def fake_serve(args):
        captured["args"] = args
        return 0

    monkeypatch.setattr(cli, "cmd_serve", fake_serve)
    assert cli.main([]) == 0
    assert captured["args"].command == "serve"
    assert captured["args"].open is True
    assert captured["args"].host is None  # default from settings: 127.0.0.1


@pytest.mark.parametrize(("host", "expected"), [
    ("127.0.0.1", True), ("localhost", True), ("::1", True), ("127.0.0.2", True),
    (ALL_INTERFACES, False), ("192.168.1.5", False), ("::", False), ("example.com", False),
])
def test_is_loopback(host, expected):
    assert cli._is_loopback(host) is expected


def test_display_url():
    assert cli._display_url("127.0.0.1", 8765, "/") == "http://127.0.0.1:8765/"
    assert cli._display_url(ALL_INTERFACES, 8765, "/") == "http://localhost:8765/"
    assert cli._display_url("::1", 9000, "/x/") == "http://[::1]:9000/x/"
    assert cli._display_url("example.com", 80, "/a/b/") == "http://example.com:80/a/b/"


@pytest.fixture
def fake_uvicorn(monkeypatch):
    calls = []

    def fake_run(self, sockets=None):
        calls.append(self.config)

    monkeypatch.setattr(uvicorn.Server, "run", fake_run)
    yield calls
    for config in calls:
        config.app.state.ctx.db.dispose()


def test_serve_on_all_interfaces_warns(tmp_path, data_dir, capsys, fake_uvicorn):
    assert run("serve", "--host", ALL_INTERFACES, "--port", "8799", "--data-dir", str(data_dir),
               "--root", str(tmp_path), "--base-url", "/sub") == 0
    out, err = capsys.readouterr()
    assert "http://localhost:8799/sub/" in out
    assert "No accounts yet" in out
    assert "WARNING" in err
    assert "--secure-cookies" in err
    (config,) = fake_uvicorn
    assert config.host == ALL_INTERFACES
    assert config.port == 8799
    assert config.workers == 1
    assert config.proxy_headers is True
    settings = config.app.state.ctx.settings
    assert settings.base_url == "/sub/"
    assert settings.roots == [os.path.realpath(tmp_path)]
    assert (data_dir / "annotamate.db").exists()


def test_serve_on_loopback_does_not_warn(tmp_path, data_dir, capsys, fake_uvicorn):
    assert run("serve", "--port", "8798", "--data-dir", str(data_dir), "--root", str(tmp_path)) == 0
    out, err = capsys.readouterr()
    assert "http://127.0.0.1:8798/" in out
    assert "WARNING" not in err
    assert fake_uvicorn[0].host == "127.0.0.1"


def test_serve_with_secure_cookies_does_not_warn(tmp_path, data_dir, capsys, fake_uvicorn):
    assert run("serve", "--host", ALL_INTERFACES, "--port", "8797", "--secure-cookies", "--data-dir", str(data_dir),
               "--root", str(tmp_path)) == 0
    assert "WARNING" not in capsys.readouterr().err
    assert fake_uvicorn[0].app.state.ctx.settings.secure_cookies is True


def test_environment_settings_are_used(tmp_path, data_dir, monkeypatch, capsys, fake_uvicorn):
    monkeypatch.setenv("ANNOTAMATE_PORT", "8796")
    monkeypatch.setenv("ANNOTAMATE_DATA_DIR", str(data_dir))
    monkeypatch.setenv("ANNOTAMATE_ROOTS", os.pathsep.join([str(tmp_path), str(tmp_path / "missing")]))
    assert run("serve", "--port", "8795") == 0  # flags override the environment
    settings = fake_uvicorn[0].app.state.ctx.settings
    assert settings.port == 8795
    assert settings.data_dir == data_dir
    assert len(settings.roots) == 2
    capsys.readouterr()
