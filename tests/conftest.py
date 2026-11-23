"""Shared fixtures: temporary data dir and root, generated images, an app and per-user API clients."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from PIL import Image

from annotamate.server import Settings, create_app, security
from annotamate.server.security import SESSION_COOKIE

CSRF = {"X-Annotamate-Client": "web"}
PASSWORD = "correct-horse"


@pytest.fixture(autouse=True)
def fast_password_hashing(monkeypatch: pytest.MonkeyPatch) -> None:
    """argon2id with minimal cost so the suite stays fast (production keeps the library defaults)."""
    monkeypatch.setattr(security, "hasher", PasswordHasher(time_cost=1, memory_cost=8, parallelism=1))
    monkeypatch.setattr(security, "_dummy_hash", None)


def make_image(path: Path, size: tuple[int, int] = (100, 50), color: str = "red", *, fmt: str | None = None,
               orientation: int | None = None, mode: str = "RGB") -> Path:
    """Write a solid-colour image; ``orientation`` adds an EXIF orientation tag."""
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new(mode, size, color)
    kwargs: dict[str, Any] = {}
    if orientation is not None:
        exif = img.getexif()
        exif[0x0112] = orientation
        kwargs["exif"] = exif.tobytes()
    img.save(path, fmt, **kwargs)
    return path


@pytest.fixture
def root(tmp_path: Path) -> Path:
    path = tmp_path / "root"
    path.mkdir()
    return path


@pytest.fixture
def dataset(root: Path) -> Path:
    """Three 100x50 JPEGs named for natural-sort checks: img1, img2, img10."""
    folder = root / "ds"
    for n in (1, 2, 10):
        make_image(folder / f"img{n}.jpg")
    return folder


@pytest.fixture
def settings(tmp_path: Path, root: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data", roots=[str(root)], static_dir=tmp_path / "no-static")


@pytest.fixture
def app(settings: Settings):
    return create_app(settings)


@pytest.fixture
def client(app) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


class ApiUser:
    """Requests as one user: the session cookie is sent explicitly so several users can share one client."""

    def __init__(self, client: TestClient, token: str, info: dict[str, Any]) -> None:
        self.client = client
        self.token = token
        self.info = info

    @property
    def id(self) -> int:
        return self.info["id"]

    @property
    def cookie(self) -> str:
        return f"{SESSION_COOKIE}={self.token}"

    def request(self, method: str, url: str, *, csrf: bool = True, headers: dict[str, str] | None = None,
                **kwargs: Any):
        all_headers = {"Cookie": self.cookie, **(CSRF if csrf else {}), **(headers or {})}
        self.client.cookies.clear()
        response = self.client.request(method, url, headers=all_headers, **kwargs)
        self.client.cookies.clear()
        return response

    def get(self, url: str, **kwargs: Any):
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs: Any):
        return self.request("POST", url, **kwargs)

    def put(self, url: str, **kwargs: Any):
        return self.request("PUT", url, **kwargs)

    def patch(self, url: str, **kwargs: Any):
        return self.request("PATCH", url, **kwargs)

    def delete(self, url: str, **kwargs: Any):
        return self.request("DELETE", url, **kwargs)

    def ws(self, **headers: str):
        return self.client.websocket_connect("/api/ws", headers={"cookie": self.cookie, **headers})


def login(client: TestClient, username: str, password: str = PASSWORD) -> ApiUser:
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"username": username, "password": password}, headers=CSRF)
    assert response.status_code == 200, response.text
    token = response.cookies[SESSION_COOKIE]
    client.cookies.clear()
    return ApiUser(client, token, response.json())


@pytest.fixture
def admin(client: TestClient) -> ApiUser:
    client.cookies.clear()
    # The test client is not a loopback address, so the one-time setup token printed at start-up is required.
    response = client.post("/api/auth/setup", json={"username": "admin", "display_name": "Ada Admin",
                                                    "password": PASSWORD,
                                                    "setup_token": client.app.state.ctx.setup_token}, headers=CSRF)
    assert response.status_code == 200, response.text
    token = response.cookies[SESSION_COOKIE]
    client.cookies.clear()
    return ApiUser(client, token, response.json())


@pytest.fixture
def make_user(client: TestClient, admin: ApiUser):
    def create(username: str, display_name: str | None = None, *, is_admin: bool = False) -> ApiUser:
        body = {"username": username, "display_name": display_name or username.title(), "password": PASSWORD,
                "is_admin": is_admin}
        response = admin.post("/api/users", json=body)
        assert response.status_code == 200, response.text
        return login(client, username)

    return create


def wait_idle(app) -> None:
    assert app.state.ctx.jobs.wait_idle(30), "background jobs did not finish"


@pytest.fixture
def create_project(app, admin: ApiUser):
    """Create a project as the admin and wait until indexing finished; returns the Project JSON."""

    def create(image_dir: Path, *, label_format: str = "yolo", classes: list[str] | None = None,
               members: list[tuple[ApiUser, str]] | None = None, label_dir: Path | None = None,
               settings: dict[str, Any] | None = None, name: str = "Project") -> dict[str, Any]:
        body: dict[str, Any] = {"name": name, "image_dir": str(image_dir), "label_format": label_format}
        if classes is not None:
            body["classes"] = classes
        if members:
            body["members"] = [{"user_id": u.id, "role": role} for u, role in members]
        if label_dir is not None:
            body["label_dir"] = str(label_dir)
        if settings:
            body["settings"] = settings
        response = admin.post("/api/projects", json=body)
        assert response.status_code == 200, response.text
        wait_idle(app)
        return admin.get(f"/api/projects/{response.json()['id']}").json()

    return create


def images_of(user: ApiUser, project_id: int, **params: Any) -> list[dict[str, Any]]:
    response = user.get(f"/api/projects/{project_id}/images", params=params)
    assert response.status_code == 200, response.text
    return response.json()["items"]


def box(class_id: int | None, x1: float, y1: float, x2: float, y2: float, **extra: Any) -> dict[str, Any]:
    return {"id": extra.pop("id", None) or os.urandom(8).hex(), "class_id": class_id, "raw_label": None,
            "x1": x1, "y1": y1, "x2": x2, "y2": y2, **extra}
