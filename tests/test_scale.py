"""Phase 2 of the scale work: incremental rescans, paging, streamed COCO export, sort keys and retention."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import random
import threading
import time
import zipfile
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from hypothesis import given, settings
from hypothesis import strategies as st
from PIL import Image as PILImage
from pydantic import ValidationError
from sqlalchemy import inspect, select, text, update
from sqlalchemy.orm import undefer_group

from annotamate.core.scanning import natural_key, natural_sort_key
from annotamate.server import Settings, create_app
from annotamate.server.db import MIGRATIONS_DIR, Database
from annotamate.server.models import Activity, Image, ImageClassCount, Notification, Project, Revision, User, utcnow
from annotamate.server.services import export as export_service
from annotamate.server.services import indexing
from annotamate.server.services.notify import prune_history
from conftest import box, delete_class, images_of, make_image, wait_idle

TRICKY_NAMES = [
    "img1.jpg", "img2.jpg", "img10.jpg", "img010.jpg", "img0010.jpg", "img9.png", "img09.jpg", "IMG11.jpg",
    "Img3.JPG", "img3.jpeg", "a.jpg", "A.png", "a1.jpg", "a01.jpg", "a1b2.jpg", "a1b10.jpg", "a1b02.jpg",
    "1.jpg", "01.jpg", "001.jpg", "10.jpg", "9.jpg", "99999999999999999999999.jpg", "100000000000000000000000.jpg",
    "ä.jpg", "Ä2.jpg", "ß.jpg", "ss.jpg", "é10.jpg", "é9.jpg", "日本語2.png", "日本語10.png", "٣.png", "３.png",
    "x y.jpg", "x-y.jpg", "x_y.jpg", "x.y.jpg", "x.jpg", "x.png", "x",
    "sub/img1.jpg", "sub/img10.jpg", "sub2/img1.jpg", "sub10/img1.jpg", "sub/deep/a.jpg", "sub/deep10/a.jpg",
    "sub/deep9/a.jpg", "Sub/img2.jpg", "sub.jpg", "sub1.jpg", "a/b/c.jpg", "a/b.jpg", "a/b1/c.jpg", "a/1/c.jpg",
    "a/01/c.jpg", "a/\x01.jpg", "a\x02b.jpg", "a\x03.jpg", "a\x04.jpg", "😀1.png", "😀10.png",
]


# ----------------------------------------------------------------------------------- helpers


def age(path: Path, seconds: float = 3600.0) -> None:
    """Give ``path`` a modification time in the past, so that its state is remembered (``indexing.RACY_NS``)."""
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


def write_label(path: Path, content: str, seconds: float = 3600.0) -> None:
    path.write_text(content, encoding="utf-8", newline="\n")
    age(path, seconds)


def rescan(user, app, pid: int) -> None:
    assert user.post(f"/api/projects/{pid}/rescan").status_code == 202
    wait_idle(app)


def snapshot(app, pid: int) -> dict[str, tuple]:
    """Everything a rescan computes, per image."""
    with app.state.ctx.db.session() as session:
        rows = session.execute(select(Image.id, Image.rel_path, Image.has_label, Image.box_count,
                                      Image.unknown_count, Image.missing, Image.label_key)
                               .where(Image.project_id == pid)).all()
        counts: dict[int, dict[int, int]] = {}
        for image_id, class_id, n in session.execute(
                select(ImageClassCount.image_id, ImageClassCount.class_id, ImageClassCount.count)
                .join(Image, Image.id == ImageClassCount.image_id).where(Image.project_id == pid)):
            counts.setdefault(image_id, {})[class_id] = n
    return {r.rel_path: (r.has_label, r.box_count, r.unknown_count, r.missing, r.label_key,
                         tuple(sorted(counts.get(r.id, {}).items()))) for r in rows}


def full_reparse(user, app, pid: int) -> dict[str, tuple]:
    """Forget every remembered label state, rescan, and return what a complete re-parse gives."""
    with app.state.ctx.db.session() as session:
        session.execute(update(Image).where(Image.project_id == pid)
                        .values(label_size=None, label_mtime_ns=None, counted_version=None))
        session.commit()
    rescan(user, app, pid)
    return snapshot(app, pid)


@pytest.fixture
def parsed_files(monkeypatch) -> list[str]:
    """Names of the label files that were read and parsed, in order (cleared by the tests between steps)."""
    seen: list[str] = []
    real = indexing.parse_label_file

    def counting(fmt: str, path: str, rel_path: str):
        seen.append(os.path.basename(path))
        return real(fmt, path, rel_path)

    monkeypatch.setattr(indexing, "parse_label_file", counting)
    return seen


def image_rows(app, pid: int) -> dict[str, Image]:
    """The project's image rows, with the columns that are only loaded on request."""
    with app.state.ctx.db.session() as session:
        return {i.rel_path: i for i in session.scalars(select(Image).where(Image.project_id == pid)
                                                       .options(undefer_group("index")))}


# ----------------------------------------------------------------------------------- L8: natural-sort keys


def test_sort_key_orders_tricky_names_like_natural_key():
    names = list(dict.fromkeys(TRICKY_NAMES))
    assert sorted(names, key=natural_sort_key) == sorted(names, key=natural_key)
    keys = [natural_sort_key(n) for n in names]
    assert len(set(keys)) == len(names)  # the tie-breaker makes keys unique


_NAME_ALPHABET = st.sampled_from(list("aAbBzZ019 ._-/éÉß٣３\x01\x03\x04😀"))


@settings(max_examples=400, deadline=None)
@given(st.text(_NAME_ALPHABET, max_size=10), st.text(_NAME_ALPHABET, max_size=10))
def test_sort_key_compares_like_natural_key(a, b):
    assert (natural_sort_key(a) < natural_sort_key(b)) == (natural_key(a) < natural_key(b))
    assert (natural_sort_key(a) == natural_sort_key(b)) == (a == b)


@settings(max_examples=200, deadline=None)
@given(st.text(max_size=12), st.text(max_size=12))
def test_sort_key_compares_like_natural_key_for_any_text(a, b):
    assert (natural_sort_key(a) < natural_sort_key(b)) == (natural_key(a) < natural_key(b))


def test_sql_order_by_sort_key_is_natural_order(tmp_path):
    db = Database(f"sqlite:///{(tmp_path / 'order.db').as_posix()}")
    db.migrate()
    names = list(dict.fromkeys(TRICKY_NAMES))
    random.Random(3).shuffle(names)
    with db.session() as session:
        project = Project(name="p", image_dir="x", label_format="yolo")
        session.add(project)
        session.flush()
        for name in names:  # the key is derived from the path by the model
            session.add(Image(project_id=project.id, rel_path=name, filename=name.rsplit("/", 1)[-1]))
        session.commit()
        ordered = list(session.scalars(select(Image.rel_path).where(Image.project_id == project.id)
                                       .order_by(Image.sort_key)))
        assert ordered == sorted(names, key=natural_key)
        plan = " | ".join(row[-1] for row in session.execute(text(
            "explain query plan select id from images where project_id = 1 and missing = 0 order by sort_key "
            "limit 100 offset 5000")))
        assert "ix_images_project_sort" in plan and "TEMP B-TREE" not in plan
        count_plan = " | ".join(row[-1] for row in session.execute(text(
            "explain query plan select count(*) from images where project_id = 1 and missing = 0 "
            "and sort_key < x'6100'")))
        assert "COVERING INDEX ix_images_project_sort" in count_plan
    db.dispose()


def _children(db: Database) -> tuple[int, int, int]:
    """Rows that reference images (they must survive a rebuild of the ``images`` table)."""
    with db.engine.connect() as conn:
        return tuple(conn.execute(text(f"select count(*) from {table}")).scalar()  # noqa: S608
                     for table in ("image_class_counts", "revisions", "images"))


def test_0004_upgrade_and_downgrade(tmp_path):
    assert list((MIGRATIONS_DIR / "versions").glob("0004_*.py"))
    db = Database(f"sqlite:///{(tmp_path / 'm4.db').as_posix()}")
    db.migrate("0003")
    names = list(dict.fromkeys(TRICKY_NAMES))
    with db.engine.begin() as conn:
        conn.execute(text("insert into projects (id, name, description, image_dir, label_format, require_review, "
                          "restrict_to_assigned, annotators_can_add_classes, exif_mode, recursive, archived, "
                          "created_at, updated_at) values (1, 'p', '', 'x', 'yolo', 0, 0, 1, 'apply', 1, 0, "
                          "'2024-01-01', '2024-01-01')"))
        for n, rel in enumerate(names):  # deliberately in a meaningless order
            conn.execute(text("insert into images (project_id, rel_path, filename, label_key, missing, sort_index, "
                              "status, flagged, has_label, box_count, unknown_count, comment_count, "
                              "open_comment_count) values (1, :rel, :rel, :rel, :missing, :n, 'done', 0, 1, 2, 0, 0, "
                              "0)"), {"rel": rel, "n": len(names) - n, "missing": n % 7 == 0})
        conn.execute(text("insert into project_classes (id, project_id, position, name, color) values "
                          "(1, 1, 0, 'cat', '#ff0000')"))
        conn.execute(text("insert into image_class_counts (image_id, class_id, count) select id, 1, 2 from images"))
        conn.execute(text("insert into revisions (image_id, created_at, version, box_count, boxes) "
                          "select id, '2024-01-01', 'v', 0, '[]' from images where id <= 5"))
    children = _children(db)
    assert children == (len(names), 5, len(names))

    db.migrate()
    assert _children(db) == children  # rebuilding ``images`` did not cascade to the rows that reference it
    with db.engine.connect() as conn:
        assert conn.execute(text("pragma foreign_keys")).scalar() == 1  # switched back on after the migration
        assert conn.execute(text("pragma foreign_key_check")).all() == []
    columns = {c["name"] for c in inspect(db.engine).get_columns("images")}
    assert "sort_index" not in columns
    assert {"sort_key", "label_size", "label_mtime_ns", "counted_version", "width", "height", "file_size",
            "file_mtime_ns"} <= columns
    assert {"class_version", "class_floor"} <= {c["name"] for c in inspect(db.engine).get_columns("projects")}
    indexes = {i["name"]: i["column_names"] for i in inspect(db.engine).get_indexes("images")}
    assert indexes["ix_images_project_sort"] == ["project_id", "missing", "sort_key"]
    assert indexes["ix_images_project_missing_status_sort"] == ["project_id", "missing", "status", "sort_key"]
    assert indexes["ix_images_project_missing_assignee_sort"] == ["project_id", "missing", "assignee_id",
                                                                 "sort_key"]
    with db.engine.connect() as conn:
        rows = conn.execute(text("select rel_path, sort_key, status, box_count, label_size, width from images")).all()
        assert len(rows) == len(names)
        # the migration's own copy of the key function gives what the application computes today
        assert all(bytes(r.sort_key) == natural_sort_key(r.rel_path) for r in rows)
        assert all((r.status, r.box_count, r.label_size, r.width) == ("done", 2, None, None) for r in rows)
        assert conn.execute(text("select class_version, class_floor from projects")).one() == (0, 0)

    db.migrate("0003")
    assert _children(db) == children
    columns = {c["name"] for c in inspect(db.engine).get_columns("images")}
    assert "sort_index" in columns and not {"sort_key", "label_size", "width", "counted_version"} & columns
    assert "class_version" not in {c["name"] for c in inspect(db.engine).get_columns("projects")}
    indexes = {i["name"]: i["column_names"] for i in inspect(db.engine).get_indexes("images")}
    assert indexes["ix_images_project_sort"] == ["project_id", "sort_index"]
    assert indexes["ix_images_project_missing_status_sort"] == ["project_id", "missing", "status", "sort_index"]
    with db.engine.connect() as conn:
        rows = conn.execute(text("select rel_path, missing, sort_index from images order by sort_index")).all()
        # positions again: natural order, missing images last
        assert [r.sort_index for r in rows] == list(range(len(names)))
        missing = {rel for n, rel in enumerate(names) if n % 7 == 0}
        expected = (sorted((n for n in names if n not in missing), key=natural_key)
                    + sorted(missing, key=natural_key))
        assert [r.rel_path for r in rows] == expected

    db.migrate()
    assert _children(db) == children
    db.dispose()


def _upload(user, pid: int, *names: str, subdir: str | None = None):
    buf = io.BytesIO()
    PILImage.new("RGB", (20, 10), "blue").save(buf, "PNG")
    files = [("files[]", (name, buf.getvalue(), "image/png")) for name in names]
    response = user.post(f"/api/projects/{pid}/upload", files=files, data={"subdir": subdir} if subdir else None)
    assert response.status_code == 200, response.text
    return response.json()


def test_positions_follow_natural_order_through_uploads_filters_and_missing_files(admin, app, create_project, root):
    folder = root / "pos"
    for name in ("img1.png", "img2.png", "img10.png", "img20.png", "b/1.png", "b/10.png", "b/2.png", "a/x.png",
                 "ä.png", "z.png"):
        make_image(folder / name)
    project = create_project(folder, settings={"recursive": True})
    pid = project["id"]

    def listed(**params):
        return images_of(admin, pid, limit=500, **params)

    def check_whole_list() -> list[dict]:
        items = listed()
        assert [i["rel_path"] for i in items] == sorted((i["rel_path"] for i in items), key=natural_key)
        assert [i["position"] for i in items] == list(range(len(items)))
        return items

    before = {i["rel_path"]: i["id"] for i in check_whole_list()}
    keys_before = {rel: row.sort_key for rel, row in image_rows(app, pid).items()}

    # uploads land at their natural place: in front, in the middle, at the end and in a sub-folder
    for names, subdir in ((("img0.png", "img5.png", "zz.png"), None), (("5.png",), "b")):
        added = _upload(admin, pid, *names, subdir=subdir)["added"]
        position_of = {i["rel_path"]: i["position"] for i in check_whole_list()}
        assert len(added) == len(names)
        assert all(i["position"] == position_of[i["rel_path"]] for i in added)  # the response has them too
    items = check_whole_list()
    order = [i["rel_path"] for i in items]
    assert order.index("img0.png") < order.index("img1.png") and order.index("b/2.png") < order.index("b/5.png") < \
        order.index("b/10.png")
    position_of = {i["rel_path"]: i["position"] for i in items}
    # no existing row was touched to make room
    rows = image_rows(app, pid)
    assert {rel: rows[rel].sort_key for rel in keys_before} == keys_before
    assert {rel: rows[rel].id for rel in before} == before

    # a position is the place in the whole project, whatever the filter, the sort or the page
    ids = {i["rel_path"]: i["id"] for i in items}
    flagged = ["img10.png", "a/x.png", "zz.png", "b/5.png"]
    admin.post(f"/api/projects/{pid}/images/bulk", json={"image_ids": [ids[n] for n in flagged], "action": "flag"})
    for params in ({"flagged": "true"}, {"flagged": "true", "sort": "updated"}, {"q": "img"}, {"sort": "updated"},
                   {"flagged": "false", "offset": 3, "limit": 4}):
        page = images_of(admin, pid, **params)
        assert page and all(i["position"] == position_of[i["rel_path"]] for i in page), params
    one = admin.get(f"/api/projects/{pid}/images/{ids['img10.png']}").json()
    assert one["position"] == position_of["img10.png"]
    assert admin.get(f"/api/projects/{pid}/images", params={"offset": 5, "limit": 3}).json()["items"][0][
        "position"] == 5

    # missing images leave the numbering (they come last and are not listed)
    os.remove(folder / "img1.png")
    os.remove(folder / "b" / "2.png")
    rescan(admin, app, pid)
    items = check_whole_list()
    assert len(items) == len(order) - 2 and "img1.png" not in [i["rel_path"] for i in items]
    filtered = images_of(admin, pid, flagged="true")
    now = {i["rel_path"]: i["position"] for i in items}
    assert [i["position"] for i in filtered] == [now[i["rel_path"]] for i in filtered]


# ----------------------------------------------------------------------------------- L5: incremental rescan


def test_rescan_reads_only_label_files_that_changed(admin, app, create_project, root, parsed_files):
    folder = root / "inc"
    for n in range(8):
        make_image(folder / f"img{n}.jpg")
        write_label(folder / f"img{n}.txt", "0 0.5 0.5 0.2 0.2\n1 0.3 0.3 0.1 0.1\n")
    write_label(folder / "img7.txt", "7 0.5 0.5 0.2 0.2\n")  # no such class
    project = create_project(folder, classes=["a", "b"])
    pid = project["id"]
    a, b = (c["id"] for c in project["classes"])
    assert len(parsed_files) == 8
    rows = image_rows(app, pid)
    st_ = os.stat(folder / "img0.txt")
    assert (rows["img0.jpg"].label_size, rows["img0.jpg"].label_mtime_ns) == (st_.st_size, st_.st_mtime_ns)
    assert rows["img0.jpg"].counted_version == 0

    def reads_of_rescan() -> list[str]:
        parsed_files.clear()
        rescan(admin, app, pid)
        return sorted(parsed_files)

    assert reads_of_rescan() == []  # nothing changed, nothing is read (not even the file with an unknown label)

    # edited outside the app: same size, another modification time
    write_label(folder / "img3.txt", "1 0.5 0.5 0.2 0.2\n1 0.3 0.3 0.1 0.1\n", seconds=1800)
    assert reads_of_rescan() == ["img3.txt"]
    assert snapshot(app, pid)["img3.jpg"][5] == ((b, 2),)
    assert reads_of_rescan() == []

    # a save through the app records the state of the file it wrote
    ids = {i["filename"]: i["id"] for i in images_of(admin, pid)}
    url = f"/api/projects/{pid}/images/{ids['img1.jpg']}/annotation"
    version = admin.get(url).json()["version"]
    assert admin.put(url, json={"base_version": version, "boxes": [box(a, 1, 1, 20, 20)]}).status_code == 200
    row = image_rows(app, pid)["img1.jpg"]
    st_ = os.stat(folder / "img1.txt")
    assert (row.label_size, row.label_mtime_ns, row.width, row.height) == (st_.st_size, st_.st_mtime_ns, 100, 50)
    assert reads_of_rescan() == []
    assert snapshot(app, pid)["img1.jpg"][1:3] == (1, 0)

    # a new class: only the image with an unknown label is looked at again (by the recount job), then nothing
    assert admin.post(f"/api/projects/{pid}/classes", json={"name": "c"}).status_code == 200
    wait_idle(app)
    assert reads_of_rescan() == []
    assert snapshot(app, pid)["img7.jpg"][2] == 1  # 7 is still not a class

    # a file modified a moment ago is read at every rescan until its timestamp can be trusted
    (folder / "img5.txt").write_text("0 0.5 0.5 0.2 0.2\n", encoding="utf-8", newline="\n")
    age(folder / "img5.txt", seconds=-30)  # "just now" for as long as this test runs, however slow the machine
    assert reads_of_rescan() == ["img5.txt"]
    assert image_rows(app, pid)["img5.jpg"].label_size is None
    assert reads_of_rescan() == ["img5.txt"]
    age(folder / "img5.txt")
    assert reads_of_rescan() == ["img5.txt"]
    assert reads_of_rescan() == []

    # deleting a class changes what the labels mean: every file is read once more, then none
    deleted = delete_class(admin, app, pid, b, strategy="delete_boxes")
    assert deleted["type"] == "class_deleted"
    for path in folder.glob("img*.txt"):
        age(path)
    assert len(reads_of_rescan()) == 8
    assert reads_of_rescan() == []

    # label files and images that come and go
    os.remove(folder / "img2.txt")
    os.remove(folder / "img4.jpg")
    make_image(folder / "img8.jpg")
    write_label(folder / "img8.txt", "0 0.5 0.5 0.2 0.2\n")
    assert reads_of_rescan() == ["img8.txt"]
    snap = snapshot(app, pid)
    assert snap["img2.jpg"][:3] == (False, 0, 0) and snap["img4.jpg"][3] is True and snap["img8.jpg"][:2] == (True, 1)
    assert image_rows(app, pid)["img2.jpg"].label_size is None
    assert snap == full_reparse(admin, app, pid)


def test_incremental_rescan_equals_a_full_reparse_after_any_edits(admin, app, create_project, root):
    folder = root / "random"
    for n in range(12):
        make_image(folder / f"img{n}.jpg")
    lines = ["0 0.5 0.5 0.2 0.2", "1 0.3 0.3 0.1 0.1", "2 0.6 0.6 0.1 0.1", "6 0.2 0.2 0.1 0.1"]
    for n in range(0, 12, 2):
        write_label(folder / f"img{n}.txt", "".join(f"{line}\n" for line in lines[:1 + n % 3]))
    project = create_project(folder, classes=["a", "b"])
    pid = project["id"]
    rng = random.Random(20261123)
    extra = 0
    operations = ["edit", "edit", "same_size", "fresh", "delete_label", "delete_image", "add_image", "save", "save",
                  "add_class", "rename_class", "delete_class"]
    for step in range(45):
        op = rng.choice(operations)
        images = sorted(folder.glob("img*.jpg"))
        labels = sorted(folder.glob("img*.txt"))
        if op == "edit":
            target = rng.choice(images).with_suffix(".txt")
            content = "".join(f"{rng.choice(lines)}\n" for _ in range(rng.randrange(0, 4)))
            write_label(target, content, seconds=rng.uniform(60, 90000))
        elif op == "same_size" and labels:
            target = rng.choice(labels)
            content = target.read_text(encoding="utf-8")
            if content:
                swapped = {"0": "1", "1": "2", "2": "6", "6": "0"}[content[0]] + content[1:]
                write_label(target, swapped, seconds=rng.uniform(60, 90000))
        elif op == "fresh":
            target = rng.choice(images).with_suffix(".txt")
            target.write_text(f"{rng.choice(lines)}\n", encoding="utf-8", newline="\n")  # modified "now"
        elif op == "delete_label" and labels:
            os.remove(rng.choice(labels))
        elif op == "delete_image" and len(images) > 6:
            os.remove(rng.choice(images))
        elif op == "add_image":
            extra += 1
            make_image(folder / f"img{100 + extra}.jpg")
            if extra % 2:
                write_label(folder / f"img{100 + extra}.txt", f"{rng.choice(lines)}\n")
        elif op == "save":
            listed = images_of(admin, pid, limit=500)
            classes = admin.get(f"/api/projects/{pid}/classes").json()
            if listed and classes:
                image = rng.choice(listed)
                url = f"/api/projects/{pid}/images/{image['id']}/annotation"
                doc = admin.get(url)
                if doc.status_code == 200 and doc.json()["readonly_reason"] is None:
                    boxes = [box(rng.choice(classes)["id"], 1, 1, 10 + n, 20) for n in range(rng.randrange(0, 3))]
                    saved = admin.put(url, json={"base_version": doc.json()["version"], "boxes": boxes})
                    assert saved.status_code == 200, saved.text
        elif op == "add_class":
            assert admin.post(f"/api/projects/{pid}/classes", json={"name": f"class{step}"}).status_code == 200
        elif op == "rename_class":
            classes = admin.get(f"/api/projects/{pid}/classes").json()
            if classes:
                cls = rng.choice(classes)
                assert admin.patch(f"/api/projects/{pid}/classes/{cls['id']}",
                                   json={"name": f"renamed{step}"}).status_code == 200
        elif op == "delete_class":
            classes = admin.get(f"/api/projects/{pid}/classes").json()
            if len(classes) > 1:
                cls = rng.choice(classes)
                other = rng.choice([c for c in classes if c["id"] != cls["id"]])
                params = rng.choice([{"strategy": "delete_boxes"},
                                     {"strategy": "merge", "merge_into": other["id"]}])
                wait_idle(app)
                assert delete_class(admin, app, pid, cls["id"], **params)["type"] == "class_deleted"
        wait_idle(app)
        rescan(admin, app, pid)
        incremental = snapshot(app, pid)
        assert incremental == full_reparse(admin, app, pid), (step, op)


def test_voc_rename_is_followed_by_one_complete_rescan(admin, app, create_project, root, parsed_files):
    folder = root / "vocinc"
    for n, name in enumerate(["car", "car", "tree", "dog"]):
        make_image(folder / f"v{n}.jpg")
        write_label(folder / f"v{n}.xml", f"<annotation><object><name>{name}</name><bndbox><xmin>1</xmin>"
                                          "<ymin>1</ymin><xmax>9</xmax><ymax>9</ymax></bndbox></object></annotation>")
    write_label(folder / "v3.xml", "<annotation><object><name>auto</name><bndbox><xmin>1</xmin><ymin>1</ymin>"
                                   "<xmax>9</xmax><ymax>9</ymax></bndbox></object></annotation>")
    project = create_project(folder, label_format="voc", classes=["car", "tree"])
    pid = project["id"]
    car = project["classes"][0]["id"]
    assert snapshot(app, pid)["v3.jpg"][2] == 1  # "auto" is not a class yet

    parsed_files.clear()
    rescan(admin, app, pid)
    assert parsed_files == []

    assert admin.patch(f"/api/projects/{pid}/classes/{car}", json={"name": "auto"}).status_code == 200
    wait_idle(app)  # the rename job rewrote v0 and v1 and dropped the alias
    with app.state.ctx.db.session() as session:
        project_row = session.get(Project, pid)
        assert project_row.class_floor == project_row.class_version > 0
    for path in folder.glob("*.xml"):
        age(path)
    parsed_files.clear()
    rescan(admin, app, pid)
    assert sorted(parsed_files) == ["v0.xml", "v1.xml", "v2.xml", "v3.xml"]
    snap = snapshot(app, pid)
    assert snap["v3.jpg"][1:3] == (1, 0) and snap["v3.jpg"][5] == ((car, 1),)  # the unknown "auto" is the class now
    parsed_files.clear()
    rescan(admin, app, pid)
    assert parsed_files == []
    assert snap == full_reparse(admin, app, pid)


def test_changing_the_label_folder_forgets_the_remembered_files(admin, app, create_project, root, parsed_files):
    folder, other = root / "ld", root / "ld-labels"
    other.mkdir()
    for n in range(3):
        make_image(folder / f"i{n}.jpg")
        write_label(folder / f"i{n}.txt", "0 0.5 0.5 0.2 0.2\n", seconds=5000)
        # same size and the same timestamp as the file in the first folder, other content
        write_label(other / f"i{n}.txt", "1 0.5 0.5 0.2 0.2\n", seconds=5000)
        stamp = os.stat(folder / f"i{n}.txt")
        os.utime(other / f"i{n}.txt", ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    project = create_project(folder, classes=["a", "b"])
    pid = project["id"]
    b = project["classes"][1]["id"]
    parsed_files.clear()
    assert admin.patch(f"/api/projects/{pid}", json={"label_dir": str(other)}).status_code == 200
    wait_idle(app)
    assert len(parsed_files) == 3
    assert all(row[5] == ((b, 1),) for row in snapshot(app, pid).values())


def test_index_pass_works_in_chunks_without_holding_the_label_lock_while_reading(admin, app, create_project, root,
                                                                                 monkeypatch):
    monkeypatch.setattr(indexing, "BATCH", 3)
    folder = root / "chunks"
    for n in range(10):
        make_image(folder / f"img{n}.jpg")
        write_label(folder / f"img{n}.txt", "0 0.5 0.5 0.2 0.2\n" * (1 + n % 3))
    ctx = app.state.ctx
    free: list[bool] = []
    real = indexing.parse_label_file

    def spying(fmt: str, path: str, rel_path: str):
        def probe() -> None:
            lock = ctx.label_locks(1)
            got = lock.acquire(blocking=False)
            free.append(got)
            if got:
                lock.release()

        thread = threading.Thread(target=probe)
        thread.start()
        thread.join()
        return real(fmt, path, rel_path)

    monkeypatch.setattr(indexing, "parse_label_file", spying)
    project = create_project(folder, classes=["a"])
    assert project["id"] == 1 and project["image_count"] == 10
    assert len(free) == 10 and all(free)  # another thread (a save) could take the lock during every read
    items = images_of(admin, 1)
    assert [i["box_count"] for i in items] == [1 + n % 3 for n in range(10)]
    assert [i["position"] for i in items] == list(range(10))
    os.remove(folder / "img9.jpg")
    rescan(admin, app, 1)
    detail = admin.get("/api/projects/1").json()
    assert detail["image_count"] == 9 and detail["missing_count"] == 1


@pytest.mark.parametrize("batch", [2, 1000])
def test_classes_are_discovered_in_file_order_whatever_the_chunk_size(admin, app, create_project, root, monkeypatch,
                                                                    batch):
    monkeypatch.setattr(indexing, "BATCH", batch)
    folder = root / f"disc{batch}"
    names = [["zebra"], ["ant", "zebra"], [], ["cat"], ["ant"], ["bee", "cat"], ["yak"]]
    for n, found in enumerate(names):
        make_image(folder / f"img{n}.jpg")
        objects = "".join(f"<object><name>{name}</name><bndbox><xmin>1</xmin><ymin>1</ymin><xmax>9</xmax>"
                          "<ymax>9</ymax></bndbox></object>" for name in found)
        if found:
            write_label(folder / f"img{n}.xml", f"<annotation>{objects}</annotation>")
    project = create_project(folder, label_format="voc")
    assert [c["name"] for c in project["classes"]] == ["zebra", "ant", "cat", "bee", "yak"]
    assert [c["index"] for c in project["classes"]] == [0, 1, 2, 3, 4]
    assert (folder / "classes.txt").read_text(encoding="utf-8").split() == ["zebra", "ant", "cat", "bee", "yak"]
    snap = snapshot(app, project["id"])
    assert all(row[2] == 0 for row in snap.values())  # every label is a class
    assert [snap[f"img{n}.jpg"][1] for n in range(7)] == [len(found) for found in names]
    assert snap == full_reparse(admin, app, project["id"])


# ----------------------------------------------------------------------------------- L6: paging and neighbours


def test_total_is_counted_for_the_first_page_or_on_request(admin, create_project, dataset):
    pid = create_project(dataset)["id"]
    url = f"/api/projects/{pid}/images"
    assert admin.get(url, params={"limit": 2}).json()["total"] == 3
    assert admin.get(url, params={"limit": 2, "offset": 2}).json()["total"] is None
    assert admin.get(url, params={"limit": 2, "offset": 2, "count": "true"}).json()["total"] == 3
    assert admin.get(url, params={"limit": 2, "count": "false"}).json()["total"] is None
    later = admin.get(url, params={"limit": 2, "offset": 2, "q": "img"}).json()
    assert later["total"] is None and [i["filename"] for i in later["items"]] == ["img10.jpg"]
    assert admin.get(url, params={"q": "img1", "count": "true", "offset": 1}).json()["total"] == 2


def test_neighbors_match_the_lists_for_every_filter_and_sort(admin, app, create_project, make_user, root):
    folder = root / "nb"
    for n in range(1, 15):
        make_image(folder / f"frame{n}.png")
    ann = make_user("ann")
    project = create_project(folder, classes=["cat", "dog"], members=[(ann, "annotator")])
    pid = project["id"]
    cat, dog = (c["id"] for c in project["classes"])
    ids = [i["id"] for i in images_of(admin, pid)]
    bulk = f"/api/projects/{pid}/images/bulk"
    admin.post(bulk, json={"image_ids": ids[2:9:2], "action": "flag"})
    admin.post(bulk, json={"image_ids": ids[1:6], "action": "assign", "assignee_id": ann.id})
    for n in (9, 3, 12, 0, 6):  # saves in an order unlike the names, so "updated" sorts differently
        admin.put(f"/api/projects/{pid}/images/{ids[n]}/annotation",
                  json={"base_version": None, "boxes": [box(cat if n % 2 else dog, 1, 1, 9, 9)]})
    admin.post(f"/api/projects/{pid}/images/{ids[3]}/status", json={"action": "submit"})
    os.remove(folder / "frame8.png")  # a missing image is in no list
    rescan(admin, app, pid)
    gone = ids[7]
    assert admin.get(f"/api/projects/{pid}/images/{gone}/neighbors").status_code == 404

    filters = [{}, {"sort": "updated"}, {"flagged": "true"}, {"flagged": "false", "sort": "updated"},
               {"status": "in_progress,done"}, {"status": "todo", "sort": "updated"}, {"assignee": str(ann.id)},
               {"assignee": "none"}, {"class_id": cat}, {"q": "frame1"}, {"q": "frame1", "flagged": "true"},
               {"has_comments": "any"}]
    for flt in filters:
        sort = {"sort": flt["sort"]} if "sort" in flt else {}
        everything = [i["id"] for i in images_of(admin, pid, limit=500, **sort)]
        place = {image_id: n for n, image_id in enumerate(everything)}
        matching = [i["id"] for i in images_of(admin, pid, limit=500, **flt)]
        assert gone not in everything and len(everything) == 13
        for image_id in everything:
            before = [m for m in matching if place[m] < place[image_id]]
            after = [m for m in matching if place[m] > place[image_id]]
            expected = {"prev_id": before[-1] if before else None, "next_id": after[0] if after else None,
                        "index": len(before) if image_id in matching else -1, "total": len(matching)}
            got = admin.get(f"/api/projects/{pid}/images/{image_id}/neighbors", params=flt).json()
            assert got == expected, (flt, image_id)

    # the total of the unfiltered case comes from the project's cached counts: it follows every change
    _upload(admin, pid, "frame0.png")
    first = images_of(admin, pid, limit=1)[0]
    assert first["filename"] == "frame0.png"
    assert admin.get(f"/api/projects/{pid}/images/{first['id']}/neighbors").json() == {
        "prev_id": None, "next_id": ids[0], "index": 0, "total": 14}
    assert admin.get(f"/api/projects/{pid}/images/{ids[-1]}/neighbors").json()["index"] == 13


# ----------------------------------------------------------------------------------- L7: streamed COCO export


def _coco_export(user, pid: int, **params) -> tuple[zipfile.ZipFile, dict]:
    response = user.get(f"/api/projects/{pid}/export", params={"format": "coco", **params})
    assert response.status_code == 200, response.text
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert archive.testzip() is None
    return archive, json.loads(archive.read("annotations.json"))


def test_coco_export_is_streamed_valid_and_keeps_stable_ids(admin, app, create_project, root, monkeypatch):
    monkeypatch.setattr(export_service, "SPOOL_MEMORY", 256)  # the records go through temporary files
    monkeypatch.setattr(export_service, "CHUNK", 512)
    folder = root / "coco-out"
    count = 60
    for n in range(count):
        make_image(folder / f"img{n}.jpg", (100, 50))
        write_label(folder / f"img{n}.txt", "".join(f"{n % 3} 0.5 0.5 0.{2 + k} 0.4\n" for k in range(1 + n % 4)))
    write_label(folder / "img7.txt", "9 0.5 0.5 0.2 0.2\n")  # not a class: a YOLO index has no name to export
    project = create_project(folder, classes=["cat", "dog", "bird"])
    pid = project["id"]

    archive, data = _coco_export(admin, pid)
    assert archive.namelist() == ["annotations.json"]
    assert list(data) == ["images", "annotations", "categories"]
    names = sorted((f"img{n}.jpg" for n in range(count)), key=natural_key)
    assert data["images"] == [{"id": n + 1, "file_name": name, "width": 100, "height": 50}
                              for n, name in enumerate(names)]
    assert data["categories"] == [{"id": 1, "name": "cat", "supercategory": "none"},
                                  {"id": 2, "name": "dog", "supercategory": "none"},
                                  {"id": 3, "name": "bird", "supercategory": "none"}]
    annotations = data["annotations"]
    assert [a["id"] for a in annotations] == list(range(1, len(annotations) + 1))
    expected = []
    for image_id, name in enumerate(names, start=1):
        n = int(name[3:-4])
        boxes = [] if n == 7 else [(n % 3 + 1, (2 + k) / 10) for k in range(1 + n % 4)]
        expected += [(image_id, category, round(100 * width, 3)) for category, width in boxes]
    assert [(a["image_id"], a["category_id"], a["bbox"][2]) for a in annotations] == expected
    assert annotations[0] == {"id": 1, "image_id": 1, "category_id": 1, "bbox": [40.0, 15.0, 20.0, 20.0],
                              "area": 400.0, "iscrowd": 0, "segmentation": []}
    assert archive.getinfo("annotations.json").compress_type == zipfile.ZIP_DEFLATED

    # the same project gives the same document, byte for byte
    again, _ = _coco_export(admin, pid)
    assert again.read("annotations.json") == archive.read("annotations.json")

    # with the images: one valid archive, the document last
    with_images, data2 = _coco_export(admin, pid, include_images="true")
    assert data2 == data and with_images.namelist()[-1] == "annotations.json"
    assert len(with_images.namelist()) == count + 1
    assert with_images.read("images/img3.jpg") == (folder / "img3.jpg").read_bytes()


def test_coco_export_gives_unknown_names_the_next_category_ids(admin, create_project, root):
    folder = root / "coco-voc"
    for n, name in enumerate(["dog", "wolf", "cat", "fox", "wolf"]):
        make_image(folder / f"v{n}.jpg")
        write_label(folder / f"v{n}.xml", f"<annotation><object><name>{name}</name><bndbox><xmin>1</xmin>"
                                          "<ymin>1</ymin><xmax>9</xmax><ymax>9</ymax></bndbox></object></annotation>")
    pid = create_project(folder, label_format="voc", classes=["cat", "dog"])["id"]
    _, data = _coco_export(admin, pid)
    assert [(c["id"], c["name"]) for c in data["categories"]] == [(1, "cat"), (2, "dog"), (3, "wolf"), (4, "fox")]
    assert [(a["id"], a["image_id"], a["category_id"]) for a in data["annotations"]] == [
        (1, 1, 2), (2, 2, 3), (3, 3, 1), (4, 4, 4), (5, 5, 3)]


def test_coco_export_of_nothing_is_a_valid_document(admin, create_project, dataset):
    pid = create_project(dataset, classes=["cat"])["id"]
    _, data = _coco_export(admin, pid)
    assert data == {"images": [], "annotations": [], "categories": [{"id": 1, "name": "cat", "supercategory": "none"}]}


def test_coco_export_opens_each_image_once_and_then_uses_the_index(admin, app, create_project, root, monkeypatch):
    folder = root / "coco-sizes"
    for n in range(6):
        make_image(folder / f"img{n}.jpg", (100, 50))
        write_label(folder / f"img{n}.txt", "0 0.5 0.5 0.2 0.2\n")
    project = create_project(folder, classes=["cat"])
    pid = project["id"]
    opened: list[str] = []
    real = export_service.probe

    def counting(path: str, exif_mode: str = "apply"):
        opened.append(os.path.basename(path))
        return real(path, exif_mode)

    monkeypatch.setattr(export_service, "probe", counting)
    monkeypatch.setattr(export_service, "REMEMBER_BATCH", 4)
    _, first = _coco_export(admin, pid)
    assert len(opened) == 6
    rows = image_rows(app, pid)
    st_ = os.stat(folder / "img2.jpg")
    assert (rows["img2.jpg"].width, rows["img2.jpg"].height, rows["img2.jpg"].file_size,
            rows["img2.jpg"].file_mtime_ns) == (100, 50, st_.st_size, st_.st_mtime_ns)

    opened.clear()
    _, second = _coco_export(admin, pid)
    assert opened == [] and second == first

    # an image replaced on disk is opened again, the others are not
    make_image(folder / "img4.jpg", (40, 80))
    opened.clear()
    _, third = _coco_export(admin, pid)
    assert opened == ["img4.jpg"]
    assert {(i["file_name"], i["width"], i["height"]) for i in third["images"]} >= {("img4.jpg", 40, 80),
                                                                                  ("img0.jpg", 100, 50)}

    # another EXIF mode: the remembered sizes belong to the old one
    assert admin.patch(f"/api/projects/{pid}", json={"settings": {"exif_mode": "ignore"}}).status_code == 200
    assert all(row.width is None and row.file_size is None for row in image_rows(app, pid).values())
    opened.clear()
    _coco_export(admin, pid)
    assert len(opened) == 6


# ----------------------------------------------------------------------------------- L9: retention


def test_revision_settings():
    assert Settings(roots=["."]).revisions_keep == 20 and Settings(roots=["."]).activity_retention_days == 0
    with pytest.raises(ValidationError):
        Settings(roots=["."], revisions_keep=0)
    with pytest.raises(ValidationError):
        Settings(roots=["."], activity_retention_days=-1)


def test_revisions_keep_setting_and_identical_saves(admin, app, create_project, dataset):
    app.state.ctx.settings.revisions_keep = 3
    project = create_project(dataset, classes=["cat"])
    pid, cat = project["id"], project["classes"][0]["id"]
    image = images_of(admin, pid)[0]
    url = f"/api/projects/{pid}/images/{image['id']}"

    def save(boxes, version):
        response = admin.put(f"{url}/annotation", json={"base_version": version, "boxes": boxes})
        assert response.status_code == 200, response.text
        return response.json()

    def revisions() -> list[dict]:
        return admin.get(f"{url}/revisions").json()

    same = [box(cat, 1, 1, 20, 20, id="11111111-1111-4111-8111-111111111111")]
    first = save(same, None)
    assert len(revisions()) == 1
    for _ in range(3):  # the same boxes again: nothing new to remember
        again = save(same, first["version"])
        assert again["version"] == first["version"] and again["boxes"] == first["boxes"]
    assert [r["id"] for r in revisions()] == [revisions()[0]["id"]] and len(revisions()) == 1
    assert admin.get(f"{url}/annotation").json()["boxes"] == first["boxes"]

    version = first["version"]
    seen = []
    for n in range(6):
        result = save([box(cat, 1, 1, 30 + n, 20)], version)
        version = result["version"]
        seen.append(revisions()[0]["id"])
    kept = revisions()
    assert [r["id"] for r in kept] == seen[:2:-1] and len(kept) == 3
    with app.state.ctx.db.session() as session:
        assert len(list(session.scalars(select(Revision).where(Revision.image_id == image["id"])))) == 3
    # the newest revision can still be restored
    restored = admin.post(f"{url}/revisions/{kept[1]['id']}/restore", json={"base_version": version})
    assert restored.status_code == 200 and len(revisions()) == 3


def _history(db: Database) -> tuple[int, int, int]:
    """A project with activity and notifications of several ages; returns ``(project id, reader id, old id)``."""
    with db.session() as session:
        user = User(username="reader", display_name="Reader", password_hash="x", avatar_color="#000000")
        session.add(user)
        project = Project(name="p", image_dir="x", label_format="yolo")
        session.add(project)
        session.flush()
        old, recent = utcnow() - timedelta(days=45), utcnow() - timedelta(days=5)
        for created in (old, old, recent):
            session.add(Activity(project_id=project.id, type="rescanned", data={}, created_at=created))
        session.add(Notification(user_id=user.id, type="mention", text="old and read", created_at=old, read_at=old))
        unread = Notification(user_id=user.id, type="mention", text="old and unread", created_at=old)
        session.add(unread)
        session.add(Notification(user_id=user.id, type="mention", text="recent and read", created_at=recent,
                                 read_at=recent))
        session.commit()
        return project.id, user.id, unread.id


def _remaining(db: Database) -> tuple[int, list[str]]:
    with db.session() as session:
        return (len(list(session.scalars(select(Activity.id)))),
                sorted(session.scalars(select(Notification.text))))


def test_prune_history_keeps_recent_entries_and_unread_notifications(tmp_path, monkeypatch):
    db = Database(f"sqlite:///{(tmp_path / 'r.db').as_posix()}")
    db.migrate()
    _history(db)
    assert prune_history(db, 0) == (0, 0)  # 0 = keep everything
    assert _remaining(db) == (3, ["old and read", "old and unread", "recent and read"])
    assert prune_history(db, 60) == (0, 0)
    monkeypatch.setattr("annotamate.server.services.notify.PRUNE_BATCH", 1)  # several transactions
    assert prune_history(db, 30) == (2, 1)
    assert _remaining(db) == (1, ["old and unread", "recent and read"])
    assert prune_history(db, 30) == (0, 0)
    assert prune_history(db, 1) == (1, 1)
    assert _remaining(db) == (0, ["old and unread"])  # unread notifications are never removed
    db.dispose()


@pytest.mark.parametrize(("days", "left"), [(30, (1, ["old and unread", "recent and read"])),
                                            (0, (3, ["old and read", "old and unread", "recent and read"]))])
def test_retention_runs_as_a_background_job_at_start_up(tmp_path, root, days, left):
    app = create_app(Settings(data_dir=tmp_path / "data", roots=[str(root)], static_dir=tmp_path / "no-static",
                              activity_retention_days=days))
    ctx = app.state.ctx
    _history(ctx.db)
    with TestClient(app):
        deadline = time.monotonic() + 10
        while days and _remaining(ctx.db) != left and time.monotonic() < deadline:
            time.sleep(0.02)
        wait_idle(app)
        assert _remaining(ctx.db) == left


# ----------------------------------------------------------------------------------- the benchmark script


def test_benchmark_helpers(tmp_path):
    script = Path(__file__).resolve().parent.parent / "scripts" / "benchmark.py"
    spec = importlib.util.spec_from_file_location("annotamate_benchmark", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    module.make_dataset(tmp_path / "ds", 6)
    with PILImage.open(tmp_path / "ds" / "img_0000003.png") as image:
        assert image.size == (16, 16)
    assert sorted(p.name for p in (tmp_path / "ds").glob("*.txt")) == [
        "classes.txt", "img_0000000.txt", "img_0000002.txt", "img_0000004.txt"]

    good = {"images": 10_000, **{name: limit / 2 for name, limit in module.THRESHOLDS_10K.items()},
            **{name: minimum * 2 for name, minimum in module.MINIMUMS_10K.items()}}
    assert module.check(good) == []
    slow = {**good, "export_coco_s": module.THRESHOLDS_10K["export_coco_s"] * 2, "parallel_rps": 1.0}
    problems = module.check(slow)
    assert len(problems) == 2 and problems[0].startswith("export_coco_s") and "parallel_rps" in problems[1]
    # times that grow with the project are allowed to: ten times the images, ten times the limit
    assert module.check({**slow, "images": 100_000, "parallel_rps": 100.0}) == []
    # a rescan that costs most of a first index reads every file again, however fast the machine is
    rereading = {**good, "first_index_s": 1.0, "rescan_unchanged_s": 0.7}
    assert [p.split(" ")[0] for p in module.check(rereading)] == ["rescan_unchanged_s"]
