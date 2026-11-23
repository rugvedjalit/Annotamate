"""Class list changes and the label-file rewrites they trigger."""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET

from conftest import delete_class, images_of, make_image, wait_idle


def _yolo_project(create_project, root, names=("a", "b", "c")):
    folder = root / "yolo"
    for n in range(1, 4):
        make_image(folder / f"i{n}.jpg", (100, 100))
    (folder / "classes.txt").write_text("".join(f"{n}\n" for n in names))
    (folder / "i1.txt").write_text("0 0.5 0.5 0.1 0.1\n2 0.2 0.2 0.1 0.1\n")
    (folder / "i2.txt").write_text("1 0.5 0.5 0.1 0.1\n2 0.3 0.3 0.1 0.1 \n9 0.4 0.4 0.1 0.1\n")
    (folder / "i3.txt").write_text("2 0.5 0.5 0.2 0.2\n")
    return folder, create_project(folder)


def test_add_class(admin, create_project, dataset):
    project = create_project(dataset, classes=["cat"])
    pid = project["id"]
    added = admin.post(f"/api/projects/{pid}/classes", json={"name": "  dog "})
    assert added.status_code == 200
    body = added.json()
    assert body["name"] == "dog" and body["index"] == 1 and body["color"].startswith("#")
    assert body["color"] != project["classes"][0]["color"]
    custom = admin.post(f"/api/projects/{pid}/classes", json={"name": "bird", "color": "#ABCDEF"}).json()
    assert custom["color"] == "#abcdef"
    dup = admin.post(f"/api/projects/{pid}/classes", json={"name": "dog"})
    assert dup.status_code == 409 and dup.json()["code"] == "exists"
    assert admin.post(f"/api/projects/{pid}/classes", json={"name": "two\nlines"}).status_code == 400
    assert admin.post(f"/api/projects/{pid}/classes", json={"name": "  "}).status_code == 400
    assert admin.post(f"/api/projects/{pid}/classes", json={"name": "x", "color": "blue"}).status_code == 422
    assert (dataset / "classes.txt").read_text() == "cat\ndog\nbird\n"
    assert [c["name"] for c in admin.get(f"/api/projects/{pid}/classes").json()] == ["cat", "dog", "bird"]
    types = [a["type"] for a in admin.get(f"/api/projects/{pid}/activity").json()["items"]]
    assert "class_added" in types


def test_adding_class_resolves_unknown_labels(admin, app, create_project, dataset):
    (dataset / "img1.txt").write_text("0 0.5 0.5 0.2 0.2\n1 0.1 0.1 0.1 0.1\n")
    project = create_project(dataset, classes=["cat"])
    pid = project["id"]
    image = images_of(admin, pid)[0]
    assert image["box_count"] == 2 and len(image["class_ids"]) == 1
    dog = admin.post(f"/api/projects/{pid}/classes", json={"name": "dog"}).json()
    wait_idle(app)
    image = images_of(admin, pid)[0]
    assert image["class_ids"] == [project["classes"][0]["id"], dog["id"]]


def test_rename_and_recolor_yolo(admin, create_project, root):
    folder, project = _yolo_project(create_project, root)
    a = project["classes"][0]
    before = (folder / "i1.txt").read_text()
    renamed = admin.patch(f"/api/projects/{project['id']}/classes/{a['id']}", json={"name": "alpha",
                                                                                     "color": "#000000"})
    assert renamed.json() == {"id": a["id"], "index": 0, "name": "alpha", "color": "#000000"}
    assert (folder / "classes.txt").read_text() == "alpha\nb\nc\n"
    assert (folder / "i1.txt").read_text() == before  # YOLO stores indexes: nothing to rewrite
    b = project["classes"][1]
    assert admin.patch(f"/api/projects/{project['id']}/classes/{b['id']}", json={"name": "c"}).status_code == 409
    assert admin.patch(f"/api/projects/{project['id']}/classes/999", json={"name": "z"}).status_code == 404
    feed = admin.get(f"/api/projects/{project['id']}/activity").json()["items"]
    renamed_entry = next(a for a in feed if a["type"] == "class_updated")
    assert renamed_entry["data"] == {"class_id": a["id"], "name": "alpha", "old_name": "a", "color": "#000000"}
    admin.patch(f"/api/projects/{project['id']}/classes/{b['id']}", json={"color": "#123456"})
    recolored = admin.get(f"/api/projects/{project['id']}/activity").json()["items"][0]
    assert recolored["data"] == {"class_id": b["id"], "name": "b", "color": "#123456"}  # name for display


def test_rename_rewrites_voc_and_coco_files(admin, app, create_project, root):
    voc = root / "voc"
    make_image(voc / "a.jpg")
    (voc / "a.xml").write_text("<annotation><object><name>car</name><pose>Left</pose><bndbox><xmin>1</xmin>"
                               "<ymin>1</ymin><xmax>9</xmax><ymax>9</ymax></bndbox></object></annotation>")
    project = create_project(voc, label_format="voc")
    car = project["classes"][0]
    admin.patch(f"/api/projects/{project['id']}/classes/{car['id']}", json={"name": "automobile"})
    wait_idle(app)
    obj = ET.parse(voc / "a.xml").getroot().find("object")
    assert obj.findtext("name") == "automobile" and obj.findtext("pose") == "Left"
    image = images_of(admin, project["id"])[0]
    doc = admin.get(f"/api/projects/{project['id']}/images/{image['id']}/annotation").json()
    assert doc["boxes"][0]["class_id"] == car["id"]

    coco = root / "coco"
    make_image(coco / "a.jpg")
    (coco / "a.json").write_text(json.dumps({
        "images": [{"id": 1, "file_name": "a.jpg", "width": 100, "height": 50}],
        "annotations": [{"id": 1, "image_id": 1, "category_id": 1, "bbox": [1, 1, 4, 4], "score": 0.9}],
        "categories": [{"id": 1, "name": "cat"}],
    }))
    project = create_project(coco, label_format="coco", name="C")
    cat = project["classes"][0]
    admin.patch(f"/api/projects/{project['id']}/classes/{cat['id']}", json={"name": "kitty"})
    wait_idle(app)
    data = json.loads((coco / "a.json").read_text())
    assert data["categories"][0]["name"] == "kitty" and data["annotations"][0]["score"] == 0.9


def test_delete_forbid_when_used(admin, create_project, root):
    _folder, project = _yolo_project(create_project, root)
    c = project["classes"][2]
    response = admin.delete(f"/api/projects/{project['id']}/classes/{c['id']}")
    assert response.status_code == 409
    assert response.json()["code"] == "in_use" and response.json()["images"] == 3
    assert len(admin.get(f"/api/projects/{project['id']}/classes").json()) == 3


def test_delete_unused_class_shifts_yolo_indexes(admin, app, create_project, root):
    folder, project = _yolo_project(create_project, root, names=("a", "unused", "b", "c"))
    # files were written for a/b/c at indexes 0/1/2; with "unused" at 1 the file indexes mean a/unused/b
    pid = project["id"]
    unused = project["classes"][1]
    response = admin.delete(f"/api/projects/{pid}/classes/{unused['id']}")
    assert response.status_code == 409  # index 1 is used by i2.txt
    (folder / "i2.txt").write_text("2 0.3 0.3 0.1 0.1\n")
    admin.post(f"/api/projects/{pid}/rescan")
    wait_idle(app)
    assert delete_class(admin, app, pid, unused["id"])["rewritten_files"] == 3
    assert (folder / "i1.txt").read_text() == "0 0.5 0.5 0.1 0.1\n1 0.2 0.2 0.1 0.1\n"
    assert (folder / "i2.txt").read_text() == "1 0.3 0.3 0.1 0.1\n"
    assert (folder / "classes.txt").read_text() == "a\nb\nc\n"
    classes = admin.get(f"/api/projects/{pid}/classes").json()
    assert [(c["name"], c["index"]) for c in classes] == [("a", 0), ("b", 1), ("c", 2)]


def test_delete_boxes_strategy(admin, app, create_project, root):
    folder, project = _yolo_project(create_project, root)
    pid = project["id"]
    _a, b, c = project["classes"]
    response = admin.delete(f"/api/projects/{pid}/classes/{b['id']}", params={"strategy": "delete_boxes"})
    assert response.status_code == 202 and response.json() == {"started": True}  # the rewrite runs as a job
    wait_idle(app)
    assert (folder / "i1.txt").read_text() == "0 0.5 0.5 0.1 0.1\n1 0.2 0.2 0.1 0.1\n"
    # unknown index 9 and trailing whitespace on other lines are preserved
    assert (folder / "i2.txt").read_text() == "1 0.3 0.3 0.1 0.1 \n9 0.4 0.4 0.1 0.1\n"
    assert (folder / "i3.txt").read_text() == "1 0.5 0.5 0.2 0.2\n"
    items = {i["filename"]: i for i in images_of(admin, pid)}
    assert items["i2.jpg"]["box_count"] == 2 and items["i2.jpg"]["class_ids"] == [c["id"]]
    assert (folder / "classes.txt").read_text() == "a\nc\n"
    activity = admin.get(f"/api/projects/{pid}/activity").json()["items"][0]
    assert activity["type"] == "class_deleted" and activity["data"]["rewritten_files"] == 3


def test_merge_strategy_yolo(admin, app, create_project, root):
    folder, project = _yolo_project(create_project, root)
    pid = project["id"]
    a, b, c = project["classes"]
    assert admin.delete(f"/api/projects/{pid}/classes/{a['id']}", params={"strategy": "merge"}).status_code == 400
    assert admin.delete(f"/api/projects/{pid}/classes/{a['id']}",
                        params={"strategy": "merge", "merge_into": a["id"]}).status_code == 400
    assert admin.delete(f"/api/projects/{pid}/classes/{a['id']}",
                        params={"strategy": "merge", "merge_into": 999}).status_code == 404
    assert delete_class(admin, app, pid, a["id"], strategy="merge", merge_into=c["id"])["type"] == "class_deleted"
    assert (folder / "i1.txt").read_text() == "1 0.5 0.5 0.1 0.1\n1 0.2 0.2 0.1 0.1\n"
    assert (folder / "i2.txt").read_text() == "0 0.5 0.5 0.1 0.1\n1 0.3 0.3 0.1 0.1 \n9 0.4 0.4 0.1 0.1\n"
    items = {i["filename"]: i for i in images_of(admin, pid)}
    assert items["i1.jpg"]["class_ids"] == [c["id"]] and items["i1.jpg"]["box_count"] == 2
    assert admin.get(f"/api/projects/{pid}/stats").json()["class_counts"] == [
        {"class_id": b["id"], "boxes": 1, "images": 1}, {"class_id": c["id"], "boxes": 4, "images": 3}]
    entry = admin.get(f"/api/projects/{pid}/activity").json()["items"][0]
    assert entry["type"] == "class_deleted"
    assert entry["data"] == {"class_id": a["id"], "name": a["name"], "strategy": "merge", "merge_into": c["id"],
                             "merge_into_name": c["name"], "rewritten_files": 3}


def test_merge_strategy_voc(admin, app, create_project, root):
    folder = root / "voc"
    make_image(folder / "a.jpg")
    (folder / "a.xml").write_text("<annotation><object><name>van</name><bndbox><xmin>1</xmin><ymin>1</ymin>"
                                  "<xmax>9</xmax><ymax>9</ymax></bndbox></object><object><name>car</name>"
                                  "<bndbox><xmin>2</xmin><ymin>2</ymin><xmax>8</xmax><ymax>8</ymax></bndbox>"
                                  "</object></annotation>")
    project = create_project(folder, label_format="voc", classes=["car", "van"])
    car, van = project["classes"]
    result = delete_class(admin, app, project["id"], van["id"], strategy="merge", merge_into=car["id"])
    assert result["type"] == "class_deleted" and result["rewritten_files"] == 1
    names = [o.findtext("name") for o in ET.parse(folder / "a.xml").getroot().findall("object")]
    assert names == ["car", "car"]
    assert (folder / "classes.txt").read_text() == "car\n"


def test_invalid_strategy(admin, app, create_project, dataset):
    project = create_project(dataset, classes=["a"])
    cid = project["classes"][0]["id"]
    assert admin.delete(f"/api/projects/{project['id']}/classes/{cid}",
                        params={"strategy": "nuke"}).status_code == 422
    assert delete_class(admin, app, project["id"], cid)["rewritten_files"] == 0
    assert admin.get(f"/api/projects/{project['id']}/classes").json() == []


# ------------------------------------------------------------------------------ all-or-nothing rewrites


def _hidden(folder):
    return sorted(p.name for p in folder.iterdir() if p.name.endswith((".tmp", ".bak")))


def test_failed_delete_rolls_everything_back_and_a_retry_works(admin, app, create_project, root, monkeypatch):
    from annotamate.core import fsutil

    folder, project = _yolo_project(create_project, root)
    pid = project["id"]
    a, b, _c = project["classes"]
    before = {n: (folder / n).read_text() for n in ("i1.txt", "i2.txt", "i3.txt")}
    real = fsutil._replace

    def flaky(src, dst):
        if dst.endswith("i3.txt") and src.endswith(".tmp"):
            raise PermissionError(13, "file in use", dst)
        real(src, dst)

    monkeypatch.setattr(fsutil, "_replace", flaky)
    failed = delete_class(admin, app, pid, a["id"], strategy="merge", merge_into=b["id"])
    assert failed["type"] == "class_delete_failed" and "Nothing was changed" in failed["error"]
    assert failed["code"] == "bad_request" and failed["merge_into_name"] == "b"
    assert {n: (folder / n).read_text() for n in before} == before
    assert _hidden(folder) == []
    assert [c_["name"] for c_ in admin.get(f"/api/projects/{pid}").json()["classes"]] == ["a", "b", "c"]
    monkeypatch.setattr(fsutil, "_replace", real)
    retry = delete_class(admin, app, pid, a["id"], strategy="merge", merge_into=b["id"])
    assert retry["type"] == "class_deleted" and retry["rewritten_files"] == 3
    assert (folder / "i1.txt").read_text() == "0 0.5 0.5 0.1 0.1\n1 0.2 0.2 0.1 0.1\n"


def test_failed_rollback_is_reported_honestly(admin, app, create_project, root, monkeypatch):
    from annotamate.core import fsutil

    folder, project = _yolo_project(create_project, root)
    pid = project["id"]
    a, b, _c = project["classes"]
    real = fsutil._replace

    def flaky(src, dst):
        if dst.endswith("i3.txt") and src.endswith(".tmp"):
            raise PermissionError(13, "file in use", dst)
        if dst.endswith("i1.txt") and src.endswith(".bak"):
            raise PermissionError(13, "file in use", dst)
        real(src, dst)

    monkeypatch.setattr(fsutil, "_replace", flaky)
    body = delete_class(admin, app, pid, a["id"], strategy="merge", merge_into=b["id"])
    assert body["type"] == "class_delete_failed"
    assert body["code"] == "migration_incomplete" and body["files"] == ["i1.txt"]  # names only, never server paths
    assert [c_["name"] for c_ in admin.get(f"/api/projects/{pid}").json()["classes"]] == ["a", "b", "c"]
    assert any(n.endswith(".bak") for n in _hidden(folder))


def test_startup_rolls_back_an_interrupted_rewrite(tmp_path, settings, root):
    import json as _json

    from annotamate.server import create_app

    folder = root / "crashed"
    folder.mkdir()
    target = folder / "x.txt"
    target.write_text("half-migrated")
    bak = folder / ".x.txt.aa.bak"
    bak.write_text("original")
    tmp = folder / ".x.txt.aa.tmp"
    tmp.write_text("new")
    import hashlib

    settings.journal_dir.mkdir(parents=True)
    entry = {"path": str(target), "tmp": str(tmp), "bak": str(bak),
             "old": hashlib.sha256(b"original").hexdigest(), "new": hashlib.sha256(b"half-migrated").hexdigest()}
    (settings.journal_dir / "label-rewrite-1.json").write_text(_json.dumps({"files": [entry]}))
    create_app(settings)
    assert target.read_text() == "original"
    assert _hidden(folder) == [] and not list(settings.journal_dir.iterdir())
