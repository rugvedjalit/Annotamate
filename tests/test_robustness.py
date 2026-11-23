"""Data-safety and permission edge cases: stale caches, failing scans, concurrent changes, changing roles."""

from __future__ import annotations

import threading

import pytest

from annotamate.server.services import classes as class_service
from annotamate.server.services.access import load_access
from conftest import delete_class, images_of, make_image, wait_idle


def _receive(ws, type_: str, limit: int = 20) -> dict:
    for _ in range(limit):
        message = ws.receive_json()
        if message["type"] == type_:
            return message
    raise AssertionError(f"no {type_} message")


@pytest.fixture
def yolo(admin, create_project, root):
    folder = root / "yolo"
    for n in range(3):
        make_image(folder / f"i{n}.jpg", (100, 100))
    project = create_project(folder, classes=["a", "b", "c"])
    return folder, project


def test_class_delete_reads_files_not_cached_counts(admin, app, yolo):
    folder, project = yolo
    pid = project["id"]
    a = project["classes"][0]
    # labels written behind the server's back: the cached counts know nothing about them
    (folder / "i0.txt").write_text("0 0.5 0.5 0.1 0.1\n2 0.2 0.2 0.1 0.1\n")
    # the index says "unused", so the request is accepted; the job reads the files and refuses
    forbid = delete_class(admin, app, pid, a["id"])
    assert forbid["type"] == "class_delete_failed" and forbid["code"] == "in_use" and forbid["images"] == 1
    assert (folder / "i0.txt").read_text() == "0 0.5 0.5 0.1 0.1\n2 0.2 0.2 0.1 0.1\n"
    assert [c["name"] for c in admin.get(f"/api/projects/{pid}/classes").json()] == ["a", "b", "c"]
    deleted = delete_class(admin, app, pid, a["id"], strategy="delete_boxes")
    assert deleted["type"] == "class_deleted" and deleted["rewritten_files"] == 1
    assert (folder / "i0.txt").read_text() == "1 0.2 0.2 0.1 0.1\n"  # "c" moved from index 2 to 1
    assert (folder / "classes.txt").read_text() == "b\nc\n"


def test_class_changes_refused_while_indexing(admin, app, yolo, root):
    _, project = yolo
    pid = project["id"]
    release = threading.Event()
    app.state.ctx.jobs.submit(("index", pid), lambda: release.wait(10))
    try:
        cid = project["classes"][0]["id"]
        response = admin.delete(f"/api/projects/{pid}/classes/{cid}")
        assert response.status_code == 409 and response.json()["code"] == "conflict"
        assert admin.get(f"/api/projects/{pid}").json()["indexing"] is True
        assert admin.post(f"/api/projects/{pid}/rescan").json() == {"started": True}  # merged into the queue
    finally:
        release.set()
    wait_idle(app)
    assert delete_class(admin, app, pid, project["classes"][0]["id"])["type"] == "class_deleted"


def test_unreadable_or_empty_folder_never_wipes_the_index(admin, app, yolo, monkeypatch):
    folder, project = yolo
    pid = project["id"]
    image = images_of(admin, pid)[0]
    admin.post(f"/api/projects/{pid}/images/{image['id']}/comments", json={"body": "keep"})

    def unreadable(*_args, **_kwargs):
        raise PermissionError("network share went away")

    monkeypatch.setattr("annotamate.server.services.indexing.scan", unreadable)
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    assert admin.get(f"/api/projects/{pid}").json()["image_count"] == 3
    monkeypatch.undo()

    for path in folder.glob("*.jpg"):
        path.unlink()  # an empty mount point looks like this
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    items = images_of(admin, pid)
    assert len(items) == 3 and items[0]["comment_count"] == 1


def test_rescan_does_not_overwrite_status_changes(admin, app, yolo):
    folder, project = yolo
    pid = project["id"]
    first = images_of(admin, pid)[0]
    (folder / "i0.txt").write_text("0 0.5 0.5 0.1 0.1\n")
    admin.patch(f"/api/projects/{pid}", json={"settings": {"require_review": True}})
    admin.post(f"/api/projects/{pid}/images/{first['id']}/status", json={"action": "submit"})
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    image = images_of(admin, pid)[0]
    assert image["status"] == "review" and image["box_count"] == 1


def test_label_dir_changes_are_admin_only(admin, make_user, create_project, dataset, root):
    bob = make_user("bob")
    project = create_project(dataset, members=[(bob, "manager")])
    pid = project["id"]
    other = root / "elsewhere"
    response = bob.patch(f"/api/projects/{pid}", json={"label_dir": str(other)})
    assert response.status_code == 403
    assert not other.exists()
    assert bob.patch(f"/api/projects/{pid}", json={"description": "fine"}).status_code == 200
    assert admin.patch(f"/api/projects/{pid}", json={"label_dir": str(other)}).status_code == 200


def test_concurrent_class_adds_get_distinct_indexes(app, admin, yolo):
    _, project = yolo
    ctx = app.state.ctx
    errors: list[BaseException] = []

    def add(name: str) -> None:
        try:
            with ctx.db.session() as session:
                from annotamate.server.models import User

                user = session.get(User, admin.id)
                access = load_access(session, user, project["id"])
                class_service.add_class(ctx, session, access, name, None)
        except BaseException as exc:  # surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=add, args=(f"new{n}",)) for n in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    indexes = [c["index"] for c in admin.get(f"/api/projects/{project['id']}/classes").json()]
    assert indexes == list(range(9))


def test_assignee_filter_rejects_non_ascii_digits(admin, yolo):
    _, project = yolo
    response = admin.get(f"/api/projects/{project['id']}/images", params={"assignee": "²"})
    assert response.status_code == 422


def test_demoted_users_lose_locks(admin, make_user, create_project, dataset):
    bob = make_user("bob")
    project = create_project(dataset, members=[(bob, "manager")])
    pid = project["id"]
    image = images_of(admin, pid)[0]
    with bob.ws() as ws:
        _receive(ws, "hello")
        ws.send_json({"type": "subscribe", "project_id": pid})
        _receive(ws, "presence.snapshot")
        ws.send_json({"type": "lock.acquire", "image_id": image["id"]})
        _receive(ws, "lock.granted")
        assert admin.patch(f"/api/projects/{pid}/members/{bob.id}", json={"role": "viewer"}).status_code == 200
        revoked = _receive(ws, "lock.revoked")
        assert revoked["image_id"] == image["id"] and revoked["by"]["id"] == admin.id
        ws.send_json({"type": "lock.acquire", "image_id": image["id"], "force": True})
        error = _receive(ws, "error")
        assert error["code"] == "forbidden"
    # nobody holds the lock any more, so others can save
    assert admin.put(f"/api/projects/{pid}/images/{image['id']}/annotation",
                     json={"base_version": None, "boxes": []}).status_code == 200


def test_demoted_admin_is_evicted_from_foreign_rooms(admin, make_user, create_project, dataset):
    boss = make_user("boss", is_admin=True)
    project = create_project(dataset)
    with boss.ws() as ws:
        _receive(ws, "hello")
        ws.send_json({"type": "subscribe", "project_id": project["id"]})
        _receive(ws, "presence.snapshot")
        assert admin.patch(f"/api/users/{boss.id}", json={"is_admin": False}).status_code == 200
        assert _receive(ws, "error")["code"] == "not_found"
        ws.send_json({"type": "subscribe", "project_id": project["id"]})
        assert _receive(ws, "error")["code"] == "not_found"


def test_restricted_annotator_cannot_lock_others_images(admin, make_user, create_project, dataset):
    alice, bob = make_user("alice"), make_user("bob")
    project = create_project(dataset, members=[(alice, "annotator"), (bob, "annotator")],
                             settings={"restrict_to_assigned": True})
    pid = project["id"]
    image = images_of(admin, pid)[0]
    admin.patch(f"/api/projects/{pid}/images/{image['id']}", json={"assignee_id": bob.id})
    with alice.ws() as ws:
        _receive(ws, "hello")
        ws.send_json({"type": "subscribe", "project_id": pid})
        _receive(ws, "presence.snapshot")
        ws.send_json({"type": "lock.acquire", "image_id": image["id"]})
        error = _receive(ws, "error")
        assert error["code"] == "forbidden" and "assigned" in error["detail"]
    assert bob.put(f"/api/projects/{pid}/images/{image['id']}/annotation",
                   json={"base_version": None, "boxes": []}).status_code == 200


def test_client_connection_resets_are_not_logged_as_errors():
    """Abruptly closed browser sockets must not flood the log; other loop errors still reach the handler."""
    import asyncio

    from annotamate.server.app import quiet_connection_resets

    loop = asyncio.new_event_loop()
    try:
        seen: list[dict] = []
        loop.set_exception_handler(lambda _loop, context: seen.append(context))
        quiet_connection_resets(loop)
        handler = loop.get_exception_handler()
        assert handler is not None
        handler(loop, {"message": "reset", "exception": ConnectionResetError(10054, "reset by peer")})
        handler(loop, {"message": "aborted", "exception": ConnectionAbortedError()})
        assert seen == []
        handler(loop, {"message": "boom", "exception": RuntimeError("real problem")})
        assert [c["message"] for c in seen] == ["boom"]
    finally:
        loop.close()
