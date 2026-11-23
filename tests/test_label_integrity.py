"""Shared label files, rescans that keep history, missing images and interrupted class renames."""

from __future__ import annotations

import os

from annotamate.server.services.paths import CASE_INSENSITIVE_FS
from conftest import box, images_of, make_image, wait_idle


def _ids(user, pid):
    return {i["filename"]: i["id"] for i in images_of(user, pid)}


def _annotation(user, pid, iid):
    return user.get(f"/api/projects/{pid}/images/{iid}/annotation")


# --------------------------------------------------------------------------------- shared label stems


def test_images_sharing_a_stem_share_nothing_but_the_first_owns_the_file(admin, create_project, root):
    folder = root / "stems"
    make_image(folder / "a.jpg")
    make_image(folder / "a.png")
    make_image(folder / "B.jpg")
    make_image(folder / "b.png")
    (folder / "a.txt").write_text("0 0.5 0.5 0.2 0.2\n")
    project = create_project(folder, classes=["cat"])
    pid, cat = project["id"], project["classes"][0]["id"]
    ids = _ids(admin, pid)
    items = {i["filename"]: i for i in images_of(admin, pid)}
    assert items["a.jpg"]["box_count"] == 1 and items["a.png"]["box_count"] == 0

    owner = _annotation(admin, pid, ids["a.jpg"]).json()
    assert owner["readonly_reason"] is None and len(owner["boxes"]) == 1
    shared = _annotation(admin, pid, ids["a.png"]).json()
    assert "a.jpg" in shared["readonly_reason"] and shared["boxes"] == [] and shared["version"] is None

    url = f"/api/projects/{pid}/images/{ids['a.png']}/annotation"
    refused = admin.put(url, json={"base_version": None, "boxes": [box(cat, 5, 5, 20, 20)]})
    assert refused.status_code == 409 and refused.json()["code"] == "readonly"
    assert (folder / "a.txt").read_text() == "0 0.5 0.5 0.2 0.2\n"
    assert admin.put(f"/api/projects/{pid}/images/{ids['a.jpg']}/annotation",
                     json={"base_version": owner["version"], "boxes": [box(cat, 5, 5, 20, 20)]}).status_code == 200

    # B.jpg -> B.txt and b.png -> b.txt: one file only where the file system ignores case
    assert _annotation(admin, pid, ids["B.jpg"]).json()["readonly_reason"] is None
    other = _annotation(admin, pid, ids["b.png"]).json()["readonly_reason"]
    if CASE_INSENSITIVE_FS:
        assert "B.jpg" in other
    else:
        assert other is None


def test_yolo_image_named_classes_is_read_only_and_classes_txt_is_untouched(admin, create_project, root):
    folder = root / "reserved"
    make_image(folder / "classes.jpg")
    make_image(folder / "x.jpg")
    (folder / "classes.txt").write_text("cat\ndog\n")
    project = create_project(folder)
    pid = project["id"]
    ids = _ids(admin, pid)
    doc = _annotation(admin, pid, ids["classes.jpg"]).json()
    assert "reserved" in doc["readonly_reason"] and doc["boxes"] == []
    refused = admin.put(f"/api/projects/{pid}/images/{ids['classes.jpg']}/annotation",
                        json={"base_version": None, "boxes": [box(project["classes"][0]["id"], 5, 5, 20, 20)]})
    assert refused.status_code == 409
    assert (folder / "classes.txt").read_text() == "cat\ndog\n"
    # a class migration must not treat classes.txt as an image label
    dog = project["classes"][1]
    deleted = admin.delete(f"/api/projects/{pid}/classes/{dog['id']}", params={"strategy": "delete_boxes"})
    assert deleted.status_code == 200
    assert (folder / "classes.txt").read_text() == "cat\n"


def test_upload_skips_stem_collisions_and_reserved_names(admin, create_project, root):
    folder = root / "up"
    make_image(folder / "a.jpg")
    project = create_project(folder, classes=["cat"])
    pid = project["id"]
    sample = make_image(root / "sample.png")
    data = sample.read_bytes()
    response = admin.post(f"/api/projects/{pid}/upload", files=[
        ("files[]", ("a.png", data, "image/png")),        # shares a.txt with a.jpg
        ("files[]", ("A.PNG", data, "image/png")),        # same, other case
        ("files[]", ("classes.png", data, "image/png")),  # reserved for YOLO
        ("files[]", ("a.jpg", data, "image/png")),        # same name: stored as a-1.jpg
        ("files[]", ("fresh.png", data, "image/png"))])
    assert response.status_code == 200, response.text
    body = response.json()
    # A.PNG -> A.txt is the same file as a.txt only where the file system ignores case.
    other_case = [] if CASE_INSENSITIVE_FS else ["A.PNG"]
    assert sorted(i["filename"] for i in body["added"]) == sorted(["a-1.jpg", "fresh.png", *other_case])
    reasons = {s["filename"]: s["reason"] for s in body["skipped"]}
    assert set(reasons) == {"a.png", "classes.png"} | ({"A.PNG"} if CASE_INSENSITIVE_FS else set())
    assert "a.jpg" in reasons["a.png"] and "reserved" in reasons["classes.png"]
    on_disk = sorted(n for n in os.listdir(folder) if n.endswith((".jpg", ".png", ".PNG")))
    assert on_disk == sorted(["a-1.jpg", "a.jpg", "fresh.png", *other_case])


def test_voc_project_allows_an_image_named_classes(admin, create_project, root):
    folder = root / "voc"
    make_image(folder / "classes.jpg")
    project = create_project(folder, label_format="voc", classes=["cat"])
    iid = images_of(admin, project["id"])[0]["id"]
    assert _annotation(admin, project["id"], iid).json()["readonly_reason"] is None


# --------------------------------------------------------------------------- rescans and missing images


def test_rescan_never_changes_workflow_status(admin, app, create_project, dataset):
    project = create_project(dataset)
    pid = project["id"]
    ids = _ids(admin, pid)
    admin.post(f"/api/projects/{pid}/images/{ids['img1.jpg']}/status", json={"action": "start"})
    before = {i["filename"]: i["status"] for i in images_of(admin, pid)}
    (dataset / "img1.txt").write_text("0 0.5 0.5 0.1 0.1\n")
    (dataset / "img2.txt").write_text("0 0.5 0.5 0.1 0.1\n")
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    assert {i["filename"]: i["status"] for i in images_of(admin, pid)} == before
    make_image(dataset / "img3.jpg")
    (dataset / "img3.txt").write_text("0 0.5 0.5 0.1 0.1\n")
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    assert {i["filename"]: i["status"] for i in images_of(admin, pid)}["img3.jpg"] == "done"  # new rows only


def test_missing_images_are_hidden_kept_and_restored(admin, make_user, app, create_project, dataset):
    ann = make_user("ann")
    project = create_project(dataset, classes=["cat"], members=[(ann, "annotator")])
    pid = project["id"]
    ids = _ids(admin, pid)
    cat = project["classes"][0]["id"]
    admin.put(f"/api/projects/{pid}/images/{ids['img10.jpg']}/annotation",
              json={"base_version": None, "boxes": [box(cat, 5, 5, 20, 20)]})
    admin.post(f"/api/projects/{pid}/images/{ids['img10.jpg']}/comments", json={"body": "remember me"})
    os.remove(dataset / "img10.jpg")
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)

    assert [i["filename"] for i in images_of(admin, pid)] == ["img1.jpg", "img2.jpg"]
    detail = admin.get(f"/api/projects/{pid}").json()
    assert detail["image_count"] == 2 and detail["missing_count"] == 1
    assert admin.get(f"/api/projects/{pid}/images/{ids['img10.jpg']}").status_code == 404
    stats = admin.get(f"/api/projects/{pid}/stats").json()
    assert stats["images_total"] == 2 and stats["boxes_total"] == 0
    assert stats["class_counts"][0]["images"] == 0 and stats["class_counts"][0]["boxes"] == 0
    assert ann.get("/api/projects").json()[0]["missing_count"] == 1
    flagged = admin.post(f"/api/projects/{pid}/images/bulk", json={"image_ids": [ids["img10.jpg"]], "action": "flag"})
    assert flagged.status_code == 400
    nb = admin.get(f"/api/projects/{pid}/images/{ids['img2.jpg']}/neighbors").json()
    assert nb["next_id"] is None and nb["total"] == 2
    assert admin.get(f"/api/projects/{pid}/export", params={"scope": "all"}).status_code == 200

    # the file comes back: the same row, with its history and workflow state
    make_image(dataset / "img10.jpg")
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    items = {i["filename"]: i for i in images_of(admin, pid)}
    assert items["img10.jpg"]["id"] == ids["img10.jpg"] and items["img10.jpg"]["comment_count"] == 1
    assert items["img10.jpg"]["box_count"] == 1
    assert admin.get(f"/api/projects/{pid}").json()["missing_count"] == 0


def test_prune_missing_removes_rows_for_good(admin, make_user, app, create_project, dataset):
    ann = make_user("ann")
    project = create_project(dataset, members=[(ann, "annotator")])
    pid = project["id"]
    os.remove(dataset / "img1.jpg")
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    assert ann.post(f"/api/projects/{pid}/prune-missing").status_code == 403
    assert admin.post(f"/api/projects/{pid}/prune-missing").json() == {"removed": 1}
    assert admin.get(f"/api/projects/{pid}").json()["missing_count"] == 0
    assert admin.post(f"/api/projects/{pid}/prune-missing").json() == {"removed": 0}
    make_image(dataset / "img1.jpg")
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    assert [i["filename"] for i in images_of(admin, pid)] == ["img1.jpg", "img2.jpg", "img10.jpg"]


# ------------------------------------------------------------------------------ interrupted renames


def _voc(folder, name, label="car"):
    make_image(folder / f"{name}.jpg", (100, 100))
    (folder / f"{name}.xml").write_text(
        f"<annotation><object><name>{label}</name><bndbox><xmin>1</xmin><ymin>1</ymin><xmax>9</xmax>"
        "<ymax>9</ymax></bndbox></object></annotation>")


def test_interrupted_rename_is_resumed_and_reads_map_the_old_name(admin, app, create_project, root, monkeypatch):
    from sqlalchemy import select

    from annotamate.server.models import PendingRename
    from annotamate.server.services import classes as classes_service

    folder = root / "voc-rename"
    _voc(folder, "a")
    _voc(folder, "b")
    project = create_project(folder, label_format="voc")
    pid, car = project["id"], project["classes"][0]
    ids = _ids(admin, pid)

    monkeypatch.setattr(classes_service, "schedule_rename", lambda ctx, project_id: None)  # "the process dies"
    assert admin.patch(f"/api/projects/{pid}/classes/{car['id']}", json={"name": "automobile"}).status_code == 200
    with app.state.ctx.db.session() as session:
        assert [(r.old_name, r.new_name) for r in session.scalars(select(PendingRename))] == [("car", "automobile")]
    assert "<name>car</name>" in (folder / "a.xml").read_text()

    # reads map the old name onto the renamed class ...
    doc = _annotation(admin, pid, ids["a.jpg"]).json()
    assert doc["boxes"][0]["class_id"] == car["id"] and doc["boxes"][0]["raw_label"] is None
    assert {i["filename"]: i["class_ids"] for i in images_of(admin, pid)}["a.jpg"] == [car["id"]]
    # ... so a save writes the new name, and the old one cannot be reused or its class deleted meanwhile
    saved = admin.put(f"/api/projects/{pid}/images/{ids['a.jpg']}/annotation",
                      json={"base_version": doc["version"], "boxes": doc["boxes"]})
    assert saved.status_code == 200
    assert "<name>automobile</name>" in (folder / "a.xml").read_text()
    assert admin.post(f"/api/projects/{pid}/classes", json={"name": "car"}).status_code == 409
    assert admin.delete(f"/api/projects/{pid}/classes/{car['id']}",
                        params={"strategy": "delete_boxes"}).status_code == 409

    # restart: the start-up hook finishes the job and clears the record
    monkeypatch.undo()
    classes_service.resume_renames(app.state.ctx)
    wait_idle(app)
    assert "<name>automobile</name>" in (folder / "b.xml").read_text()
    with app.state.ctx.db.session() as session:
        assert list(session.scalars(select(PendingRename))) == []
    assert admin.post(f"/api/projects/{pid}/classes", json={"name": "car"}).status_code == 200


def test_pending_rename_survives_restart_through_create_app(settings, root):
    """A real start-up (lifespan) resumes renames recorded in the database."""
    from fastapi.testclient import TestClient

    from annotamate.server import create_app
    from conftest import CSRF, PASSWORD

    folder = root / "voc-restart"
    _voc(folder, "a")
    app = create_app(settings)
    with TestClient(app) as client:
        client.post("/api/auth/setup", json={"username": "admin", "display_name": "A", "password": PASSWORD,
                                             "setup_token": app.state.ctx.setup_token}, headers=CSRF)
        pid = client.post("/api/projects", json={"name": "P", "image_dir": str(folder), "label_format": "voc"},
                          headers=CSRF).json()["id"]
        wait_idle(app)
        car = client.get(f"/api/projects/{pid}").json()["classes"][0]
        from annotamate.server.models import PendingRename

        with app.state.ctx.db.session() as session:
            session.add(PendingRename(project_id=pid, old_name="car", new_name="truck"))
            from annotamate.server.models import ProjectClass

            session.get(ProjectClass, car["id"]).name = "truck"
            session.commit()
    app2 = create_app(settings)
    with TestClient(app2):
        wait_idle(app2)
    assert "<name>truck</name>" in (folder / "a.xml").read_text()


# ------------------------------------------------------------------------------- saves keep extra fields


def test_voc_and_coco_saves_keep_fields_the_tool_does_not_model(admin, create_project, root):
    import json

    voc = root / "keep-voc"
    make_image(voc / "a.jpg", (100, 100))
    (voc / "a.xml").write_text(
        "<annotation><source><database>Mine</database></source><object><name>car</name><pose>Left</pose>"
        "<occluded>1</occluded><bndbox><xmin>1</xmin><ymin>1</ymin><xmax>9</xmax><ymax>9</ymax></bndbox>"
        "</object></annotation>")
    project = create_project(voc, label_format="voc")
    pid = project["id"]
    iid = images_of(admin, pid)[0]["id"]
    doc = _annotation(admin, pid, iid).json()
    moved = {**doc["boxes"][0], "x2": 20.0}
    added = box(project["classes"][0]["id"], 30, 30, 50, 50)
    assert admin.put(f"/api/projects/{pid}/images/{iid}/annotation",
                     json={"base_version": doc["version"], "boxes": [moved, added]}).status_code == 200
    text = (voc / "a.xml").read_text()
    assert "<database>Mine</database>" in text and "<pose>Left</pose>" in text and "<occluded>1</occluded>" in text
    assert text.count("<object>") == 2 and "<xmax>20</xmax>" in text

    coco = root / "keep-coco"
    make_image(coco / "a.jpg", (100, 100))
    (coco / "a.json").write_text(json.dumps({
        "info": {"year": 1}, "images": [{"id": 5, "width": 100, "height": 100, "file_name": "a.jpg"}],
        "annotations": [{"id": 42, "image_id": 5, "category_id": 3, "bbox": [1, 1, 8, 8], "iscrowd": 0,
                         "attributes": {"k": "v"}}],
        "categories": [{"id": 3, "name": "cat"}]}))
    project = create_project(coco, label_format="coco", name="C")
    pid = project["id"]
    iid = images_of(admin, pid)[0]["id"]
    doc = _annotation(admin, pid, iid).json()
    moved = {**doc["boxes"][0], "x2": 20.0}
    assert admin.put(f"/api/projects/{pid}/images/{iid}/annotation",
                     json={"base_version": doc["version"], "boxes": [moved]}).status_code == 200
    saved = json.loads((coco / "a.json").read_text())
    assert saved["info"] == {"year": 1} and saved["images"][0]["id"] == 5
    assert saved["annotations"][0]["id"] == 42 and saved["annotations"][0]["attributes"] == {"k": "v"}
    assert saved["annotations"][0]["bbox"] == [1, 1, 19, 8]


# ------------------------------------------------------------------------- classes.txt and export locking


def test_classes_txt_must_stay_inside_the_label_folder(settings, root, tmp_path):
    import pytest

    from annotamate.core.fsutil import OutsideRootError
    from annotamate.server.models import Project
    from annotamate.server.services.paths import ProjectPaths

    folder = root / "p"
    folder.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    try:
        os.symlink(outside, folder / "classes.txt")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available here")
    project = Project(image_dir=str(folder), label_dir=None, label_format="yolo")
    paths = ProjectPaths(settings, project)
    with pytest.raises(OutsideRootError):
        paths.classes_file()
    from annotamate.server.services.labels import sync_classes_file

    table = type("Table", (), {"names": ["a"]})()

    with pytest.raises(OSError, match="outside"):
        sync_classes_file(paths, table)  # type: ignore[arg-type]
    assert outside.read_text() == "secret"


def test_export_reads_label_files_under_the_label_lock(admin, app, create_project, dataset):
    from annotamate.server.services.export import Exporter, select_items
    from annotamate.server.services.labels import load_class_table
    from annotamate.server.services.paths import ProjectPaths

    (dataset / "img1.txt").write_text("0 0.5 0.5 0.1 0.1\n")
    project = create_project(dataset, classes=["cat"])
    events: list[str] = []

    class Recording:
        def __enter__(self):
            events.append("lock")

        def __exit__(self, *exc):
            events.append("unlock")

    ctx = app.state.ctx
    with ctx.db.session() as session:
        row = session.get(__import__("annotamate.server.models", fromlist=["Project"]).Project, project["id"])
        paths = ProjectPaths(ctx.settings, row)
        table = load_class_table(session, row.id, row.label_format)
        items = select_items(session, row, "all")
    assert items
    b"".join(Exporter(paths, table, "yolo", items, False, Recording()).stream())
    assert events == ["lock", "unlock"] * len(items)


# ------------------------------------------------------------------------- follow-up review fixes


def test_rename_keeps_pending_and_retries_when_a_file_cannot_be_read(admin, app, create_project, root, monkeypatch):
    from sqlalchemy import select

    from annotamate.server.models import PendingRename
    from annotamate.server.services import classes as classes_service

    folder = root / "voc-retry"
    _voc(folder, "a")
    _voc(folder, "b")
    project = create_project(folder, label_format="voc")
    pid, car = project["id"], project["classes"][0]
    real_read = classes_service._read
    blocked = str(folder / "b.xml")
    monkeypatch.setattr(classes_service, "_read",
                        lambda path: None if os.path.normcase(path) == os.path.normcase(blocked) else real_read(path))
    monkeypatch.setattr(classes_service, "RENAME_RETRY_DELAYS", (3600,))  # no automatic retry during the test
    assert admin.patch(f"/api/projects/{pid}/classes/{car['id']}", json={"name": "automobile"}).status_code == 200
    wait_idle(app)
    assert "<name>automobile</name>" in (folder / "a.xml").read_text()
    assert "<name>car</name>" in (folder / "b.xml").read_text()
    with app.state.ctx.db.session() as session:  # the alias survives, so b.xml still reads as the renamed class
        assert [(r.old_name, r.new_name) for r in session.scalars(select(PendingRename))] == [("car", "automobile")]
    assert app.state.ctx.rename_retries[pid] == 1
    b = _ids(admin, pid)["b.jpg"]
    assert _annotation(admin, pid, b).json()["boxes"][0]["class_id"] == car["id"]

    # the file becomes readable: a rescan retries at once and finishes the rename
    monkeypatch.setattr(classes_service, "_read", real_read)
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    assert "<name>automobile</name>" in (folder / "b.xml").read_text()
    with app.state.ctx.db.session() as session:
        assert list(session.scalars(select(PendingRename))) == []
    assert pid not in app.state.ctx.rename_retries


def test_class_delete_refuses_when_a_label_file_cannot_be_read(admin, create_project, dataset, monkeypatch):
    from annotamate.server.services import classes as classes_service

    (dataset / "img1.txt").write_text("1 0.5 0.5 0.2 0.2\n")
    (dataset / "img2.txt").write_text("1 0.5 0.5 0.2 0.2\n")
    project = create_project(dataset, classes=["cat", "dog"])
    pid, cat = project["id"], project["classes"][0]
    real_read = classes_service._read
    monkeypatch.setattr(classes_service, "_read", lambda path: None if path.endswith("img2.txt") else real_read(path))
    refused = admin.delete(f"/api/projects/{pid}/classes/{cat['id']}", params={"strategy": "delete_boxes"})
    assert refused.status_code == 400 and "img2.txt" in refused.json()["detail"]
    # nothing changed: the class still exists and no file was renumbered
    assert [c["name"] for c in admin.get(f"/api/projects/{pid}").json()["classes"]] == ["cat", "dog"]
    assert (dataset / "img1.txt").read_text() == "1 0.5 0.5 0.2 0.2\n"


def test_forbid_delete_explains_labels_of_missing_images(admin, app, create_project, dataset):
    (dataset / "img1.txt").write_text("0 0.5 0.5 0.2 0.2\n")
    project = create_project(dataset, classes=["cat"])
    pid, cat = project["id"], project["classes"][0]
    os.remove(dataset / "img1.jpg")
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    refused = admin.delete(f"/api/projects/{pid}/classes/{cat['id']}", params={"strategy": "forbid"})
    assert refused.status_code == 409 and refused.json()["images"] == 1
    assert "missing" in refused.json()["detail"]


def test_missing_images_cannot_be_locked_commented_or_shared(admin, app, create_project, dataset):
    project = create_project(dataset, classes=["cat"])
    pid = project["id"]
    ids = _ids(admin, pid)
    gone = ids["img10.jpg"]
    comment = admin.post(f"/api/projects/{pid}/images/{gone}/comments", json={"body": "look"}).json()
    shared = admin.post(f"/api/projects/{pid}/chat", json={"body": "see this", "image_id": gone}).json()
    assert shared["image"]["id"] == gone
    os.remove(dataset / "img10.jpg")
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)

    assert admin.patch(f"/api/projects/{pid}/comments/{comment['id']}", json={"resolved": True}).status_code == 404
    assert admin.get(f"/api/projects/{pid}/comments").json()["items"] == []
    assert admin.post(f"/api/projects/{pid}/chat", json={"body": "again", "image_id": gone}).status_code == 400
    chat = admin.get(f"/api/projects/{pid}/chat").json()["items"]
    assert [m["image"] for m in chat if m["id"] == shared["id"]] == [None]  # shown like a deleted image

    from annotamate.server.routes import ws

    user_id = admin.get("/api/me").json()["id"]
    assert ws._lock_rights(app.state.ctx, user_id, gone) is None
    assert ws._image_filename(app.state.ctx, pid, gone) is None
    assert ws._lock_rights(app.state.ctx, user_id, ids["img1.jpg"]) is not None
