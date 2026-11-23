"""Staying fast with many users and large projects: worker threads, pools for slow work, class changes as
background jobs, cached aggregates, indexes and SQLite settings."""

from __future__ import annotations

import io
import os
import threading
import time
from pathlib import Path

import anyio.to_thread
import pytest
from alembic import command
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import inspect, text

from annotamate.core import fsutil
from annotamate.core.fsutil import StagedRewrite, recover_journals
from annotamate.server import Settings, create_app
from annotamate.server.context import AggregateCache
from annotamate.server.db import Database, alembic_config
from annotamate.server.routes import images as image_routes
from annotamate.server.routes import projects as project_routes
from annotamate.server.services import classes as classes_service
from conftest import box, delete_class, images_of, make_image, wait_idle
from test_realtime import hello, receive_until, subscribe

# ------------------------------------------------------------------------------------------- worker threads (L1)


def test_worker_threads_setting(monkeypatch):
    assert Settings().worker_threads == 4
    monkeypatch.setenv("ANNOTAMATE_WORKER_THREADS", "9")
    assert Settings().worker_threads == 9
    for bad in (0, 65):
        with pytest.raises(ValidationError):
            Settings(worker_threads=bad)


def test_worker_threads_limit_the_request_thread_pool(tmp_path, root):
    settings = Settings(data_dir=tmp_path / "data", roots=[str(root)], static_dir=tmp_path / "none", worker_threads=3)
    app = create_app(settings)
    with TestClient(app) as client:
        limiter = client.portal.call(anyio.to_thread.current_default_thread_limiter)
        assert limiter.total_tokens == 3
        assert client.get("/api/health").status_code == 200
    # the SQLite pool follows: one connection per worker thread plus a few for jobs and WebSocket handlers
    assert app.state.ctx.db.engine.pool.size() == 3 + 4


@pytest.fixture
def photos(admin, create_project, root):
    folder = root / "photos"
    make_image(folder / "a.jpg", (400, 300))
    make_image(folder / "turned.jpg", (400, 300), orientation=6)  # needs a re-encode to be served
    project = create_project(folder, classes=["cat"])
    return project["id"], {i["filename"]: i["id"] for i in images_of(admin, project["id"])}


def test_image_decodes_run_on_the_image_pool(admin, photos, monkeypatch):
    pid, ids = photos
    threads: list[str] = []
    real_thumb, real_reencode = image_routes.make_thumbnail, image_routes.reencode

    def spy_thumb(*args):
        threads.append(threading.current_thread().name)
        return real_thumb(*args)

    def spy_reencode(*args):
        threads.append(threading.current_thread().name)
        return real_reencode(*args)

    monkeypatch.setattr(image_routes, "make_thumbnail", spy_thumb)
    monkeypatch.setattr(image_routes, "reencode", spy_reencode)
    url = f"/api/projects/{pid}/images/{ids['a.jpg']}/thumb"
    first = admin.get(url)
    assert first.status_code == 200 and first.headers["content-type"] == "image/webp"
    assert len(threads) == 1 and threads[0].startswith("annotamate-image")
    assert admin.get(url).content == first.content and len(threads) == 1  # cached: no decode, no pool
    # an image the browser can show as it is never reaches the pool; a rotated one is re-encoded there, once
    assert admin.get(f"/api/projects/{pid}/images/{ids['a.jpg']}/file").status_code == 200
    assert len(threads) == 1
    turned = f"/api/projects/{pid}/images/{ids['turned.jpg']}/file"
    assert admin.get(turned).headers["content-type"] == "image/jpeg"
    assert admin.get(turned).status_code == 200
    assert len(threads) == 2 and threads[1].startswith("annotamate-image")


def test_slow_decodes_do_not_hold_request_threads(tmp_path, root, monkeypatch):
    """With a single request thread, a decode that takes long must not stop other requests."""
    from conftest import CSRF, PASSWORD

    folder = root / "slow"
    for n in range(3):
        make_image(folder / f"i{n}.jpg", (200, 100))
    settings = Settings(data_dir=tmp_path / "data", roots=[str(root)], static_dir=tmp_path / "none", worker_threads=1)
    app = create_app(settings)
    release, decoding = threading.Event(), threading.Event()
    real = image_routes.make_thumbnail

    def slow(*args):
        decoding.set()
        assert release.wait(20)
        return real(*args)

    monkeypatch.setattr(image_routes, "make_thumbnail", slow)
    with TestClient(app) as client:
        setup = client.post("/api/auth/setup", headers=CSRF, json={
            "username": "admin", "display_name": "Ada", "password": PASSWORD,
            "setup_token": app.state.ctx.setup_token})
        cookie = {"Cookie": f"annotamate_session={setup.cookies['annotamate_session']}"}
        client.cookies.clear()
        pid = client.post("/api/projects", headers={**CSRF, **cookie},
                          json={"name": "p", "image_dir": str(folder), "label_format": "yolo"}).json()["id"]
        wait_idle(app)
        items = client.get(f"/api/projects/{pid}/images", headers=cookie).json()["items"]
        results: list[int] = []
        workers = [threading.Thread(target=lambda i=i: results.append(
            client.get(f"/api/projects/{pid}/images/{i['id']}/thumb", headers=cookie).status_code)) for i in items]
        for worker in workers:
            worker.start()
        try:
            assert decoding.wait(10)
            started = time.monotonic()
            assert client.get(f"/api/projects/{pid}", headers=cookie).status_code == 200
            assert client.get(f"/api/projects/{pid}/images", headers=cookie).json()["total"] == 3
            assert time.monotonic() - started < 5 and not results  # answered while every decode is still stuck
        finally:
            release.set()
            for worker in workers:
                worker.join(20)
        assert results == [200, 200, 200]


def test_uploads_run_on_the_upload_pool(admin, photos, monkeypatch):
    pid, _ids = photos
    threads: list[str] = []
    real = project_routes.save_uploads

    def spy(*args):
        threads.append(threading.current_thread().name)
        return real(*args)

    monkeypatch.setattr(project_routes, "save_uploads", spy)
    buffer = io.BytesIO()
    from PIL import Image

    Image.new("RGB", (20, 10), "blue").save(buffer, "PNG")
    response = admin.post(f"/api/projects/{pid}/upload", files={"files[]": ("new.png", buffer.getvalue(), "image/png")})
    assert response.status_code == 200 and [i["filename"] for i in response.json()["added"]] == ["new.png"]
    assert len(threads) == 1 and threads[0].startswith("annotamate-upload")


# ------------------------------------------------------------------------------------------- class jobs (L2)


def _labelled(create_project, root, count: int = 5):
    """A YOLO project with classes a/b/c where every image has one box of each of a and c."""
    folder = root / "job"
    for n in range(count):
        make_image(folder / f"i{n}.jpg", (100, 100))
        (folder / f"i{n}.txt").write_text("0 0.5 0.5 0.2 0.2\n2 0.3 0.3 0.1 0.1\n")
    return folder, create_project(folder, classes=["a", "b", "c"])


class Gate:
    """Holds the class job at its first label file until ``open`` is called."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.reached = threading.Event()
        self._open = threading.Event()
        real = classes_service._read

        def held(path: str):
            self.reached.set()
            assert self._open.wait(30)
            return real(path)

        monkeypatch.setattr(classes_service, "_read", held)

    def open(self) -> None:
        self._open.set()


def test_delete_is_a_background_job_and_editing_is_paused_meanwhile(admin, app, create_project, root, monkeypatch):
    folder, project = _labelled(create_project, root)
    pid = project["id"]
    a, b, c = project["classes"]
    ids = {i["filename"]: i["id"] for i in images_of(admin, pid)}
    doc_url = f"/api/projects/{pid}/images/{ids['i0.jpg']}/annotation"
    doc = admin.get(doc_url).json()
    before = (folder / "i0.txt").read_text()
    gate = Gate(monkeypatch)
    with admin.ws() as ws:
        hello(ws)
        subscribe(ws, pid)
        started = time.monotonic()
        response = admin.delete(f"/api/projects/{pid}/classes/{a['id']}", params={"strategy": "delete_boxes"})
        assert response.status_code == 202 and response.json() == {"started": True}
        assert time.monotonic() - started < 5  # the request does not wait for the rewrite
        first = receive_until(ws, "classes.migration")
        assert first == {"type": "classes.migration", "project_id": pid, "kind": "delete", "class_name": "a",
                         "done": 0, "total": 0, "finished": False}
        try:
            assert gate.reached.wait(10)
            detail = admin.get(f"/api/projects/{pid}").json()
            assert detail["class_migration"]["kind"] == "delete" and detail["class_migration"]["class_name"] == "a"
            assert admin.get("/api/projects").json()[0]["class_migration"] is not None

            # every change to labels and classes is refused at once (nothing waits for the job) ...
            started = time.monotonic()
            save = admin.put(doc_url, json={"base_version": doc["version"], "boxes": []})
            assert save.status_code == 409 and save.json()["code"] == "migrating"
            assert "paused" in save.json()["detail"]
            refused = [
                admin.post(f"/api/projects/{pid}/classes", json={"name": "d"}),
                admin.patch(f"/api/projects/{pid}/classes/{b['id']}", json={"name": "bee"}),
                admin.delete(f"/api/projects/{pid}/classes/{c['id']}", params={"strategy": "delete_boxes"}),
                admin.post(f"/api/projects/{pid}/upload", files={"files[]": ("n.png", b"x", "image/png")}),
                admin.get(f"/api/projects/{pid}/export"),
                admin.post(f"/api/projects/{pid}/prune-missing"),
                admin.delete(f"/api/projects/{pid}"),
            ]
            assert [(r.status_code, r.json()["code"]) for r in refused] == [(409, "migrating")] * len(refused)
            assert time.monotonic() - started < 5
            # ... while reads keep working and still show the untouched originals
            assert admin.get(doc_url).json()["boxes"] == doc["boxes"]
            assert len(images_of(admin, pid)) == 5
            assert admin.get(f"/api/projects/{pid}/stats").status_code == 200
            assert (folder / "i0.txt").read_text() == before
            assert [x["name"] for x in admin.get(f"/api/projects/{pid}/classes").json()] == ["a", "b", "c"]
        finally:
            gate.open()
        final = receive_until(ws, "classes.migration", lambda m: m["finished"], max_messages=60)
        assert final["rewritten_files"] == 5 and "error" not in final
        assert final["done"] == final["total"] > 0 and final["class_name"] == "a"
        wait_idle(app)
        updated = receive_until(ws, "images.bulk_updated")
        assert updated["count"] == 5

    detail = admin.get(f"/api/projects/{pid}").json()
    assert detail["class_migration"] is None and [x["name"] for x in detail["classes"]] == ["b", "c"]
    assert (folder / "i0.txt").read_text() == "1 0.3 0.3 0.1 0.1\n"  # "a" is gone, "c" moved from index 2 to 1
    assert (folder / "classes.txt").read_text() == "b\nc\n"
    assert sorted(p.name for p in folder.iterdir() if p.name.startswith(".")) == []
    assert not list(app.state.ctx.settings.journal_dir.iterdir())
    item = images_of(admin, pid)[0]
    assert item["box_count"] == 1 and item["class_ids"] == [c["id"]]
    entry = admin.get(f"/api/projects/{pid}/activity").json()["items"][0]
    assert entry["type"] == "class_deleted" and entry["data"]["rewritten_files"] == 5
    assert entry["user"]["username"] == "admin"
    # editing works again, on the migrated file
    doc = admin.get(doc_url).json()
    saved = admin.put(doc_url, json={"base_version": doc["version"], "boxes": [box(b["id"], 10, 10, 40, 40)]})
    assert saved.status_code == 200


def test_classes_updated_event_follows_the_job(admin, app, create_project, root):
    _folder, project = _labelled(create_project, root, count=2)
    pid = project["id"]
    a, _b, c = project["classes"]
    with admin.ws() as ws:
        hello(ws)
        subscribe(ws, pid)
        admin.delete(f"/api/projects/{pid}/classes/{a['id']}", params={"strategy": "merge", "merge_into": c["id"]})
        assert receive_until(ws, "classes.migration")["kind"] == "merge"
        classes = receive_until(ws, "classes.updated", max_messages=60)
        assert [x["name"] for x in classes["classes"]] == ["b", "c"]
        assert receive_until(ws, "classes.migration", lambda m: m["finished"])["rewritten_files"] == 2
    wait_idle(app)
    stats = admin.get(f"/api/projects/{pid}/stats").json()
    assert stats["class_counts"][1] == {"class_id": c["id"], "boxes": 4, "images": 2}


def test_progress_events_are_sent_while_the_job_works(admin, app, create_project, root, monkeypatch):
    _folder, project = _labelled(create_project, root, count=6)
    pid = project["id"]
    monkeypatch.setattr(classes_service, "PROGRESS_INTERVAL", 0.0)
    with admin.ws() as ws:
        hello(ws)
        subscribe(ws, pid)
        admin.delete(f"/api/projects/{pid}/classes/{project['classes'][0]['id']}",
                     params={"strategy": "delete_boxes"})
        seen = []
        while not seen or not seen[-1]["finished"]:
            seen.append(receive_until(ws, "classes.migration", max_messages=80))
    wait_idle(app)
    running = [m for m in seen if not m["finished"]]
    assert len(running) > 3 and all(m["total"] == 12 for m in running[1:])  # read 6 files, then replace 6
    assert [m["done"] for m in running] == sorted(m["done"] for m in running)
    assert seen[-1]["done"] == seen[-1]["total"] == 12


def test_a_failed_job_restores_every_batch(admin, app, create_project, root, monkeypatch):
    """The rewrite is staged and replaced in batches; a failure in a late batch undoes the earlier ones."""
    folder, project = _labelled(create_project, root, count=7)
    pid = project["id"]
    a = project["classes"][0]
    before = {p.name: p.read_text() for p in folder.glob("*.txt")}
    monkeypatch.setattr(classes_service, "BATCH", 2)
    real = fsutil._replace
    journals_seen: list[int] = []

    def flaky(src: str, dst: str) -> None:
        if dst.endswith("i5.txt") and src.endswith(".tmp"):
            journals_seen.append(len(list(app.state.ctx.settings.journal_dir.glob("*.json"))))
            raise PermissionError(13, "file in use", dst)
        real(src, dst)

    monkeypatch.setattr(fsutil, "_replace", flaky)
    with admin.ws() as ws:
        hello(ws)
        subscribe(ws, pid)
        assert admin.delete(f"/api/projects/{pid}/classes/{a['id']}",
                            params={"strategy": "delete_boxes"}).status_code == 202
        final = receive_until(ws, "classes.migration", lambda m: m["finished"], max_messages=60)
    wait_idle(app)
    assert journals_seen == [4]  # 7 files in batches of 2: one journal per batch
    assert final["code"] == "bad_request" and "Nothing was changed" in final["error"] and "i5.txt" in final["error"]
    assert "rewritten_files" not in final
    assert {p.name: p.read_text() for p in folder.glob("*.txt")} == before
    assert sorted(p.name for p in folder.iterdir() if p.name.startswith(".")) == []
    assert not list(app.state.ctx.settings.journal_dir.iterdir())
    detail = admin.get(f"/api/projects/{pid}").json()
    assert detail["class_migration"] is None and [x["name"] for x in detail["classes"]] == ["a", "b", "c"]
    entry = admin.get(f"/api/projects/{pid}/activity").json()["items"][0]
    assert entry["type"] == "class_delete_failed" and entry["data"]["name"] == "a"
    assert entry["data"]["error"] == final["error"]
    # the project is editable again and a second attempt goes through
    monkeypatch.setattr(fsutil, "_replace", real)
    assert delete_class(admin, app, pid, a["id"], strategy="delete_boxes")["rewritten_files"] == 7


def test_a_failed_database_update_restores_the_files(admin, app, create_project, root, monkeypatch):
    folder, project = _labelled(create_project, root, count=3)
    pid = project["id"]
    before = {p.name: p.read_text() for p in folder.glob("*.txt")}

    def broken(*_args, **_kwargs):
        raise RuntimeError("database is gone")

    monkeypatch.setattr(classes_service, "_after_change", broken)
    failed = delete_class(admin, app, pid, project["classes"][0]["id"], strategy="delete_boxes")
    assert failed["type"] == "class_delete_failed" and failed["code"] == "error"
    assert {p.name: p.read_text() for p in folder.glob("*.txt")} == before
    assert [x["name"] for x in admin.get(f"/api/projects/{pid}/classes").json()] == ["a", "b", "c"]
    assert not list(app.state.ctx.settings.journal_dir.iterdir())


def test_forbid_answers_at_once_when_the_index_knows_the_class_is_used(admin, app, create_project, root):
    _folder, project = _labelled(create_project, root)
    pid = project["id"]
    a, b, _c = project["classes"]
    refused = admin.delete(f"/api/projects/{pid}/classes/{a['id']}")
    assert refused.status_code == 409 and refused.json()["code"] == "in_use" and refused.json()["images"] == 5
    assert app.state.ctx.jobs.wait_idle(1) and admin.get(f"/api/projects/{pid}").json()["class_migration"] is None
    # an unused class in the middle: allowed, and the files are renumbered by the job
    assert delete_class(admin, app, pid, b["id"])["rewritten_files"] == 5


def test_delete_is_refused_while_another_label_job_of_the_project_is_queued(admin, app, create_project, root):
    """A job that waits for the migration must never sit in the queue ahead of it."""
    _folder, project = _labelled(create_project, root, count=2)
    pid = project["id"]
    a = project["classes"][0]
    release = threading.Event()
    app.state.ctx.jobs.submit(("recount", pid), lambda: release.wait(10))
    try:
        refused = admin.delete(f"/api/projects/{pid}/classes/{a['id']}", params={"strategy": "delete_boxes"})
        assert refused.status_code == 409 and refused.json()["code"] == "conflict"
        assert admin.get(f"/api/projects/{pid}").json()["class_migration"] is None
    finally:
        release.set()
    wait_idle(app)
    assert delete_class(admin, app, pid, a["id"], strategy="delete_boxes")["type"] == "class_deleted"


def test_job_stops_cleanly_when_the_server_shuts_down(admin, app, create_project, root, monkeypatch):
    folder, project = _labelled(create_project, root, count=70)
    pid = project["id"]
    before = (folder / "i0.txt").read_text()
    gate = Gate(monkeypatch)
    assert admin.delete(f"/api/projects/{pid}/classes/{project['classes'][0]['id']}",
                        params={"strategy": "delete_boxes"}).status_code == 202
    assert gate.reached.wait(10)
    app.state.ctx.jobs.stopping.set()
    gate.open()
    deadline = time.monotonic() + 20
    while pid in app.state.ctx.migrations and time.monotonic() < deadline:
        time.sleep(0.02)
    app.state.ctx.jobs.stopping.clear()
    assert pid not in app.state.ctx.migrations
    assert (folder / "i0.txt").read_text() == before
    assert sorted(p.name for p in folder.iterdir() if p.name.startswith(".")) == []
    assert [x["name"] for x in admin.get(f"/api/projects/{pid}/classes").json()] == ["a", "b", "c"]


def test_rescan_waits_for_the_class_job(admin, app, create_project, root, monkeypatch):
    """An index pass must not read label files while they are being replaced."""
    _folder, project = _labelled(create_project, root, count=3)
    pid = project["id"]
    a, _b, c = project["classes"]
    gate = Gate(monkeypatch)
    admin.delete(f"/api/projects/{pid}/classes/{a['id']}", params={"strategy": "delete_boxes"})
    assert gate.reached.wait(10)
    assert admin.post(f"/api/projects/{pid}/rescan").status_code == 202
    time.sleep(0.3)
    assert admin.get(f"/api/projects/{pid}").json()["indexing"] is True  # queued behind the migration
    gate.open()
    wait_idle(app)
    items = images_of(admin, pid)
    assert all(i["box_count"] == 1 and i["class_ids"] == [c["id"]] for i in items)


def test_a_running_export_stops_when_the_classes_are_migrated(admin, app, create_project, root):
    """Files read before and after a migration do not belong together: the export ends instead of mixing them."""
    from annotamate.server.context import ClassMigration
    from annotamate.server.errors import ApiError

    _folder, project = _labelled(create_project, root, count=2)
    ctx, pid = app.state.ctx, project["id"]
    guard = ctx.read_guard(pid)
    with guard:
        pass
    with ctx.label_locks(pid):
        ctx.begin_migration(pid, ClassMigration("delete", "a"))
    with pytest.raises(ApiError) as refused, guard:
        pass
    assert refused.value.code == "migrating"
    with ctx.label_locks(pid):
        del ctx.migrations[pid]
    with pytest.raises(ApiError), guard:  # the migration is over, but this read started before it
        pass
    with ctx.read_guard(pid):  # a new export is fine
        pass
    assert ctx.label_locks(pid).acquire(blocking=False)  # the guard never keeps the lock
    ctx.label_locks(pid).release()
    assert admin.get(f"/api/projects/{pid}/export").status_code == 200


# ------------------------------------------------------------------------------- batched journal (fsutil)


class Crash(BaseException):
    """Stands in for the process dying: nothing after it runs, not even the rollback."""


def _files(tmp_path: Path, count: int) -> list[Path]:
    paths = [tmp_path / f"{n}.txt" for n in range(count)]
    for n, path in enumerate(paths):
        path.write_text(f"old {n}")
    return paths


def _stage(rewrite: StagedRewrite, paths: list[Path], batch: int = 2) -> None:
    items = [(str(p), f"new {n}".encode()) for n, p in enumerate(paths)]
    for start in range(0, len(items), batch):
        rewrite.stage(items[start:start + batch])


def _leftovers(folder: Path) -> list[str]:
    return sorted(p.name for p in folder.iterdir() if p.name.startswith("."))


def test_staged_rewrite_keeps_originals_until_commit_and_memory_flat(tmp_path):
    paths = _files(tmp_path, 5)
    journals = tmp_path / "journal"
    rewrite = StagedRewrite(str(journals))
    _stage(rewrite, paths)
    assert rewrite.staged == 5 and [p.read_text() for p in paths] == [f"old {n}" for n in range(5)]
    assert len(list(journals.glob("label-rewrite-*.json"))) == 3
    assert all(isinstance(batch, str) for batch in rewrite._batches)  # only file names are held in memory
    progress: list[int] = []
    rewrite.commit(progress.append)
    assert progress == [2, 4, 5] and [p.read_text() for p in paths] == [f"new {n}" for n in range(5)]
    assert len([n for n in _leftovers(tmp_path) if n.endswith(".bak")]) == 5  # originals kept until finalize
    rewrite.finalize()
    assert _leftovers(tmp_path) == [] and not list(journals.iterdir())


def test_backups_are_hard_links_not_copies(tmp_path):
    paths = _files(tmp_path, 1)
    rewrite = StagedRewrite(str(tmp_path / "journal"))
    original = os.stat(paths[0])
    _stage(rewrite, paths)
    rewrite.commit()
    backup = next(p for p in tmp_path.iterdir() if p.name.endswith(".bak"))
    assert os.stat(backup).st_ino == original.st_ino and backup.read_text() == "old 0"
    assert rewrite.discard() == [] and paths[0].read_text() == "old 0" and _leftovers(tmp_path) == []


def test_discard_restores_all_batches(tmp_path):
    paths = _files(tmp_path, 5)
    journals = tmp_path / "journal"
    rewrite = StagedRewrite(str(journals))
    _stage(rewrite, paths)
    rewrite.commit()
    assert rewrite.discard() == []
    assert [p.read_text() for p in paths] == [f"old {n}" for n in range(5)]
    assert _leftovers(tmp_path) == [] and not list(journals.iterdir())


@pytest.mark.parametrize("crash_at", [1, 2, 3, 4, 5])
def test_crash_while_replacing_batches_is_rolled_back_at_start(tmp_path, monkeypatch, crash_at):
    paths = _files(tmp_path, 5)
    journals = tmp_path / "journal"
    rewrite = StagedRewrite(str(journals))
    _stage(rewrite, paths)
    real = fsutil._replace
    calls = {"n": 0}

    def dying(src: str, dst: str) -> None:
        if src.endswith(".tmp") and not dst.endswith(".json"):
            calls["n"] += 1
            if calls["n"] == crash_at:
                raise Crash
        real(src, dst)

    monkeypatch.setattr(fsutil, "_replace", dying)
    with pytest.raises(Crash):
        rewrite.commit()
    monkeypatch.undo()
    assert [p.read_text() for p in paths][:crash_at - 1] == [f"new {n}" for n in range(crash_at - 1)]
    restored = recover_journals(str(journals))  # the next start
    assert sorted(restored) == sorted(str(p) for p in paths[:crash_at - 1])
    assert [p.read_text() for p in paths] == [f"old {n}" for n in range(5)]
    assert _leftovers(tmp_path) == [] and not list(journals.iterdir())


def test_crash_after_all_files_were_replaced_is_rolled_back(tmp_path):
    """Replaced but not finalized: what depends on the new files (the database) was not stored either."""
    paths = _files(tmp_path, 5)
    journals = tmp_path / "journal"
    rewrite = StagedRewrite(str(journals))
    _stage(rewrite, paths)
    rewrite.commit()
    assert len(recover_journals(str(journals))) == 5
    assert [p.read_text() for p in paths] == [f"old {n}" for n in range(5)]
    assert _leftovers(tmp_path) == [] and not list(journals.iterdir())


def test_crash_while_cleaning_up_a_finished_run_keeps_the_new_files(tmp_path, monkeypatch):
    paths = _files(tmp_path, 5)
    journals = tmp_path / "journal"
    rewrite = StagedRewrite(str(journals))
    _stage(rewrite, paths)
    rewrite.commit()
    real = fsutil._unlink
    calls = {"n": 0}

    def dying(path):
        calls["n"] += 1
        if calls["n"] == 4:  # two backups and the first journal are gone, the rest is still there
            raise Crash
        real(path)

    monkeypatch.setattr(fsutil, "_unlink", dying)
    with pytest.raises(Crash):
        rewrite.finalize()
    monkeypatch.undo()
    assert len(list(journals.glob("*.json"))) == 2 and len(list(journals.glob("*.committed"))) == 1
    assert recover_journals(str(journals)) == []  # nothing is rolled back: the run had completed
    assert [p.read_text() for p in paths] == [f"new {n}" for n in range(5)]
    assert _leftovers(tmp_path) == [] and not list(journals.iterdir())


def test_recovery_only_touches_files_that_hold_the_interrupted_runs_content(tmp_path):
    paths = _files(tmp_path, 4)
    journals = tmp_path / "journal"
    rewrite = StagedRewrite(str(journals))
    _stage(rewrite, paths)
    rewrite.commit()
    paths[1].write_text("saved later")  # changed after the crash: must survive
    assert sorted(recover_journals(str(journals))) == sorted(str(p) for p in (paths[0], paths[2], paths[3]))
    assert [p.read_text() for p in paths] == ["old 0", "saved later", "old 2", "old 3"]
    assert [n for n in _leftovers(tmp_path) if n.endswith(".tmp")] == []
    assert len([n for n in _leftovers(tmp_path) if n.endswith(".bak")]) == 1  # its old content, for inspection


def test_rewrite_without_hard_links_moves_the_original_aside(tmp_path, monkeypatch):
    def no_links(src, dst):
        raise OSError(1, "hard links are not supported", src)

    monkeypatch.setattr(os, "link", no_links)
    journals = tmp_path / "journal"
    paths = _files(tmp_path, 3)
    rewrite = StagedRewrite(str(journals))
    _stage(rewrite, paths)
    rewrite.commit()
    assert [p.read_text() for p in paths] == ["new 0", "new 1", "new 2"]
    assert rewrite.discard() == [] and [p.read_text() for p in paths] == ["old 0", "old 1", "old 2"]

    # a crash between "original moved aside" and "new file in place" leaves no target: recovery puts it back
    rewrite = StagedRewrite(str(journals))
    _stage(rewrite, paths)
    real = fsutil._replace

    def dying(src: str, dst: str) -> None:
        if src.endswith(".tmp") and dst.endswith("1.txt"):
            raise Crash
        real(src, dst)

    monkeypatch.setattr(fsutil, "_replace", dying)
    monkeypatch.setattr(fsutil, "_swap_in", _swap_without_repair)
    with pytest.raises(Crash):
        rewrite.commit()
    assert not paths[1].exists()
    monkeypatch.undo()
    assert sorted(recover_journals(str(journals))) == sorted(str(p) for p in paths[:2])
    assert [p.read_text() for p in paths] == ["old 0", "old 1", "old 2"]
    assert _leftovers(tmp_path) == [] and not list(journals.iterdir())


def _swap_without_repair(entry: dict) -> None:
    """``fsutil._swap_in`` on a file system without hard links, dying before it can undo its first step."""
    if entry["bak"]:
        os.replace(entry["path"], entry["bak"])
    fsutil._replace(entry["tmp"], entry["path"])


def test_startup_recovers_a_crashed_class_job(tmp_path, settings, root):
    """End to end: journals of several batches left by a dead process are undone before the app serves."""
    folder = root / "dead"
    folder.mkdir()
    paths = _files(folder, 5)
    rewrite = StagedRewrite(str(settings.journal_dir))
    _stage(rewrite, paths)
    rewrite.commit()  # ... and the process dies before the database commit
    create_app(settings)
    assert [p.read_text() for p in paths] == [f"old {n}" for n in range(5)]
    assert _leftovers(folder) == [] and not list(settings.journal_dir.iterdir())


def _two_class_project(folder, create_project):
    folder.mkdir()
    for n in range(3):
        make_image(folder / f"i{n}.jpg")
        (folder / f"i{n}.txt").write_text("0 0.5 0.5 0.1 0.1\n1 0.5 0.5 0.1 0.1\n")
    (folder / "classes.txt").write_text("cat\ndog\n")
    project = create_project(folder)
    return project["id"], project["classes"][0]


def test_crash_after_the_database_commit_keeps_the_new_files(admin, app, create_project, root, settings,
                                                             monkeypatch):
    """The class is gone from the database, the run never wrote its marker: the new files must stay."""
    from annotamate.core import fsutil

    folder = root / "commit-point"
    pid, cat = _two_class_project(folder, create_project)
    monkeypatch.setattr(fsutil.StagedRewrite, "finalize", lambda self: None)  # the process dies here
    assert delete_class(admin, app, pid, cat["id"], strategy="delete_boxes")["type"] == "class_deleted"
    assert any(settings.journal_dir.iterdir())  # leftovers of the unfinished run
    monkeypatch.undo()
    create_app(settings)  # next start
    assert [(folder / f"i{n}.txt").read_text() for n in range(3)] == ["0 0.5 0.5 0.1 0.1\n"] * 3  # dog is now 0
    assert (folder / "classes.txt").read_text().split() == ["dog"]
    assert _leftovers(folder) == [] and not list(settings.journal_dir.iterdir())


def test_crash_before_the_database_commit_rolls_back_and_restores_classes_txt(admin, app, create_project, root,
                                                                            settings, monkeypatch):
    """Files were replaced and classes.txt rewritten, the database commit never happened: all of it goes back."""
    from annotamate.core import fsutil
    from annotamate.server.services import classes as classes_service

    folder = root / "before-commit"
    pid, cat = _two_class_project(folder, create_project)
    originals = [(folder / f"i{n}.txt").read_text() for n in range(3)]

    def die_in_store(self, touched, rewritten):
        (folder / "classes.txt").write_text("dog\n")  # what _after_change writes before the commit
        raise RuntimeError("power cut")  # with discard() disabled nothing is undone, as if the process died

    monkeypatch.setattr(classes_service.ClassDeleteJob, "_store", die_in_store)
    monkeypatch.setattr(fsutil.StagedRewrite, "discard", lambda self: [])  # a dead process undoes nothing
    admin.delete(f"/api/projects/{pid}/classes/{cat['id']}", params={"strategy": "delete_boxes"})
    wait_idle(app)
    assert (folder / "i0.txt").read_text() != originals[0]  # replaced on disk ...
    monkeypatch.undo()
    create_app(settings)  # ... and rolled back at the next start, because the class still exists
    assert [(folder / f"i{n}.txt").read_text() for n in range(3)] == originals
    assert (folder / "classes.txt").read_text().split() == ["cat", "dog"]
    assert _leftovers(folder) == [] and not list(settings.journal_dir.iterdir())


# ------------------------------------------------------------------------------------- aggregate cache (L3)


def test_aggregate_cache_reuses_within_the_window_and_recomputes_after_a_write():
    cache = AggregateCache(ttl=60)
    values = iter(range(100))
    assert cache.get(1, "k", lambda: next(values)) == 0
    assert cache.get(1, "k", lambda: next(values)) == 0 and cache.computed == 1
    assert cache.get(1, "other", lambda: next(values)) == 1
    assert cache.get(2, "k", lambda: next(values)) == 2  # per project
    cache.invalidate(1)
    assert cache.get(2, "k", lambda: next(values)) == 2
    assert cache.get(1, "k", lambda: next(values)) == 3 and cache.get(1, "other", lambda: next(values)) == 4
    cache.on_events([(("project", 1), {"type": "chat.message"})])  # not a change of counts
    assert cache.get(1, "k", lambda: next(values)) == 3
    cache.on_events([(("project", 1), {"type": "image.updated"})])
    assert cache.get(1, "k", lambda: next(values)) == 5
    cache.on_events([(("all", None), {"type": "user.updated"})])
    assert cache.get(2, "k", lambda: next(values)) == 6


def test_aggregate_cache_expires():
    cache = AggregateCache(ttl=0.05)
    assert cache.get(1, "k", lambda: "a") == "a"
    assert cache.get(1, "k", lambda: "b") == "a"
    time.sleep(0.08)
    assert cache.get(1, "k", lambda: "b") == "b"


def test_aggregate_cache_is_single_flight():
    cache = AggregateCache(ttl=60)
    release, computing = threading.Event(), threading.Event()
    calls: list[int] = []

    def compute() -> str:
        calls.append(1)
        computing.set()
        assert release.wait(10)
        return "value"

    results: list[str] = []
    threads = [threading.Thread(target=lambda: results.append(cache.get(1, "k", compute))) for _ in range(8)]
    for thread in threads:
        thread.start()
    assert computing.wait(5)
    time.sleep(0.1)
    release.set()
    for thread in threads:
        thread.join(10)
    assert results == ["value"] * 8 and len(calls) == 1


def test_aggregate_cache_serves_the_previous_value_while_an_expired_one_is_refreshed():
    cache = AggregateCache(ttl=0.05)
    assert cache.get(1, "k", lambda: "old") == "old"
    time.sleep(0.08)
    release, computing = threading.Event(), threading.Event()

    def slow() -> str:
        computing.set()
        assert release.wait(10)
        return "new"

    refresher = threading.Thread(target=lambda: cache.get(1, "k", slow))
    refresher.start()
    assert computing.wait(5)
    started = time.monotonic()
    assert cache.get(1, "k", lambda: "unused") == "old" and time.monotonic() - started < 1  # does not wait
    release.set()
    refresher.join(10)
    assert cache.get(1, "k", lambda: "unused") == "new"


def test_aggregate_cache_never_returns_a_value_from_before_the_last_write():
    cache = AggregateCache(ttl=60)
    state = {"value": "before"}
    release, computing = threading.Event(), threading.Event()

    def slow() -> str:
        value = state["value"]  # read ...
        computing.set()
        assert release.wait(10)
        return value            # ... and returned after a write happened

    early: list[str] = []
    first = threading.Thread(target=lambda: early.append(cache.get(1, "k", slow)))
    first.start()
    assert computing.wait(5)
    state["value"] = "after"
    cache.invalidate(1)  # the write commits while the first reader is still computing
    late: list[str] = []
    second = threading.Thread(target=lambda: late.append(cache.get(1, "k", lambda: state["value"])))
    second.start()
    time.sleep(0.1)
    release.set()
    first.join(10)
    second.join(10)
    assert early == ["before"] and late == ["after"]
    assert cache.get(1, "k", lambda: "unused") == "after"


def test_aggregate_cache_does_not_keep_a_failed_computation():
    cache = AggregateCache(ttl=60)

    def broken() -> str:
        raise RuntimeError("database is busy")

    with pytest.raises(RuntimeError):
        cache.get(1, "k", broken)
    assert cache.get(1, "k", lambda: "fine") == "fine"


def test_counts_and_stats_are_computed_once_for_many_readers_and_fresh_after_a_change(admin, app, make_user,
                                                                                      create_project, dataset):
    bob = make_user("bob")
    project = create_project(dataset, classes=["cat"], members=[(bob, "annotator")])
    pid = project["id"]
    cache = app.state.ctx.aggregates
    for _ in range(3):
        assert admin.get(f"/api/projects/{pid}").json()["status_counts"]["todo"] == 3
        assert admin.get("/api/projects").json()[0]["image_count"] == 3
        assert admin.get(f"/api/projects/{pid}/stats").json()["boxes_total"] == 0
        assert admin.get(f"/api/projects/{pid}/members").status_code == 200
    computed = cache.computed
    for _ in range(5):  # nothing changed: every answer comes from the cache
        admin.get(f"/api/projects/{pid}")
        admin.get("/api/projects")
        admin.get(f"/api/projects/{pid}/stats")
        admin.get(f"/api/projects/{pid}/members")
    assert cache.computed == computed

    # a save is visible in the very next read, for the writer and for everyone else
    image = images_of(admin, pid)[0]
    saved = admin.put(f"/api/projects/{pid}/images/{image['id']}/annotation",
                      json={"base_version": None, "boxes": [box(project["classes"][0]["id"], 10, 10, 40, 40)]})
    assert saved.status_code == 200
    detail = admin.get(f"/api/projects/{pid}").json()
    assert detail["status_counts"]["todo"] == 2 and detail["status_counts"]["in_progress"] == 1
    assert bob.get("/api/projects").json()[0]["status_counts"]["in_progress"] == 1
    stats = bob.get(f"/api/projects/{pid}/stats").json()
    assert stats["boxes_total"] == 1 and stats["status_counts"]["in_progress"] == 1
    # assignments too (per-user numbers are cached per user)
    assert bob.get("/api/projects").json()[0]["my_assigned_todo"] == 0
    admin.post(f"/api/projects/{pid}/images/bulk", json={"action": "assign", "assignee_id": bob.id,
                                                         "image_ids": [image["id"]]})
    assert bob.get("/api/projects").json()[0]["my_assigned_todo"] == 1
    assert admin.get("/api/projects").json()[0]["my_assigned_todo"] == 0
    members = {m["user"]["username"]: m for m in admin.get(f"/api/projects/{pid}/members").json()}
    assert members["bob"]["assigned_count"] == 1 and members["admin"]["assigned_count"] == 0
    # a rescan (a background job) refreshes them as well
    os.remove(dataset / "img10.jpg")
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    detail = admin.get(f"/api/projects/{pid}").json()
    assert detail["image_count"] == 2 and detail["missing_count"] == 1


# ------------------------------------------------------------------------------- indexes and SQLite (L4)


def _index_names(engine, table: str) -> set[str]:
    return {index["name"] for index in inspect(engine).get_indexes(table)}


def test_0003_adds_and_removes_the_indexes(tmp_path):
    db = Database(f"sqlite:///{(tmp_path / 'idx.db').as_posix()}")
    cfg = alembic_config(db.engine)
    new_images = {"ix_images_project_missing_status_sort", "ix_images_project_missing_assignee_sort"}
    old_images = {"ix_images_project_status", "ix_images_project_assignee"}

    def migrate(direction, revision: str) -> None:
        with db.engine.begin() as conn:
            cfg.attributes["connection"] = conn
            direction(cfg, revision)

    migrate(command.upgrade, "0002")
    assert old_images <= _index_names(db.engine, "images") and not new_images & _index_names(db.engine, "images")
    with db.engine.begin() as conn:
        conn.execute(text("insert into projects (id, name, description, image_dir, label_format, require_review, "
                          "restrict_to_assigned, annotators_can_add_classes, exif_mode, recursive, archived, "
                          "created_at, updated_at) values (1, 'p', '', 'x', 'yolo', 0, 0, 1, 'apply', 1, 0, "
                          "'2024-01-01', '2024-01-01')"))
        conn.execute(text("insert into images (project_id, rel_path, filename, label_key, missing, sort_index, "
                          "status, flagged, has_label, box_count, unknown_count, comment_count, open_comment_count) "
                          "values (1, 'a.jpg', 'a.jpg', 'a', 0, 0, 'done', 0, 1, 2, 0, 0, 0)"))
    migrate(command.upgrade, "head")
    names = _index_names(db.engine, "images")
    assert new_images <= names and not old_images & names
    assert {"ix_images_project_sort", "ix_images_project_updated", "ix_images_project_label_key"} <= names
    assert "ix_activity_image_id" in _index_names(db.engine, "activity")
    assert "ix_notifications_image_id" in _index_names(db.engine, "notifications")
    assert "ix_chat_messages_image_id" in _index_names(db.engine, "chat_messages")
    columns = {i["name"]: i["column_names"] for i in inspect(db.engine).get_indexes("images")}
    assert columns["ix_images_project_missing_status_sort"] == ["project_id", "missing", "status", "sort_index"]
    assert columns["ix_images_project_missing_assignee_sort"] == ["project_id", "missing", "assignee_id",
                                                                 "sort_index"]

    migrate(command.downgrade, "0002")
    names = _index_names(db.engine, "images")
    assert old_images <= names and not new_images & names
    assert "ix_activity_image_id" not in _index_names(db.engine, "activity")
    assert "ix_notifications_image_id" not in _index_names(db.engine, "notifications")
    assert "ix_chat_messages_image_id" not in _index_names(db.engine, "chat_messages")
    migrate(command.upgrade, "head")
    with db.engine.connect() as conn:
        assert conn.execute(text("select rel_path, status, box_count from images")).all() == [("a.jpg", "done", 2)]
    db.dispose()


def test_filters_and_counts_use_the_new_indexes(tmp_path):
    db = Database(f"sqlite:///{(tmp_path / 'plan.db').as_posix()}")
    db.migrate()

    def plan(sql: str) -> str:
        with db.engine.connect() as conn:
            return " | ".join(row[-1] for row in conn.execute(text("explain query plan " + sql)))

    by_status = plan("select id from images where project_id = 1 and missing = 0 and status = 'review' "
                     "order by sort_index limit 100")
    assert "ix_images_project_missing_status_sort" in by_status and "TEMP B-TREE" not in by_status
    by_assignee = plan("select id from images where project_id = 1 and missing = 0 and assignee_id = 7 "
                       "order by sort_index limit 100")
    assert "ix_images_project_missing_assignee_sort" in by_assignee and "TEMP B-TREE" not in by_assignee
    counts = plan("select missing, status, count(*) from images where project_id = 1 group by missing, status")
    assert "COVERING INDEX ix_images_project_missing_status_sort" in counts
    assert "ix_activity_image_id" in plan("select id from activity where image_id = 5")
    assert "ix_notifications_image_id" in plan("select id from notifications where image_id = 5")
    assert "ix_chat_messages_image_id" in plan("select id from chat_messages where image_id = 5")
    db.dispose()


def test_sqlite_cache_settings_and_optimize(tmp_path):
    db = Database(f"sqlite:///{(tmp_path / 'tune.db').as_posix()}", worker_threads=2)
    assert db.engine.pool.size() == 2 + 4
    db.migrate()
    with db.engine.connect() as conn:
        assert conn.execute(text("pragma cache_size")).scalar() == -65536  # 64 MB
        assert conn.execute(text("pragma mmap_size")).scalar() == 268435456
        assert conn.execute(text("pragma temp_store")).scalar() == 2  # memory
    db.optimize()  # safe on an empty database, and again
    db.optimize()
    db.dispose()


def test_statistics_are_refreshed_after_indexing(admin, app, create_project, dataset, monkeypatch):
    calls: list[int] = []
    real = app.state.ctx.db.optimize
    monkeypatch.setattr(app.state.ctx.db, "optimize", lambda: (calls.append(1), real())[1])
    create_project(dataset)
    assert calls == [1]
