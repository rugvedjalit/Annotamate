"""Annotation documents: versions, conflicts, force, read-only files, locks, clamping, formats and revisions."""

from __future__ import annotations

import hashlib
import json
import xml.etree.ElementTree as ET
from datetime import timedelta

import pytest
from sqlalchemy import select

from annotamate.server.models import Activity, utcnow
from conftest import box, images_of, make_image


@pytest.fixture
def setup(admin, make_user, create_project, dataset):
    ann = make_user("ann")
    rev = make_user("rev")
    project = create_project(dataset, classes=["cat", "dog"], members=[(ann, "annotator"), (rev, "reviewer")])
    image = images_of(admin, project["id"])[0]
    url = f"/api/projects/{project['id']}/images/{image['id']}"
    cat, dog = (c["id"] for c in project["classes"])
    return project, image, url, cat, dog, ann, rev


def test_empty_document(setup, admin):
    *_, url, _cat, _dog, _ann, _rev = setup
    assert admin.get(f"{url}/annotation").json() == {"version": None, "boxes": [], "readonly_reason": None,
                                                     "updated_at": None, "updated_by": None}


def test_save_and_reload(setup, dataset):
    _project, _image, url, cat, dog, ann, _ = setup
    boxes = [box(cat, 10, 5, 30, 25, id="b1"), box(dog, 50.5, 10.25, 70, 40, id="b2")]
    saved = ann.put(f"{url}/annotation", json={"base_version": None, "boxes": boxes})
    assert saved.status_code == 200
    body = saved.json()
    data = (dataset / "img1.txt").read_bytes()
    assert body["version"] == hashlib.sha256(data).hexdigest()[:16]
    assert body["box_count"] == 2 and body["updated_at"].endswith("Z")
    assert body["image"]["status"] == "in_progress" and body["image"]["class_ids"] == [cat, dog]
    assert body["image"]["last_editor"]["id"] == ann.id
    assert data.decode() == "0 0.200000 0.300000 0.200000 0.400000\n1 0.602500 0.502500 0.195000 0.595000\n"
    assert (dataset / "classes.txt").read_text() == "cat\ndog\n"

    doc = ann.get(f"{url}/annotation").json()
    assert doc["version"] == body["version"] and doc["readonly_reason"] is None
    assert doc["updated_by"]["id"] == ann.id
    assert [b["id"] for b in doc["boxes"]] == ["b1", "b2"]  # ids survive a reload
    assert doc["boxes"][1] == {"id": "b2", "class_id": dog, "raw_label": None, "x1": 50.5, "y1": 10.25,
                               "x2": 70.0, "y2": 40.0, "difficult": False, "truncated": False}


def test_box_ids_are_stable_for_external_files(setup, admin, dataset):
    _, _, url, *_ = setup
    (dataset / "img1.txt").write_text("0 0.5 0.5 0.2 0.2\n")
    first = admin.get(f"{url}/annotation").json()["boxes"][0]["id"]
    second = admin.get(f"{url}/annotation").json()["boxes"][0]["id"]
    assert first == second and len(first) == 36


def test_clamping_and_tiny_boxes(setup):
    _, _, url, cat, _, ann, _ = setup
    boxes = [box(cat, 120, 60, -10, -5), box(cat, 10, 10, 10.5, 20), box(cat, 5, 5, 6, 6)]
    body = ann.put(f"{url}/annotation", json={"base_version": None, "boxes": boxes}).json()
    assert body["box_count"] == 2
    doc = ann.get(f"{url}/annotation").json()
    first = doc["boxes"][0]
    assert (first["x1"], first["y1"], first["x2"], first["y2"]) == (0, 0, 100, 50)


def test_save_returns_the_stored_boxes(setup, dataset):
    """The PUT response carries the boxes as a later GET returns them (clamped, rounded, tiny ones dropped)."""
    _, _, url, cat, dog, ann, _ = setup
    boxes = [box(cat, 120, 60, -10, -5, id="big"), box(dog, 10, 10, 10.5, 20, id="tiny"),
             box(dog, 1 / 3, 2 / 3, 33.333333, 20.123456789, id="odd")]
    body = ann.put(f"{url}/annotation", json={"base_version": None, "boxes": boxes}).json()
    assert body["box_count"] == 2
    assert body["boxes"] == ann.get(f"{url}/annotation").json()["boxes"]
    assert [b["id"] for b in body["boxes"]] == ["big", "odd"]
    big = body["boxes"][0]
    assert (big["x1"], big["y1"], big["x2"], big["y2"]) == (0, 0, 100, 50)


def test_validation(setup):
    _, _, url, cat, _, ann, _ = setup
    unknown = ann.put(f"{url}/annotation", json={"base_version": None, "boxes": [box(999, 1, 1, 9, 9)]})
    assert unknown.status_code == 422 and unknown.json()["errors"][0]["loc"] == ["body", "boxes", "0", "class_id"]
    no_label = ann.put(f"{url}/annotation", json={"base_version": None, "boxes": [box(None, 1, 1, 9, 9)]})
    assert no_label.status_code == 422
    named = box(None, 1, 1, 9, 9)
    named["raw_label"] = "truck"
    assert ann.put(f"{url}/annotation", json={"base_version": None, "boxes": [named]}).status_code == 422
    nan = box(cat, 1, 1, 9, 9)
    nan["x1"] = "NaN"
    assert ann.put(f"{url}/annotation", json={"base_version": None, "boxes": [nan]}).status_code == 422


def test_unknown_labels_round_trip(setup, admin, dataset):
    _, _image, url, _cat, _, ann, _ = setup
    (dataset / "img1.txt").write_text("0 0.5 0.5 0.2 0.2\n7 0.1 0.1 0.1 0.1\n")
    doc = ann.get(f"{url}/annotation").json()
    unknown = doc["boxes"][1]
    assert unknown["class_id"] is None and unknown["raw_label"] == "7"
    saved = ann.put(f"{url}/annotation", json={"base_version": doc["version"], "boxes": doc["boxes"]})
    assert saved.status_code == 200
    assert (dataset / "img1.txt").read_text().splitlines()[1].startswith("7 ")
    assert [c["name"] for c in admin.get(f"/api/projects/{setup[0]['id']}/classes").json()] == ["cat", "dog"]


def test_empty_save_writes_background_file(setup, dataset):
    _, _, url, _, _, ann, _ = setup
    body = ann.put(f"{url}/annotation", json={"base_version": None, "boxes": []}).json()
    assert (dataset / "img1.txt").read_bytes() == b""
    assert body["version"] == hashlib.sha256(b"").hexdigest()[:16]
    assert ann.get(f"{url}/annotation").json()["version"] == body["version"]


def test_conflict_and_force(setup):
    _, _, url, cat, _, ann, rev = setup
    first = ann.put(f"{url}/annotation", json={"base_version": None, "boxes": [box(cat, 1, 1, 9, 9)]}).json()
    stale = rev.put(f"{url}/annotation", json={"base_version": None, "boxes": []})
    assert stale.status_code == 409
    body = stale.json()
    assert body["code"] == "conflict" and body["current"]["version"] == first["version"]
    assert len(body["current"]["boxes"]) == 1
    wrong = rev.put(f"{url}/annotation", json={"base_version": "deadbeefdeadbeef", "boxes": []})
    assert wrong.status_code == 409
    # annotators without the lock cannot force; reviewers can
    second = rev.put(f"{url}/annotation", json={"base_version": first["version"], "boxes": []}).json()
    assert ann.put(f"{url}/annotation", json={"base_version": first["version"], "boxes": [], "force": True}) \
        .status_code == 403
    forced = rev.put(f"{url}/annotation", json={"base_version": first["version"], "boxes": [box(cat, 2, 2, 8, 8)],
                                                "force": True})
    assert forced.status_code == 200 and forced.json()["version"] != second["version"]


def test_lock_holder_can_force_and_others_get_423(setup):
    _, image, url, cat, _, ann, rev = setup
    pid = setup[0]["id"]
    first = rev.put(f"{url}/annotation", json={"base_version": None, "boxes": []}).json()
    rev.put(f"{url}/annotation", json={"base_version": first["version"], "boxes": [box(cat, 1, 1, 5, 5)]})
    with ann.ws() as ws:
        ws.receive_json()  # hello
        ws.send_json({"type": "subscribe", "project_id": pid})
        assert ws.receive_json()["type"] == "presence.snapshot"
        ws.send_json({"type": "lock.acquire", "image_id": image["id"]})
        assert ws.receive_json() == {"type": "lock.granted", "image_id": image["id"]}
        locked = rev.put(f"{url}/annotation", json={"base_version": None, "boxes": []})
        assert locked.status_code == 423
        assert locked.json()["code"] == "locked" and locked.json()["holder"]["id"] == ann.id
        forced = ann.put(f"{url}/annotation", json={"base_version": first["version"], "boxes": [], "force": True})
        assert forced.status_code == 200
    # lock released on disconnect: saves from others work again
    current = rev.get(f"{url}/annotation").json()["version"]
    assert rev.put(f"{url}/annotation", json={"base_version": current, "boxes": []}).status_code == 200


def test_readonly_files(setup, admin, dataset):
    _, _, url, *_ = setup
    (dataset / "img1.txt").write_text("0 0.1 0.1 0.5 0.1 0.5 0.5 0.1 0.5\n")
    doc = admin.get(f"{url}/annotation").json()
    assert "segmentation" in doc["readonly_reason"] and len(doc["boxes"]) == 1
    response = admin.put(f"{url}/annotation", json={"base_version": doc["version"], "boxes": []})
    assert response.status_code == 409 and response.json()["code"] == "readonly"
    assert (dataset / "img1.txt").read_text().startswith("0 0.1 0.1 0.5")

    (dataset / "img1.txt").write_text("this is not yolo\n")
    doc = admin.get(f"{url}/annotation").json()
    assert doc["readonly_reason"] and doc["boxes"] == []
    assert admin.put(f"{url}/annotation", json={"base_version": doc["version"], "boxes": []}).status_code == 409


def test_unreadable_image_is_readonly(admin, create_project, root):
    folder = root / "bad"
    (folder).mkdir()
    (folder / "x.png").write_bytes(b"garbage")
    project = create_project(folder)
    image = images_of(admin, project["id"])[0]
    url = f"/api/projects/{project['id']}/images/{image['id']}"
    assert "cannot be read" in admin.get(f"{url}/annotation").json()["readonly_reason"]
    response = admin.put(f"{url}/annotation", json={"base_version": None, "boxes": []})
    assert response.status_code == 409 and response.json()["code"] == "readonly"


def test_voc_save_and_desktop_files(admin, create_project, root):
    folder = root / "voc"
    make_image(folder / "a.jpg", (100, 50))
    make_image(folder / "b.png", (64, 32), mode="L")
    (folder / "b.xml").write_text(
        '<?xml version="1.0" ?>\n<annotation>\n   <folder>voc</folder>\n   <filename>b.png</filename>\n'
        "   <size>\n      <width>64</width>\n      <height>32</height>\n      <depth>3</depth>\n   </size>\n"
        "   <object>\n      <name>car</name>\n      <pose>Unspecified</pose>\n      <truncated>0</truncated>\n"
        "      <difficult>1</difficult>\n      <bndbox>\n         <xmin>1</xmin>\n         <ymin>2</ymin>\n"
        "         <xmax>30</xmax>\n         <ymax>20</ymax>\n      </bndbox>\n   </object>\n</annotation>\n")
    project = create_project(folder, label_format="voc", classes=["car", "person"])
    car, person = (c["id"] for c in project["classes"])
    items = {i["filename"]: i for i in images_of(admin, project["id"])}
    b_doc = admin.get(f"/api/projects/{project['id']}/images/{items['b.png']['id']}/annotation").json()
    assert b_doc["boxes"][0]["class_id"] == car and b_doc["boxes"][0]["difficult"] is True

    url = f"/api/projects/{project['id']}/images/{items['a.jpg']['id']}"
    boxes = [box(person, 10.4, 5.5, 40.6, 30, truncated=True), {**box(None, 1, 1, 20, 20), "raw_label": "truck"}]
    assert admin.put(f"{url}/annotation", json={"base_version": None, "boxes": boxes}).status_code == 200
    tree = ET.parse(folder / "a.xml").getroot()
    assert tree.findtext("filename") == "a.jpg" and tree.findtext("size/depth") == "3"
    objects = tree.findall("object")
    assert [o.findtext("name") for o in objects] == ["person", "truck"]
    assert [objects[0].findtext(f"bndbox/{k}") for k in ("xmin", "ymin", "xmax", "ymax")] == ["10", "6", "41", "30"]
    assert objects[0].findtext("truncated") == "1"
    doc = admin.get(f"{url}/annotation").json()
    assert doc["boxes"][1]["class_id"] is None and doc["boxes"][1]["raw_label"] == "truck"

    gray = f"/api/projects/{project['id']}/images/{items['b.png']['id']}"
    admin.put(f"{gray}/annotation", json={"base_version": b_doc["version"], "boxes": b_doc["boxes"]})
    assert ET.parse(folder / "b.xml").getroot().findtext("size/depth") == "1"  # real depth of a grayscale image


def test_coco_save_matches_desktop_layout(admin, create_project, root):
    folder = root / "coco"
    make_image(folder / "a.jpg", (100, 50))
    project = create_project(folder, label_format="coco", classes=["cat", "dog"])
    dog = project["classes"][1]["id"]
    image = images_of(admin, project["id"])[0]
    url = f"/api/projects/{project['id']}/images/{image['id']}"
    admin.put(f"{url}/annotation", json={"base_version": None, "boxes": [box(dog, 10, 5, 30.5, 25)]})
    data = json.loads((folder / "a.json").read_text())
    assert data["images"] == [{"id": 1, "width": 100, "height": 50, "file_name": "a.jpg"}]
    assert data["categories"] == [{"id": 1, "name": "cat", "supercategory": "none"},
                                  {"id": 2, "name": "dog", "supercategory": "none"}]
    ann = data["annotations"][0]
    assert ann["category_id"] == 2 and ann["bbox"] == [10, 5, 20.5, 20] and ann["iscrowd"] == 0
    assert admin.get(f"{url}/annotation").json()["boxes"][0]["class_id"] == dog


def test_revisions_and_restore(setup, app):
    project, _image, url, cat, dog, ann, _rev = setup
    v1 = ann.put(f"{url}/annotation", json={"base_version": None, "boxes": [box(cat, 1, 1, 9, 9, id="a")]}).json()
    v2 = ann.put(f"{url}/annotation", json={"base_version": v1["version"],
                                            "boxes": [box(dog, 2, 2, 8, 8, id="b"), box(cat, 3, 3, 7, 7)]}).json()
    revisions = ann.get(f"{url}/revisions").json()
    assert [r["version"] for r in revisions] == [v2["version"], v1["version"]]
    assert revisions[0]["box_count"] == 2 and revisions[0]["user"]["id"] == ann.id
    detail = ann.get(f"{url}/revisions/{revisions[1]['id']}").json()
    assert [b["id"] for b in detail["boxes"]] == ["a"] and detail["boxes"][0]["class_id"] == cat
    assert ann.get(f"{url}/revisions/999999").status_code == 404

    stale = ann.post(f"{url}/revisions/{revisions[1]['id']}/restore", json={"base_version": v1["version"]})
    assert stale.status_code == 409
    restored = ann.post(f"{url}/revisions/{revisions[1]['id']}/restore", json={"base_version": v2["version"]})
    assert restored.status_code == 200 and restored.json()["box_count"] == 1
    assert ann.get(f"{url}/annotation").json()["boxes"][0]["id"] == "a"
    assert len(ann.get(f"{url}/revisions").json()) == 3
    types = [a["type"] for a in ann.get(f"/api/projects/{project['id']}/activity").json()["items"]]
    assert "revision_restored" in types


def test_restore_after_class_deleted(setup, admin):
    project, _image, url, cat, dog, ann, _ = setup
    v1 = ann.put(f"{url}/annotation", json={"base_version": None,
                                            "boxes": [box(cat, 1, 1, 9, 9), box(dog, 2, 2, 8, 8)]}).json()
    v2 = ann.put(f"{url}/annotation", json={"base_version": v1["version"], "boxes": []}).json()
    first = ann.get(f"{url}/revisions").json()[-1]
    assert admin.delete(f"/api/projects/{project['id']}/classes/{dog}").status_code == 200
    detail = ann.get(f"{url}/revisions/{first['id']}").json()
    assert [b["class_id"] for b in detail["boxes"]] == [cat]  # YOLO: a deleted class cannot be restored by index
    restored = ann.post(f"{url}/revisions/{first['id']}/restore", json={"base_version": v2["version"]})
    assert restored.json()["box_count"] == 1


def test_revisions_are_capped(setup):
    _, _, url, cat, _, ann, _ = setup
    version = None
    for n in range(53):
        version = ann.put(f"{url}/annotation", json={"base_version": version,
                                                     "boxes": [box(cat, 1, 1, 2 + n % 40, 9)]}).json()["version"]
    assert len(ann.get(f"{url}/revisions").json()) == 50


def test_saves_coalesce_in_activity(setup, app):
    project, _image, url, cat, _, ann, _ = setup
    v = ann.put(f"{url}/annotation", json={"base_version": None, "boxes": []}).json()["version"]
    v = ann.put(f"{url}/annotation", json={"base_version": v, "boxes": [box(cat, 1, 1, 9, 9)]}).json()["version"]
    saves = [a for a in ann.get(f"/api/projects/{project['id']}/activity").json()["items"]
             if a["type"] == "annotation_saved"]
    assert len(saves) == 1 and saves[0]["data"] == {"box_count": 1, "saves": 2}
    with app.state.ctx.db.session() as session:
        row = session.scalars(select(Activity).where(Activity.type == "annotation_saved")).one()
        row.created_at = utcnow() - timedelta(minutes=11)
        session.commit()
    ann.put(f"{url}/annotation", json={"base_version": v, "boxes": []})
    saves = [a for a in ann.get(f"/api/projects/{project['id']}/activity").json()["items"]
             if a["type"] == "annotation_saved"]
    assert len(saves) == 2


def test_label_symlink_outside_is_readonly(admin, create_project, root, tmp_path):
    import os

    folder = root / "links"
    make_image(folder / "a.jpg")
    outside = tmp_path / "outside.txt"
    outside.write_text("0 0.5 0.5 0.1 0.1\n")
    try:
        os.symlink(outside, folder / "a.txt")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not available")
    project = create_project(folder, classes=["x"])
    image = images_of(admin, project["id"])[0]
    url = f"/api/projects/{project['id']}/images/{image['id']}"
    assert "outside" in admin.get(f"{url}/annotation").json()["readonly_reason"]
    assert admin.put(f"{url}/annotation", json={"base_version": None, "boxes": []}).status_code == 409
    assert outside.read_text() == "0 0.5 0.5 0.1 0.1\n"
