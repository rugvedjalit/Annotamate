"""Hostile or damaged files in a dataset: label files, images, names and archives must never break the server."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pytest
from PIL import Image

from annotamate.core import scanning
from annotamate.core.formats import (
    MAX_BOXES,
    TOO_LARGE_REASON,
    TOO_MANY_BOXES_REASON,
    ImageContext,
    parse_label,
    relabel,
    serialize_label,
)
from annotamate.core.formats import voc as voc_format
from annotamate.core.fsutil import sanitize_filename
from annotamate.core.images import ImageError, probe
from annotamate.server.services import export as export_service
from annotamate.server.services import labels as labels_service
from conftest import box, images_of, make_image

IMAGE = ImageContext(100, 50, 3, "a.jpg", "dir", "a.jpg")
VOC_HEAD = b"<annotation><size><width>10</width><height>10</height></size>"


def voc_doc(body: str = "") -> bytes:
    obj = "<object><name>cat</name><bndbox><xmin>1</xmin><ymin>1</ymin><xmax>5</xmax><ymax>5</ymax></bndbox></object>"
    return VOC_HEAD + obj.encode() + body.encode() + b"</annotation>"


# ---- finding 1 and 3: malformed label files never raise ----------

HUGE_INT = "9" * 400


@pytest.mark.parametrize("data", [
    '{"annotations": [{"bbox": [' + HUGE_INT + ', 0, 1, 1], "category_id": 1}]}',
    "[" * 100_000,
    '{"a":' * 100_000,
    json.dumps({"annotations": [5, None, "x", [1]]}),
    json.dumps({"annotations": [{"bbox": [0, 0, 1, 1], "category_id": [1]}], "categories": [{"id": [1], "name": 3}]}),
    json.dumps({"annotations": {"a": 1}, "categories": 7, "images": "x"}),
    json.dumps({"images": [1, 2], "annotations": [{"bbox": "abcd"}]}),
])
def test_coco_malformed_never_raises(data):
    raw = data.encode()
    result = parse_label("coco", raw)
    assert result.readonly_reason or result.boxes == []
    for mapping in ({"1": "2"}, {"1": None}, {"None": "x"}):
        out, changed = relabel("coco", raw, name_map=mapping, class_names=["a", "b"])
        assert isinstance(out, bytes) and changed >= 0
    serialize_label("coco", [], IMAGE, ["a"], original=raw)


def test_coco_relabel_skips_bad_entries_without_corrupting():
    doc = {"annotations": [5, {"bbox": [0, 0, 1, 1], "category_id": 1}], "categories": [{"id": 1, "name": "a"}]}
    raw = json.dumps(doc).encode()
    assert relabel("coco", raw, name_map={"a": "b"}, class_names=["b"]) == (raw, 0)
    list_cat = json.dumps({"annotations": [{"bbox": [0, 0, 1, 1], "category_id": [1]}],
                           "categories": [{"id": 1, "name": "a"}]}).encode()
    assert relabel("coco", list_cat, name_map={"a": "b"}, class_names=["b"]) == (list_cat, 0)


@pytest.mark.parametrize(("fmt", "data"), [
    ("yolo", ("0 " + "9" * 400 + " 0.5 0.1 0.1\n").encode()),
    ("yolo", b"0 nan 0.5 0.1 0.1\n" + b"\x00" * 10),
    ("voc", b"<annotation><object><name>a</name><bndbox><xmin>" + b"9" * 400 + b"</xmin></bndbox></object>"
     b"</annotation>"),
    ("voc", b""),
    ("voc", b"\x00\x01\x02"),
    ("coco", b""),
])
def test_other_formats_malformed_never_raise(fmt, data):
    result = parse_label(fmt, data, 100, 50)
    assert result.readonly_reason
    new, changed = relabel(fmt, data, index_map={0: 1}, name_map={"a": "b"}, class_names=["a"])  # must not raise
    assert isinstance(new, bytes) and changed >= 0


def test_readonly_reason_echoes_at_most_100_characters():
    token = "x" * 1_000_000
    for fmt, data in (("yolo", f"{token} 0.5 0.5 0.1 0.1\n".encode()),
                      ("coco", ("{" + token).encode())):
        reason = parse_label(fmt, data).readonly_reason
        assert reason and len(reason) < 250, reason


# ---- finding 2: size and box limits ----------

def test_box_limit_makes_file_readonly_and_stops_early():
    yolo = ("0 0.5 0.5 0.1 0.1\n" * (MAX_BOXES + 500)).encode()
    result = parse_label("yolo", yolo)
    assert result.readonly_reason == TOO_MANY_BOXES_REASON
    assert len(result.boxes) == MAX_BOXES
    one = "<object><name>a</name><bndbox><xmin>1</xmin><ymin>1</ymin><xmax>2</xmax><ymax>2</ymax></bndbox></object>"
    voc = ("<annotation>" + one * (MAX_BOXES + 5) + "</annotation>").encode()
    assert parse_label("voc", voc).readonly_reason == TOO_MANY_BOXES_REASON
    ann = {"bbox": [0, 0, 1, 1], "category_id": 1}
    coco = json.dumps({"annotations": [ann] * (MAX_BOXES + 5)}).encode()
    assert parse_label("coco", coco).readonly_reason == TOO_MANY_BOXES_REASON
    exactly = parse_label("yolo", ("0 0.5 0.5 0.1 0.1\n" * MAX_BOXES).encode())
    assert exactly.readonly_reason is None and len(exactly.boxes) == MAX_BOXES


def test_oversized_label_file_is_not_loaded(monkeypatch):
    monkeypatch.setattr("annotamate.core.formats.MAX_LABEL_BYTES", 100)
    monkeypatch.setattr(labels_service, "MAX_LABEL_BYTES", 100)
    assert parse_label("yolo", b"0 0.5 0.5 0.1 0.1\n" * 10).readonly_reason == TOO_LARGE_REASON
    big = io.BytesIO(b"x" * 101)
    assert labels_service.read_limited(big) is None
    assert labels_service.read_limited(io.BytesIO(b"x" * 100)) == b"x" * 100


def test_huge_label_in_a_project(admin, create_project, root):
    folder = root / "huge"
    make_image(folder / "a.jpg")
    make_image(folder / "b.jpg")
    (folder / "a.txt").write_text("0 0.5 0.5 0.1 0.1\n" * (MAX_BOXES + 1))
    (folder / "b.txt").write_text("0 0.5 0.5 0.1 0.1\n")
    project = create_project(folder, classes=["cat"])
    pid = project["id"]
    items = {i["rel_path"]: i for i in images_of(admin, pid)}
    assert items["b.jpg"]["box_count"] == 1
    doc = admin.get(f"/api/projects/{pid}/images/{items['a.jpg']['id']}/annotation").json()
    assert doc["readonly_reason"] == TOO_MANY_BOXES_REASON and len(doc["boxes"]) == MAX_BOXES
    put = admin.put(f"/api/projects/{pid}/images/{items['a.jpg']['id']}/annotation",
                    json={"base_version": doc["version"], "boxes": []})
    assert put.status_code == 409


def test_oversized_label_in_a_project(admin, create_project, root, monkeypatch):
    monkeypatch.setattr("annotamate.core.formats.MAX_LABEL_BYTES", 200)
    monkeypatch.setattr(labels_service, "MAX_LABEL_BYTES", 200)
    folder = root / "big"
    make_image(folder / "a.jpg")
    (folder / "a.txt").write_text("0 0.5 0.5 0.1 0.1\n" * 50)
    project = create_project(folder, classes=["cat"])
    pid = project["id"]
    item = images_of(admin, pid)[0]
    assert item["box_count"] == 0
    doc = admin.get(f"/api/projects/{pid}/images/{item['id']}/annotation").json()
    assert doc["readonly_reason"] == TOO_LARGE_REASON and doc["boxes"] == []


# ---- finding 1: one bad file does not disable the project ----------

def test_bad_coco_file_does_not_break_project(admin, create_project, root):
    folder = root / "coco"
    make_image(folder / "a.jpg")
    make_image(folder / "b.jpg")
    bad = {"images": [{"id": 1}], "annotations": [{"bbox": [1, 1, 5, 5], "category_id": 1}],
           "categories": [{"id": 1, "name": "cat"}]}
    (folder / "a.json").write_text(json.dumps(bad).replace("[1, 1, 5, 5]", f"[{HUGE_INT}, 1, 5, 5]"))
    (folder / "b.json").write_text("[" * 100_000)
    project = create_project(folder, label_format="coco", classes=["cat"])
    pid = project["id"]
    items = images_of(admin, pid)
    assert len(items) == 2
    for item in items:
        response = admin.get(f"/api/projects/{pid}/images/{item['id']}/annotation")
        assert response.status_code == 200 and response.json()["readonly_reason"]
    export = admin.get(f"/api/projects/{pid}/export", params={"format": "coco"})
    assert export.status_code == 200
    assert "annotations.json" in zipfile.ZipFile(io.BytesIO(export.content)).namelist()


def test_indexing_isolates_a_file_that_raises(admin, create_project, root, monkeypatch):
    import annotamate.server.services.indexing as indexing

    real = indexing.parse_label

    def flaky(fmt, data, *args, **kwargs):
        if b"boom" in data:
            raise RuntimeError("parser bug")
        return real(fmt, data, *args, **kwargs)

    monkeypatch.setattr(indexing, "parse_label", flaky)
    folder = root / "iso"
    for name in ("a", "b"):
        make_image(folder / f"{name}.jpg")
    (folder / "a.txt").write_text("boom\n")
    (folder / "b.txt").write_text("0 0.5 0.5 0.1 0.1\n")
    project = create_project(folder, classes=["cat"])
    items = {i["rel_path"]: i for i in images_of(admin, project["id"])}
    assert set(items) == {"a.jpg", "b.jpg"}
    assert items["a.jpg"]["box_count"] == 0 and items["b.jpg"]["box_count"] == 1


# ---- finding 3 and 4: VOC nesting and DOCTYPE in any encoding ----------

def test_voc_deep_nesting_is_readonly_and_saves_do_not_recurse():
    deep = VOC_HEAD + b"<x>" * 5000 + b"</x>" * 5000 + b"</annotation>"
    result = parse_label("voc", deep)
    assert result.readonly_reason and "deeply" in result.readonly_reason
    assert relabel("voc", deep, name_map={"cat": "dog"}) == (deep, 0)
    out = serialize_label("voc", [], IMAGE, [], original=deep)  # falls back to a fresh document
    assert parse_label("voc", out).readonly_reason is None
    ok = voc_doc("<a>" * 30 + "</a>" * 30)
    assert parse_label("voc", ok).readonly_reason is None
    assert voc_format.MAX_DEPTH == 64


ENTITY_DOC = '<?xml version="1.0" encoding="{enc}"?><!DOCTYPE a [<!ENTITY e "boom">]><annotation>&e;</annotation>'


@pytest.mark.parametrize("encoding", ["utf-16", "utf-16-le", "utf-16-be", "utf-8"])
def test_voc_rejects_doctype_in_any_encoding(encoding):
    data = ENTITY_DOC.format(enc=encoding.replace("-le", "").replace("-be", "")).encode(encoding)
    result = parse_label("voc", data)
    assert result.readonly_reason and "DTD" in result.readonly_reason
    assert relabel("voc", data, name_map={"a": "b"}) == (data, 0)


def test_voc_utf16_without_doctype_still_parses():
    data = voc_doc().decode().join(['<?xml version="1.0" encoding="utf-16"?>', ""]).encode("utf-16")
    result = parse_label("voc", data)
    assert result.readonly_reason is None and [b.label for b in result.boxes] == ["cat"]


# ---- finding 5: image content must match the allow-list ----------

def encoded(fmt: str, **kwargs) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), "red").save(buf, fmt, **kwargs)
    return buf.getvalue()


@pytest.mark.parametrize("fmt", ["PPM", "TGA", "ICO", "PCX", "SGI", "DDS", "ICNS", "EPS"])
def test_other_formats_named_png_are_not_images(tmp_path, fmt):
    path = tmp_path / "x.png"
    try:
        path.write_bytes(encoded(fmt))
    except (OSError, KeyError, ValueError):
        pytest.skip(f"Pillow cannot write {fmt} here")
    with pytest.raises(ImageError):
        probe(str(path))


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "BMP", "WEBP", "TIFF"])
def test_allowed_formats_open_under_any_allowed_extension(tmp_path, fmt):
    path = tmp_path / "x.png"
    path.write_bytes(encoded(fmt))
    assert probe(str(path)).format == fmt


def test_upload_refuses_other_formats(admin, create_project, root):
    folder = root / "upl"
    make_image(folder / "x.png")
    pid = create_project(folder)["id"]
    files = [("files[]", ("good.png", encoded("PNG"), "image/png")),
             ("files[]", ("ico.png", encoded("ICO"), "image/png")),
             ("files[]", ("ppm.jpg", encoded("PPM"), "image/jpeg"))]
    response = admin.post(f"/api/projects/{pid}/upload", files=files)
    assert response.status_code == 200, response.text
    assert sorted(s["filename"] for s in response.json()["skipped"]) == ["ico.png", "ppm.jpg"]
    assert (folder / "good.png").exists() and not (folder / "ico.png").exists()


# ---- finding 6: thumbnail sizes ----------

def test_thumbnail_sizes_are_snapped(admin, create_project, root, monkeypatch):
    import annotamate.server.routes.images as routes

    seen: list[int] = []
    real = routes.make_thumbnail

    def spy(path, size, mode):
        seen.append(size)
        return real(path, size, mode)

    monkeypatch.setattr(routes, "make_thumbnail", spy)
    folder = root / "thumbs"
    make_image(folder / "a.jpg", (600, 400))
    pid = create_project(folder)["id"]
    image = images_of(admin, pid)[0]["id"]
    for requested in (64, 100, 128, 129, 256, 300, 512):
        assert admin.get(f"/api/projects/{pid}/images/{image}/thumb", params={"size": requested}).status_code == 200
    assert sorted(set(seen)) == [128, 256, 512]
    assert admin.get(f"/api/projects/{pid}/images/{image}/thumb", params={"size": 513}).status_code == 422


# ---- finding 7 and 9: export ----------

@pytest.mark.parametrize(("name", "safe"), [
    ("a.jpg", True), ("sub/dir/a.jpg", True), ("..\\..\\x.jpg", False), ("a\\b.jpg", False),
    ("../x.jpg", False), ("a/../x.jpg", False), ("a/./x.jpg", False), ("/abs.jpg", False), ("C:x.jpg", False),
    ("a\x01b.jpg", False), ("a\nb.jpg", False), ("a\x7fb.jpg", False), ("a//b.jpg", False), ("", False),
])
def test_safe_entry_name(name, safe):
    assert export_service.safe_entry_name(name) is safe


def test_export_streams_images_in_chunks_and_survives_bad_items(admin, create_project, root, monkeypatch):
    monkeypatch.setattr(export_service, "CHUNK", 64)
    folder = root / "exp"
    for name in ("a", "b", "c"):
        make_image(folder / f"{name}.jpg", (100, 50))
    project = create_project(folder, classes=["cat"])
    pid = project["id"]
    items = {i["rel_path"]: i for i in images_of(admin, pid)}
    for name in ("a", "b", "c"):
        admin.put(f"/api/projects/{pid}/images/{items[name + '.jpg']['id']}/annotation",
                  json={"base_version": None, "boxes": [box(project["classes"][0]["id"], 1, 1, 20, 20)]})
    (folder / "b.jpg").unlink()  # vanishes after indexing
    (folder / "c.txt").write_text("this is not a label\n")  # damaged label file
    response = admin.get(f"/api/projects/{pid}/export", params={"format": "voc", "include_images": "true"})
    assert response.status_code == 200, response.text
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert archive.testzip() is None
    names = set(archive.namelist())
    assert {"images/a.jpg", "images/c.jpg", "Annotations/a.xml"} <= names and "images/b.jpg" not in names
    assert archive.read("images/a.jpg") == (folder / "a.jpg").read_bytes()
    assert archive.getinfo("images/a.jpg").compress_type == zipfile.ZIP_STORED


def test_export_item_error_does_not_truncate_archive(admin, create_project, root, monkeypatch):
    folder = root / "exp2"
    for name in ("a", "b"):
        make_image(folder / f"{name}.jpg", (100, 50))
    project = create_project(folder, classes=["cat"])
    pid = project["id"]
    for item in images_of(admin, pid):
        admin.put(f"/api/projects/{pid}/images/{item['id']}/annotation",
                  json={"base_version": None, "boxes": [box(project["classes"][0]["id"], 1, 1, 20, 20)]})
    real = export_service.Exporter._add_label

    def flaky(self, zf, coco, item):
        if item.rel_path == "a.jpg":
            raise RuntimeError("boom")
        return real(self, zf, coco, item)

    monkeypatch.setattr(export_service.Exporter, "_add_label", flaky)
    response = admin.get(f"/api/projects/{pid}/export", params={"format": "yolo"})
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert set(archive.namelist()) == {"labels/b.txt", "classes.txt", "data.yaml"}


# ---- finding 8: junctions ----------

def test_scan_skips_junctions(tmp_path, monkeypatch):
    root = tmp_path / "root"
    make_image(root / "ok" / "a.jpg")
    make_image(root / "junction" / "secret.jpg")
    real = scanning._is_junction
    monkeypatch.setattr(scanning, "_is_junction", lambda p: Path(p).name == "junction" or real(p))
    assert scanning.scan_images(str(root), recursive=True) == ["ok/a.jpg"]


def test_scan_skips_folders_resolving_outside_root(tmp_path, monkeypatch):
    root = tmp_path / "root"
    make_image(root / "ok" / "a.jpg")
    make_image(root / "odd" / "b.jpg")
    real = scanning._inside
    monkeypatch.setattr(scanning, "_inside", lambda r, p: Path(p).name != "odd" and real(r, p))
    assert scanning.scan_images(str(root), recursive=True) == ["ok/a.jpg"]


# ---- finding 10: file names ----------

BIDI = chr(0x202E)


@pytest.mark.parametrize(("name", "expected"), [
    ("COM" + chr(0xB9) + ".png", "_COM" + chr(0xB9) + ".png"),
    ("lpt" + chr(0xB2) + ".txt", "_lpt" + chr(0xB2) + ".txt"),
    ("COM" + chr(0xB3), "_COM" + chr(0xB3)),
    ("CONIN$.png", "_CONIN$.png"),
    ("con .png", "_con .png"),
    ("con...png", "_con...png"),
    ("nul  .txt", "_nul  .txt"),
    ("photo" + BIDI + "gpj.png", "photogpj.png"),
    ("a" + chr(0x200B) + "b" + chr(0xFEFF) + ".jpg", "ab.jpg"),
    ("a" + chr(0x85) + "b.jpg", "a_b.jpg"),
    ("fam" + chr(0x200D) + "ily" + chr(0x200C) + ".jpg", "fam" + chr(0x200D) + "ily" + chr(0x200C) + ".jpg"),
    ("console.png", "console.png"),
])
def test_sanitize_filename_edge_cases(name, expected):
    assert sanitize_filename(name) == expected
