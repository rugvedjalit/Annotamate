"""Label formats (YOLO, Pascal VOC, per-image COCO), classes.txt and box geometry."""

from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.dom import minidom

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from annotamate.core import boxes as geometry
from annotamate.core.boxes import Box
from annotamate.core.classes import PALETTE, next_color, palette_color, parse_classes, read_classes, write_classes
from annotamate.core.formats import (
    ImageContext,
    LabelFormatError,
    coco,
    parse_label,
    relabel,
    serialize_label,
    voc,
    yolo,
)

IMAGE = ImageContext(width=200, height=100, depth=3, filename="img.jpg", folder="ds", path="/data/ds/img.jpg")


def coords(b: Box) -> tuple[float, float, float, float]:
    return (b.x1, b.y1, b.x2, b.y2)


def assert_close(actual: Box, expected: Box, tol: float = 1e-3) -> None:
    for a, e in zip(coords(actual), coords(expected), strict=True):
        assert math.isclose(a, e, abs_tol=tol), (coords(actual), coords(expected))


# ------------------------------------------------------------------------------------------- strategies

NAMES = st.text(alphabet="abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789 _-", min_size=1, max_size=20).map(
    str.strip).filter(bool)


@st.composite
def image_and_boxes(draw, *, integer: bool = False, labels=None):
    width = draw(st.integers(10, 2000))
    height = draw(st.integers(10, 2000))
    out = []
    for _ in range(draw(st.integers(0, 8))):
        if integer:
            x1 = draw(st.integers(0, width - 1))
            x2 = draw(st.integers(x1 + 1, width))
            y1 = draw(st.integers(0, height - 1))
            y2 = draw(st.integers(y1 + 1, height))
        else:
            a, b = sorted((draw(st.floats(0, 1)), draw(st.floats(0, 1))))
            c, d = sorted((draw(st.floats(0, 1)), draw(st.floats(0, 1))))
            x1, x2, y1, y2 = a * width, b * width, c * height, d * height
            if x2 - x1 < 1 or y2 - y1 < 1:
                continue
        label = draw(labels) if labels is not None else str(draw(st.integers(0, 50)))
        out.append(Box(float(x1), float(y1), float(x2), float(y2), label))
    return ImageContext(width, height, 3, "img.jpg", "ds", "/ds/img.jpg"), out


# ------------------------------------------------------------------------------------------- YOLO


class TestYolo:
    def test_round_trip(self):
        boxes = [Box(20, 10, 60, 50, "0"), Box(0, 0, 200, 100, "3")]
        text = yolo.dump(boxes, IMAGE)
        assert text == "0 0.200000 0.300000 0.200000 0.400000\n3 0.500000 0.500000 1.000000 1.000000\n"
        parsed = yolo.parse(text, IMAGE.width, IMAGE.height)
        assert parsed.readonly_reason is None
        assert [b.label for b in parsed.boxes] == ["0", "3"]
        for got, want in zip(parsed.boxes, boxes, strict=True):
            assert_close(got, want)

    @settings(max_examples=50, deadline=None)
    @given(image_and_boxes())
    def test_round_trip_property(self, case):
        image, boxes = case
        parsed = yolo.parse(yolo.dump(boxes, image), image.width, image.height)
        assert parsed.readonly_reason is None
        assert [b.label for b in parsed.boxes] == [b.label for b in boxes]
        tol = max(image.width, image.height) * 2e-6
        for got, want in zip(parsed.boxes, boxes, strict=True):
            assert_close(got, want, tol)

    def test_desktop_app_file(self):
        # Exactly what the legacy Tk app writes: f"{cid} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n"
        w, h = 640, 480
        lines = []
        for cid, (x1, y1, x2, y2) in [(0, (10, 20, 110, 220)), (2, (300.5, 100.25, 640, 480))]:
            bw, bh = x2 - x1, y2 - y1
            cx, cy = x1 + bw / 2, y1 + bh / 2
            lines.append(f"{cid} {cx / w:.6f} {cy / h:.6f} {bw / w:.6f} {bh / h:.6f}\n")
        parsed = yolo.parse("".join(lines), w, h)
        assert parsed.readonly_reason is None
        assert [b.label for b in parsed.boxes] == ["0", "2"]
        assert_close(parsed.boxes[0], Box(10, 20, 110, 220, "0"), 0.01)
        assert_close(parsed.boxes[1], Box(300.5, 100.25, 640, 480, "2"), 0.01)

    def test_normalised_parse_without_size(self):
        parsed = yolo.parse("1 0.5 0.5 0.2 0.4\n")
        assert_close(parsed.boxes[0], Box(0.4, 0.3, 0.6, 0.7, "1"), 1e-9)

    def test_unknown_index_kept_as_label(self):
        parsed = yolo.parse("17 0.5 0.5 0.1 0.1\n", 100, 100)
        assert parsed.boxes[0].label == "17"

    def test_float_class_index_accepted(self):
        assert yolo.parse("1.0 0.5 0.5 0.1 0.1\n").boxes[0].label == "1"

    def test_blank_lines_ignored(self):
        parsed = yolo.parse("\n0 0.5 0.5 0.1 0.1\n\n   \n")
        assert parsed.readonly_reason is None
        assert len(parsed.boxes) == 1

    def test_segmentation_line_is_readonly_with_bounding_rect(self):
        parsed = yolo.parse("0 0.1 0.2 0.5 0.2 0.5 0.6 0.1 0.6\n0 0.5 0.5 0.2 0.2\n", 100, 100)
        assert parsed.readonly_reason == yolo.READONLY_EXTRA_COLUMNS
        assert len(parsed.boxes) == 2
        assert_close(parsed.boxes[0], Box(10, 20, 50, 60, "0"))

    def test_obb_line_is_readonly(self):
        parsed = yolo.parse("3 0.1 0.1 0.9 0.1 0.9 0.9 0.1 0.9\n", 10, 10)
        assert parsed.readonly_reason is not None
        assert_close(parsed.boxes[0], Box(1, 1, 9, 9, "3"))

    def test_six_values_is_readonly(self):
        parsed = yolo.parse("0 0.5 0.5 0.2 0.2 0.93\n", 100, 100)
        assert parsed.readonly_reason is not None
        assert_close(parsed.boxes[0], Box(40, 40, 60, 60, "0"))

    @pytest.mark.parametrize("line", [
        "0 0.5 0.5",                 # too few values
        "car 0.5 0.5 0.2 0.2",       # non-numeric class
        "0 0.5 abc 0.2 0.2",         # bad float
        "0 nan 0.5 0.2 0.2",         # NaN
        "0 0.5 inf 0.2 0.2",         # infinity
        "-1 0.5 0.5 0.2 0.2",        # negative class
        "1.5 0.5 0.5 0.2 0.2",       # fractional class
    ])
    def test_malformed_lines_make_file_readonly(self, line):
        parsed = yolo.parse(f"0 0.5 0.5 0.2 0.2\n{line}\n", 100, 100)
        assert parsed.readonly_reason is not None
        assert "Line 2" in parsed.readonly_reason
        assert len(parsed.boxes) == 1  # the good line is still shown

    def test_invalid_utf8_is_readonly(self):
        parsed = parse_label("yolo", b"\xff\xfe\x00garbage")
        assert parsed.readonly_reason is not None
        assert parsed.boxes == []

    def test_bom_is_tolerated(self):
        parsed = parse_label("yolo", "﻿0 0.5 0.5 0.2 0.2\n".encode())
        assert parsed.readonly_reason is None
        assert parsed.boxes[0].label == "0"

    def test_dump_clamps_to_image(self):
        text = yolo.dump([Box(-10, -10, 100, 60, "0")], ImageContext(100, 50))
        assert text == "0 0.500000 0.500000 1.000000 1.000000\n"

    def test_dump_skips_boxes_outside_image(self):
        assert yolo.dump([Box(150, 10, 180, 20, "0")], ImageContext(100, 50)) == ""

    def test_dump_empty_list_is_background_file(self):
        assert yolo.dump([], IMAGE) == ""

    def test_dump_rejects_names(self):
        with pytest.raises(LabelFormatError):
            yolo.dump([Box(0, 0, 10, 10, "car")], IMAGE)

    def test_dump_requires_size(self):
        with pytest.raises(LabelFormatError):
            yolo.dump([Box(0, 0, 10, 10, "0")], ImageContext(0, 0))

    def test_relabel_keeps_everything_else(self):
        text = ("0 0.1 0.1 0.1 0.1\n"
                "# comment line\n"
                "1 0.2 0.2 0.2 0.2\n"
                "  2 0.300000 0.3 0.3 0.3\n"
                "bad line\n"
                "2 0.1 0.1 0.2 0.1 0.2 0.2\n")
        new, changed = yolo.relabel(text, {0: None, 2: 1})
        assert changed == 3
        assert new == ("# comment line\n"
                       "1 0.2 0.2 0.2 0.2\n"
                       "  1 0.300000 0.3 0.3 0.3\n"
                       "bad line\n"
                       "1 0.1 0.1 0.2 0.1 0.2 0.2\n")

    def test_relabel_without_matches_is_unchanged(self):
        data = b"0 0.5 0.5 0.1 0.1\r\n1 0.5 0.5 0.1 0.1\r\n"
        assert relabel("yolo", data, index_map={5: 4}) == (data, 0)

    def test_relabel_dispatch_returns_bytes(self):
        new, changed = relabel("yolo", b"3 0.5 0.5 0.1 0.1\n", index_map={3: 2})
        assert (new, changed) == (b"2 0.5 0.5 0.1 0.1\n", 1)


# ------------------------------------------------------------------------------------------- Pascal VOC


def desktop_voc(boxes: list[tuple[str, int, int, int, int]], w: int = 640, h: int = 480) -> bytes:
    """The legacy desktop app's VOC writer, reproduced."""
    root = ET.Element("annotation")
    ET.SubElement(root, "folder").text = "images"
    ET.SubElement(root, "filename").text = "img.jpg"
    ET.SubElement(root, "path").text = "/data/images/img.jpg"
    source = ET.SubElement(root, "source")
    ET.SubElement(source, "database").text = "Unknown"
    size = ET.SubElement(root, "size")
    ET.SubElement(size, "width").text = str(w)
    ET.SubElement(size, "height").text = str(h)
    ET.SubElement(size, "depth").text = "3"
    ET.SubElement(root, "segmented").text = "0"
    for name, x1, y1, x2, y2 in boxes:
        obj = ET.SubElement(root, "object")
        ET.SubElement(obj, "name").text = name
        ET.SubElement(obj, "pose").text = "Unspecified"
        ET.SubElement(obj, "truncated").text = "0"
        ET.SubElement(obj, "difficult").text = "0"
        bndbox = ET.SubElement(obj, "bndbox")
        ET.SubElement(bndbox, "xmin").text = str(int(x1))
        ET.SubElement(bndbox, "ymin").text = str(int(y1))
        ET.SubElement(bndbox, "xmax").text = str(int(x2))
        ET.SubElement(bndbox, "ymax").text = str(int(y2))
    return minidom.parseString(ET.tostring(root)).toprettyxml(indent="   ").encode()  # noqa: S318 - test data


class TestVoc:
    def test_round_trip(self):
        boxes = [Box(10, 20, 50, 60, "car"), Box(0, 0, 200, 100, "person", difficult=True, truncated=True)]
        parsed = voc.parse(voc.dump(boxes, IMAGE))
        assert parsed.readonly_reason is None
        assert parsed.boxes == boxes

    @settings(max_examples=50, deadline=None)
    @given(image_and_boxes(integer=True, labels=NAMES))
    def test_round_trip_property(self, case):
        image, boxes = case
        parsed = voc.parse(voc.dump(boxes, image))
        assert parsed.readonly_reason is None
        assert parsed.boxes == boxes

    def test_desktop_app_file(self):
        parsed = voc.parse(desktop_voc([("car", 10, 20, 110, 220), ("unknown thing", 0, 0, 640, 480)]))
        assert parsed.readonly_reason is None
        assert parsed.boxes == [Box(10, 20, 110, 220, "car"), Box(0, 0, 640, 480, "unknown thing")]

    def test_real_depth_and_metadata_written(self):
        data = voc.dump([Box(1, 2, 3, 4, "a")], ImageContext(10, 20, 1, "x.png", "folder", "/p/x.png"))
        root = ET.fromstring(data)
        assert root.findtext("size/depth") == "1"
        assert root.findtext("size/width") == "10"
        assert root.findtext("size/height") == "20"
        assert root.findtext("filename") == "x.png"
        assert root.findtext("folder") == "folder"
        assert root.findtext("path") == "/p/x.png"
        assert data.startswith(b"<?xml")

    def test_half_up_rounding(self):
        assert [voc.to_pixel(v) for v in (0.4, 0.5, 1.5, 2.5, 2.49, -0.2)] == [0, 1, 2, 3, 2, 0]
        parsed = voc.parse(voc.dump([Box(1.5, 2.5, 10.5, 11.49, "a")], IMAGE))
        assert coords(parsed.boxes[0]) == (2, 3, 11, 11)

    def test_dump_clamps(self):
        parsed = voc.parse(voc.dump([Box(-5, -5, 500, 500, "a")], IMAGE))
        assert coords(parsed.boxes[0]) == (0, 0, 200, 100)

    def test_flags_parse_variants(self):
        data = b"""<annotation><object><name>a</name><difficult>1</difficult><truncated>true</truncated>
            <bndbox><xmin>1</xmin><ymin>2</ymin><xmax>3.5</xmax><ymax>4</ymax></bndbox></object></annotation>"""
        parsed = voc.parse(data)
        assert parsed.boxes == [Box(1, 2, 3.5, 4, "a", difficult=True, truncated=True)]

    @pytest.mark.parametrize("data", [
        b"<annotation><object>",                                    # truncated XML
        b"not xml at all",
        b"<foo/>",                                                  # wrong root
        b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><annotation/>',  # DTD
        b"<annotation><object><name>a</name></object></annotation>",  # no bndbox
        b"<annotation><object><name>a</name><bndbox><xmin>x</xmin><ymin>0</ymin><xmax>1</xmax><ymax>1</ymax>"
        b"</bndbox></object></annotation>",                         # bad number
    ])
    def test_bad_files_are_readonly(self, data):
        assert voc.parse(data).readonly_reason is not None

    def test_entity_expansion_rejected(self):
        bomb = (b'<?xml version="1.0"?><!DOCTYPE a [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>'
                b"<annotation><object><name>&b;</name></object></annotation>")
        parsed = voc.parse(bomb)
        assert parsed.readonly_reason is not None
        assert parsed.boxes == []

    def test_polygon_object_is_readonly_but_shown(self):
        data = b"""<annotation><object><name>a</name><polygon><x1>1</x1></polygon>
            <bndbox><xmin>1</xmin><ymin>2</ymin><xmax>3</xmax><ymax>4</ymax></bndbox></object></annotation>"""
        parsed = voc.parse(data)
        assert parsed.readonly_reason is not None
        assert len(parsed.boxes) == 1

    def test_empty_annotation(self):
        parsed = voc.parse(voc.dump([], IMAGE))
        assert parsed.readonly_reason is None
        assert parsed.boxes == []

    def test_relabel_keeps_other_tags(self):
        data = b"""<?xml version="1.0"?>
<annotation><folder>f</folder>
  <object><name>car</name><pose>Frontal</pose><occluded>1</occluded>
    <bndbox><xmin>1</xmin><ymin>2</ymin><xmax>3</xmax><ymax>4</ymax></bndbox></object>
  <object><name>dog</name><pose>Left</pose>
    <bndbox><xmin>5</xmin><ymin>6</ymin><xmax>7</xmax><ymax>8</ymax></bndbox></object>
  <object><name>cat</name><bndbox><xmin>1</xmin><ymin>1</ymin><xmax>2</xmax><ymax>2</ymax></bndbox></object>
</annotation>"""
        new, changed = voc.relabel(data, {"car": "auto", "cat": None})
        assert changed == 2
        root = ET.fromstring(new)
        objects = root.findall("object")
        assert [o.findtext("name") for o in objects] == ["auto", "dog"]
        assert objects[0].findtext("pose") == "Frontal"
        assert objects[0].findtext("occluded") == "1"
        assert objects[1].findtext("pose") == "Left"
        assert root.findtext("folder") == "f"

    def test_relabel_unchanged_and_unparsable(self):
        data = desktop_voc([("car", 1, 1, 5, 5)])
        assert voc.relabel(data, {"dog": None}) == (data, 0)
        assert voc.relabel(b"<broken", {"car": None}) == (b"<broken", 0)


# ------------------------------------------------------------------------------------------- COCO (per image)


def desktop_coco(boxes: list[tuple[int, float, float, float, float]], classes: list[str]) -> bytes:
    """The legacy desktop app's per-image COCO writer, reproduced (class ids are 0-based there)."""
    data = {
        "images": [{"id": 1, "width": 640, "height": 480, "file_name": "img.jpg"}],
        "annotations": [
            {"id": i + 1, "image_id": 1, "category_id": cid + 1, "segmentation": [], "area": (x2 - x1) * (y2 - y1),
             "bbox": [x1, y1, x2 - x1, y2 - y1], "iscrowd": 0}
            for i, (cid, x1, y1, x2, y2) in enumerate(boxes)
        ],
        "categories": [{"id": i + 1, "name": n, "supercategory": "none"} for i, n in enumerate(classes)],
    }
    return json.dumps(data, indent=4).encode()


class TestCoco:
    def test_round_trip(self):
        boxes = [Box(10.5, 20.25, 50, 60, "car"), Box(0, 0, 200, 100, "truck")]
        data = coco.dump(boxes, IMAGE, ["person", "car"])
        doc = json.loads(data)
        assert doc["images"] == [{"id": 1, "width": 200, "height": 100, "file_name": "img.jpg"}]
        assert [c["name"] for c in doc["categories"]] == ["person", "car", "truck"]
        assert [a["category_id"] for a in doc["annotations"]] == [2, 3]
        assert doc["annotations"][0]["bbox"] == [10.5, 20.25, 39.5, 39.75]
        parsed = coco.parse(data)
        assert parsed.readonly_reason is None
        assert parsed.categories == ["person", "car", "truck"]
        for got, want in zip(parsed.boxes, boxes, strict=True):
            assert got.label == want.label
            assert_close(got, want)

    @settings(max_examples=50, deadline=None)
    @given(image_and_boxes(labels=NAMES), st.lists(NAMES, max_size=5, unique=True))
    def test_round_trip_property(self, case, class_names):
        image, boxes = case
        parsed = coco.parse(coco.dump(boxes, image, class_names))
        assert parsed.readonly_reason is None
        assert [b.label for b in parsed.boxes] == [b.label for b in boxes]
        for got, want in zip(parsed.boxes, boxes, strict=True):
            assert_close(got, want, 2e-3)

    def test_desktop_app_file(self):
        parsed = coco.parse(desktop_coco([(0, 10, 20, 110, 220), (1, 1.5, 2.5, 3.5, 4.5)], ["person", "car"]))
        assert parsed.readonly_reason is None
        assert [b.label for b in parsed.boxes] == ["person", "car"]
        assert_close(parsed.boxes[0], Box(10, 20, 110, 220, "person"))
        assert_close(parsed.boxes[1], Box(1.5, 2.5, 3.5, 4.5, "car"))

    def test_missing_category_kept_as_id(self):
        data = json.dumps({"images": [], "categories": [{"id": 1, "name": "a"}],
                           "annotations": [{"bbox": [0, 0, 5, 5], "category_id": 9}]}).encode()
        assert coco.parse(data).boxes[0].label == "9"

    @pytest.mark.parametrize("data", [
        b"{not json",
        b"[1, 2, 3]",
        b"\xff\xfe",
        json.dumps({"annotations": [{"bbox": [0, 0, 1], "category_id": 1}]}).encode(),          # short bbox
        json.dumps({"annotations": [{"bbox": ["a", 0, 1, 1], "category_id": 1}]}).encode(),     # bad number
        json.dumps({"annotations": [{"bbox": [0, 0, 5, 5], "category_id": 1,
                                     "segmentation": [[0, 0, 5, 0, 5, 5]]}],
                    "categories": [{"id": 1, "name": "a"}]}).encode(),                         # polygons
        json.dumps({"images": [{"id": 1}, {"id": 2}], "annotations": []}).encode(),             # several images
    ])
    def test_problem_files_are_readonly(self, data):
        assert coco.parse(data).readonly_reason is not None

    def test_empty_segmentation_is_editable(self):
        data = json.dumps({"annotations": [{"bbox": [0, 0, 5, 5], "category_id": 1, "segmentation": []}],
                           "categories": [{"id": 1, "name": "a"}]}).encode()
        assert coco.parse(data).readonly_reason is None

    def test_relabel_renumbers_and_keeps_fields(self):
        data = json.dumps({
            "images": [{"id": 1, "width": 10, "height": 10, "file_name": "a.jpg"}],
            "annotations": [
                {"id": 1, "category_id": 1, "bbox": [0, 0, 1, 1], "attributes": {"occluded": True}},
                {"id": 2, "category_id": 2, "bbox": [1, 1, 1, 1], "score": 0.5},
            ],
            "categories": [{"id": 1, "name": "car"}, {"id": 2, "name": "dog"}],
            "info": {"note": "kept"},
        }).encode()
        new, changed = coco.relabel(data, {"car": None}, ["dog"])
        assert changed == 1
        doc = json.loads(new)
        assert doc["categories"] == [{"id": 1, "name": "dog", "supercategory": "none"}]
        assert doc["annotations"] == [{"id": 2, "category_id": 1, "bbox": [1, 1, 1, 1], "score": 0.5}]
        assert doc["info"] == {"note": "kept"}

        merged, changed = coco.relabel(data, {"car": "dog"}, ["dog"])
        doc = json.loads(merged)
        assert changed == 1
        assert [a["category_id"] for a in doc["annotations"]] == [1, 1]
        assert doc["annotations"][0]["attributes"] == {"occluded": True}

    def test_relabel_unchanged_and_invalid(self):
        data = desktop_coco([(0, 1, 1, 5, 5)], ["car"])
        assert coco.relabel(data, {"dog": None}, ["car"]) == (data, 0)
        assert coco.relabel(b"{bad", {"car": None}, []) == (b"{bad", 0)


# ------------------------------------------------------------------------------------------- dispatch


def test_dispatch_unknown_format():
    with pytest.raises(ValueError, match="unknown label format"):
        parse_label("kitti", b"")
    with pytest.raises(ValueError, match="unknown label format"):
        serialize_label("kitti", [], IMAGE, [])
    with pytest.raises(ValueError, match="unknown label format"):
        relabel("kitti", b"")


@pytest.mark.parametrize("fmt", ["yolo", "voc", "coco"])
def test_serialize_parse_dispatch(fmt):
    label = "0" if fmt == "yolo" else "person"
    data = serialize_label(fmt, [Box(10, 10, 40, 30, label)], IMAGE, ["person"])
    parsed = parse_label(fmt, data, IMAGE.width, IMAGE.height)
    assert parsed.readonly_reason is None
    assert [b.label for b in parsed.boxes] == [label]
    assert_close(parsed.boxes[0], Box(10, 10, 40, 30, label))


# ------------------------------------------------------------------------------------------- classes.txt


def test_classes_file_round_trip(tmp_path: Path):
    path = tmp_path / "labels" / "classes.txt"
    write_classes(str(path), ["person", "car", "traffic light"])
    assert path.read_bytes() == b"person\ncar\ntraffic light\n"
    assert read_classes(str(path)) == ["person", "car", "traffic light"]


def test_classes_file_bom_and_blank_lines(tmp_path: Path):
    path = tmp_path / "classes.txt"
    path.write_bytes("﻿cat\r\n\r\n  dog  \n\n".encode())
    assert read_classes(str(path)) == ["cat", "dog"]


def test_classes_file_missing_or_undecodable(tmp_path: Path):
    assert read_classes(str(tmp_path / "nope.txt")) is None
    bad = tmp_path / "bad.txt"
    bad.write_bytes(b"\xff\xfe\xfa")
    assert read_classes(str(bad)) is None


def test_parse_classes():
    assert parse_classes("a\n\n b \n") == ["a", "b"]


def test_palette():
    assert len(PALETTE) == 20
    assert len(set(PALETTE)) == 20
    assert palette_color(0) == PALETTE[0]
    assert palette_color(21) == PALETTE[1]
    assert next_color([]) == PALETTE[0]
    assert next_color([PALETTE[0].upper()]) == PALETTE[1]
    assert next_color(list(PALETTE)) in PALETTE


# ------------------------------------------------------------------------------------------- geometry


def test_normalize_swaps_corners():
    assert coords(geometry.normalize(Box(10, 20, 5, 2, "a"))) == (5, 2, 10, 20)
    box = Box(1, 2, 3, 4, "a")
    assert geometry.normalize(box) is box


def test_clamp():
    assert coords(geometry.clamp(Box(-5, 30, 120, -1, "a"), 100, 50)) == (0, 0, 100, 30)


def test_sanitize_drops_small_and_non_finite():
    kept = geometry.sanitize([
        Box(0, 0, 0.5, 10, "small"),
        Box(0, 0, 1, 1, "exactly one pixel"),
        Box(float("nan"), 0, 10, 10, "nan"),
        Box(0, 0, float("inf"), 10, "inf"),
        Box(90, 40, 200, 200, "clamped"),
        Box(150, 10, 180, 20, "outside"),
    ], 100, 50)
    assert [b.label for b in kept] == ["exactly one pixel", "clamped"]
    assert coords(kept[1]) == (90, 40, 100, 50)


def test_box_size():
    b = Box(1, 2, 4, 8, "a")
    assert (b.width, b.height) == (3, 6)
