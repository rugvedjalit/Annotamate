"""Dataset export (zip) and image upload."""

from __future__ import annotations

import io
import json
import xml.etree.ElementTree as ET
import zipfile

import pytest
from PIL import Image

from conftest import box, images_of, make_image


def png_bytes(size=(20, 10), color="blue") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def labelled(admin, create_project, root):
    folder = root / "export"
    make_image(folder / "a.jpg", (100, 50))
    make_image(folder / "b.jpg", (100, 50))
    make_image(folder / "sub" / "c.jpg", (100, 50))
    project = create_project(folder, classes=["cat", "dog"], settings={"recursive": True})
    pid = project["id"]
    cat, dog = (c["id"] for c in project["classes"])
    items = {i["rel_path"]: i for i in images_of(admin, pid)}
    admin.put(f"/api/projects/{pid}/images/{items['a.jpg']['id']}/annotation",
              json={"base_version": None, "boxes": [box(cat, 10, 10, 30, 20), box(dog, 50, 0, 100, 50)]})
    admin.put(f"/api/projects/{pid}/images/{items['sub/c.jpg']['id']}/annotation",
              json={"base_version": None, "boxes": [box(dog, 0, 0, 10, 10)]})
    admin.post(f"/api/projects/{pid}/images/{items['sub/c.jpg']['id']}/status", json={"action": "submit"})
    return project, folder, items


def zip_of(response) -> zipfile.ZipFile:
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert "attachment" in response.headers["content-disposition"]
    return zipfile.ZipFile(io.BytesIO(response.content))


def test_export_yolo(admin, labelled):
    project, folder, _ = labelled
    archive = zip_of(admin.get(f"/api/projects/{project['id']}/export", params={"format": "yolo"}))
    names = set(archive.namelist())
    assert names == {"labels/a.txt", "labels/sub/c.txt", "classes.txt", "data.yaml"}
    assert archive.read("labels/a.txt") == (folder / "a.txt").read_bytes()
    assert archive.read("classes.txt") == b"cat\ndog\n"
    yaml = archive.read("data.yaml").decode()
    assert "nc: 2" in yaml and '0: "cat"' in yaml and '1: "dog"' in yaml and "train: images" in yaml


def test_export_done_scope_with_images(admin, labelled):
    project, folder, _ = labelled
    archive = zip_of(admin.get(f"/api/projects/{project['id']}/export",
                               params={"format": "yolo", "scope": "done", "include_images": "true"}))
    assert set(archive.namelist()) == {"labels/sub/c.txt", "images/sub/c.jpg", "classes.txt", "data.yaml"}
    assert archive.read("images/sub/c.jpg") == (folder / "sub" / "c.jpg").read_bytes()


def test_export_voc(admin, labelled):
    project, _, _ = labelled
    archive = zip_of(admin.get(f"/api/projects/{project['id']}/export", params={"format": "voc"}))
    assert set(archive.namelist()) == {"Annotations/a.xml", "Annotations/sub/c.xml"}
    root = ET.fromstring(archive.read("Annotations/a.xml"))
    objects = [(o.findtext("name"), [o.findtext(f"bndbox/{k}") for k in ("xmin", "ymin", "xmax", "ymax")])
               for o in root.findall("object")]
    assert objects == [("cat", ["10", "10", "30", "20"]), ("dog", ["50", "0", "100", "50"])]
    assert root.findtext("size/width") == "100" and root.findtext("size/depth") == "3"


def test_export_coco(admin, labelled):
    project, _, _ = labelled
    archive = zip_of(admin.get(f"/api/projects/{project['id']}/export", params={"format": "coco"}))
    assert archive.namelist() == ["annotations.json"]
    data = json.loads(archive.read("annotations.json"))
    assert [i["file_name"] for i in data["images"]] == ["a.jpg", "sub/c.jpg"]
    assert [i["id"] for i in data["images"]] == [1, 2]
    assert data["categories"] == [{"id": 1, "name": "cat", "supercategory": "none"},
                                  {"id": 2, "name": "dog", "supercategory": "none"}]
    anns = data["annotations"]
    assert [a["id"] for a in anns] == [1, 2, 3]
    assert anns[0] == {"id": 1, "image_id": 1, "category_id": 1, "bbox": [10.0, 10.0, 20.0, 10.0], "area": 200.0,
                       "iscrowd": 0, "segmentation": []}
    assert anns[2]["image_id"] == 2 and anns[2]["category_id"] == 2


def test_export_default_format_and_validation(admin, labelled):
    project, _, _ = labelled
    archive = zip_of(admin.get(f"/api/projects/{project['id']}/export"))
    assert "data.yaml" in archive.namelist()
    assert admin.get(f"/api/projects/{project['id']}/export", params={"format": "csv"}).status_code == 422
    assert admin.get(f"/api/projects/{project['id']}/export", params={"scope": "some"}).status_code == 422


def test_upload(admin, create_project, root, app):
    folder = root / "up"
    make_image(folder / "img5.png")
    project = create_project(folder)
    pid = project["id"]
    files = [
        ("files[]", ("img10.png", png_bytes(), "image/png")),
        ("files[]", ("img5.png", png_bytes(), "image/png")),  # exists: gets a suffix
        ("files[]", ("../../evil.png", png_bytes(), "image/png")),
        ("files[]", ("notes.txt", b"hello", "text/plain")),
        ("files[]", ("fake.jpg", b"not really a jpeg", "image/jpeg")),
        ("files", ("img1.png", png_bytes(), "image/png")),
    ]
    response = admin.post(f"/api/projects/{pid}/upload", files=files)
    assert response.status_code == 200, response.text
    body = response.json()
    added = sorted(i["rel_path"] for i in body["added"])
    assert added == ["evil.png", "img1.png", "img10.png", "img5-1.png"]
    assert {s["filename"] for s in body["skipped"]} == {"notes.txt", "fake.jpg"}
    assert (folder / "img5.png").exists() and (folder / "img5-1.png").exists()
    assert not (root / "evil.png").exists() and (folder / "evil.png").exists()
    names = [i["filename"] for i in images_of(admin, pid)]
    assert names == ["evil.png", "img1.png", "img5-1.png", "img5.png", "img10.png"]
    assert [i["position"] for i in images_of(admin, pid)] == [0, 1, 2, 3, 4]
    activity = admin.get(f"/api/projects/{pid}/activity").json()["items"][0]
    assert activity["type"] == "images_uploaded" and activity["data"] == {"count": 4}


def test_upload_limits_and_subdirs(admin, create_project, root, app):
    folder = root / "up2"
    make_image(folder / "x.png")
    project = create_project(folder)
    pid = project["id"]
    app.state.ctx.settings.max_upload_mb = 1
    big = b"\x89PNG" + b"0" * (1024 * 1024 + 10)
    single = admin.post(f"/api/projects/{pid}/upload", files={"files[]": ("big.png", big, "image/png")})
    assert single.status_code == 413 and single.json()["code"] == "too_large"
    mixed = admin.post(f"/api/projects/{pid}/upload", files=[("files[]", ("big.png", big, "image/png")),
                                                             ("files[]", ("ok.png", png_bytes(), "image/png"))])
    assert [s["filename"] for s in mixed.json()["skipped"]] == ["big.png"]
    assert admin.post(f"/api/projects/{pid}/upload", data={"x": "1"}).status_code == 400
    flat = admin.post(f"/api/projects/{pid}/upload", data={"subdir": "batch1"},
                      files={"files[]": ("s.png", png_bytes(), "image/png")})
    assert flat.status_code == 400  # sub-folders need a recursive project
    admin.patch(f"/api/projects/{pid}", json={"settings": {"recursive": True}})
    from conftest import wait_idle

    wait_idle(app)
    nested = admin.post(f"/api/projects/{pid}/upload", data={"subdir": "../batch1/./day 2"},
                        files={"files[]": ("s.png", png_bytes(), "image/png")})
    assert nested.status_code == 200
    assert nested.json()["added"][0]["rel_path"] == "batch1/day 2/s.png"
    assert (folder / "batch1" / "day 2" / "s.png").exists()
