"""Request body limits, the pixel budget, decode concurrency and cache stampedes."""

from __future__ import annotations

import threading
import time

import pytest

from annotamate.core import images as core_images
from annotamate.core.images import DiskCache, ImageError, probe
from conftest import CSRF, images_of, make_image, wait_idle

MB = 1024 * 1024


def _chunks(total: int, size: int = 64 * 1024):
    sent = 0
    while sent < total:
        yield b"x" * min(size, total - sent)
        sent += size


# ------------------------------------------------------------------------------------- body limits


def test_oversized_json_body_is_rejected_by_content_length(client):
    response = client.post("/api/auth/login", content=b"x" * (3 * MB),
                           headers={**CSRF, "content-type": "application/json"})
    assert response.status_code == 413
    assert response.json()["code"] == "too_large" and "2 MB" in response.json()["detail"]


def test_streamed_body_without_content_length_is_cut_off(client):
    response = client.post("/api/auth/login", content=_chunks(3 * MB),
                           headers={**CSRF, "content-type": "application/json"})
    assert response.status_code == 413 and response.json()["code"] == "too_large"


def test_body_limit_is_configurable_and_small_bodies_pass(client, app):
    app.state.ctx.settings.max_body_mb = 1
    assert client.post("/api/auth/login", content=b"x" * (MB + 10),
                       headers={**CSRF, "content-type": "application/json"}).status_code == 413
    ok = client.post("/api/auth/login", json={"username": "nobody", "password": "x"}, headers=CSRF)
    assert ok.status_code == 401


def test_settings_endpoint_limit_applies_before_parsing(admin):
    big = {"blob": "y" * (70 * 1024)}
    response = admin.put("/api/me/settings", json=big)
    assert response.status_code == 413 and response.json()["code"] == "too_large"
    assert admin.put("/api/me/settings", json={"theme": "dark"}).status_code == 200


def test_upload_has_its_own_request_limit(admin, app, create_project, root):
    folder = root / "lim"
    make_image(folder / "a.jpg")
    pid = create_project(folder)["id"]
    sample = make_image(root / "s.png", (1200, 1200), "white")
    data = sample.read_bytes()
    assert len(data) < MB
    app.state.ctx.settings.max_upload_request_mb = 1
    two = [("files[]", ("one.png", data + b"\0" * MB, "image/png")),
           ("files[]", ("two.png", data, "image/png"))]
    response = admin.post(f"/api/projects/{pid}/upload", files=two)
    assert response.status_code == 413 and response.json()["code"] == "too_large"
    app.state.ctx.settings.max_upload_request_mb = 1024
    app.state.ctx.settings.max_body_mb = 1  # general JSON limit does not apply to uploads
    ok = admin.post(f"/api/projects/{pid}/upload", files=[("files[]", ("one.png", data, "image/png"))])
    assert ok.status_code == 200 and len(ok.json()["added"]) == 1


# ----------------------------------------------------------------------------------- pixel budget


@pytest.fixture
def one_megapixel(monkeypatch):
    monkeypatch.setattr(core_images, "_max_pixels", 1_000_000)


def test_probe_and_decodes_refuse_images_over_the_budget(tmp_path, one_megapixel):
    path = make_image(tmp_path / "big.png", (1500, 1000))
    with pytest.raises(ImageError, match="too large"):
        probe(str(path))
    with pytest.raises(ImageError, match="too large"):
        core_images.make_thumbnail(str(path), 128, "apply")
    with pytest.raises(ImageError, match="too large"):
        core_images.reencode(str(path), "apply")
    small = make_image(tmp_path / "ok.png", (900, 1000))
    assert probe(str(small)).width == 900


def test_image_detail_reports_over_budget_error_and_upload_skips(admin, create_project, root, monkeypatch):
    folder = root / "bombs"
    make_image(folder / "big.png", (1500, 1000))
    make_image(folder / "small.png", (100, 100))
    project = create_project(folder)
    pid = project["id"]
    monkeypatch.setattr(core_images, "_max_pixels", 1_000_000)
    items = {i["filename"]: i for i in images_of(admin, pid)}
    detail = admin.get(f"/api/projects/{pid}/images/{items['big.png']['id']}").json()
    assert "too large" in detail["error"] and detail["width"] is None
    assert admin.get(f"/api/projects/{pid}/images/{items['small.png']['id']}").json()["error"] is None
    assert admin.get(f"/api/projects/{pid}/images/{items['big.png']['id']}/file").status_code == 404
    doc = admin.get(f"/api/projects/{pid}/images/{items['big.png']['id']}/annotation").json()
    assert doc["readonly_reason"]

    upload = admin.post(f"/api/projects/{pid}/upload", files=[
        ("files[]", ("huge.png", (root / "bombs" / "big.png").read_bytes(), "image/png")),
        ("files[]", ("fine.png", (root / "bombs" / "small.png").read_bytes(), "image/png"))])
    body = upload.json()
    assert [i["filename"] for i in body["added"]] == ["fine.png"]
    assert body["skipped"][0]["filename"] == "huge.png" and "too large" in body["skipped"][0]["reason"]


# ------------------------------------------------------------------------- stampedes and semaphore


def test_disk_cache_produces_once_for_concurrent_requests(tmp_path):
    cache = DiskCache(str(tmp_path / "cache"), 10 * MB)
    calls = []

    def produce() -> bytes:
        calls.append(1)
        time.sleep(0.2)
        return b"payload"

    paths: list[str] = []
    threads = [threading.Thread(target=lambda: paths.append(cache.get_or_create("ab" * 32, ".bin", produce)))
               for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1 and len(set(paths)) == 1 and len(paths) == 8
    assert cache._producing == {}  # no lock bookkeeping left behind


def test_failed_production_does_not_poison_the_key(tmp_path):
    cache = DiskCache(str(tmp_path / "cache"), 10 * MB)

    def boom() -> bytes:
        raise ImageError("Cannot decode image")

    with pytest.raises(ImageError):
        cache.get_or_create("cd" * 32, ".bin", boom)
    assert cache.get_or_create("cd" * 32, ".bin", lambda: b"ok").endswith(".bin")


def test_full_decodes_are_limited_by_a_semaphore(tmp_path, monkeypatch):
    path = make_image(tmp_path / "a.png", (50, 50))
    core_images.configure(decode_slots=2)
    try:
        active = {"now": 0, "max": 0}
        guard = threading.Lock()
        real_open = core_images._open

        def slow_open(p: str):
            with guard:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            time.sleep(0.1)
            try:
                return real_open(p)
            finally:
                with guard:
                    active["now"] -= 1

        monkeypatch.setattr(core_images, "_open", slow_open)
        threads = [threading.Thread(target=core_images.make_thumbnail, args=(str(path), 64, "apply"))
                   for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert active["max"] == 2
    finally:
        core_images.configure()


def test_settings_defaults(settings):
    assert (settings.max_body_mb, settings.max_upload_request_mb, settings.max_image_megapixels) == (2, 1024, 150)


def test_waits_for_background_work(app):
    wait_idle(app)
