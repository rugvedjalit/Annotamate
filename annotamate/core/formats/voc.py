"""Pascal VOC XML labels (integer pixel coordinates, one file per image)."""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET

from annotamate.core.boxes import Box, clamp
from annotamate.core.formats.base import ImageContext, ParseResult

EXTENSION = ".xml"


def _text(element: ET.Element | None, tag: str, default: str = "") -> str:
    if element is None:
        return default
    child = element.find(tag)
    if child is None or child.text is None:
        return default
    return child.text.strip()


def _flag(element: ET.Element, tag: str) -> bool:
    value = _text(element, tag, "0")
    try:
        return float(value) != 0
    except ValueError:
        return value.lower() in ("true", "yes")


def _coord(bndbox: ET.Element, tag: str) -> float:
    value = float(_text(bndbox, tag))
    if not math.isfinite(value):
        raise ValueError(f"{tag} is not finite")
    return value


def _fromstring(data: bytes) -> ET.Element:
    """Parse XML without DTDs: entity declarations are the vector of XML expansion attacks."""
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ET.ParseError("DTDs and entity declarations are not supported")
    return ET.fromstring(data)  # noqa: S314 - DTDs rejected above; expat never fetches external entities


def parse(data: bytes) -> ParseResult:
    """Parse a VOC XML file. Objects without a usable ``bndbox`` make the file read-only."""
    result = ParseResult()
    try:
        root = _fromstring(data)
    except ET.ParseError as exc:
        result.readonly_reason = f"The label file is not valid XML ({exc})."
        return result
    if root.tag != "annotation":
        result.readonly_reason = "The label file is not a Pascal VOC annotation."
        return result
    for n, obj in enumerate(root.findall("object"), start=1):
        name = _text(obj, "name")
        bndbox = obj.find("bndbox")
        try:
            if bndbox is None:
                raise ValueError("no bndbox")
            box = Box(
                _coord(bndbox, "xmin"), _coord(bndbox, "ymin"), _coord(bndbox, "xmax"), _coord(bndbox, "ymax"),
                name, difficult=_flag(obj, "difficult"), truncated=_flag(obj, "truncated"),
            )
        except ValueError as exc:
            result.readonly_reason = result.readonly_reason or f"Object {n} of the label file cannot be parsed ({exc})."
            continue
        if obj.find("polygon") is not None or obj.find("segmentation") is not None:
            result.readonly_reason = result.readonly_reason or (
                "This label file contains polygons. Editing is disabled so they are not lost."
            )
        result.boxes.append(box)
    return result


def to_pixel(value: float) -> int:
    """VOC stores integer pixels; round half up (``round`` would round 2.5 down to 2)."""
    return math.floor(value + 0.5)


def _sub(parent: ET.Element, tag: str, text: str) -> ET.Element:
    element = ET.SubElement(parent, tag)
    element.text = text
    return element


def dump(boxes: list[Box], image: ImageContext) -> bytes:
    """Serialise boxes the way the desktop app does, with the real image depth and rounded pixels."""
    root = ET.Element("annotation")
    _sub(root, "folder", image.folder)
    _sub(root, "filename", image.filename)
    _sub(root, "path", image.path)
    source = ET.SubElement(root, "source")
    _sub(source, "database", "Unknown")
    size = ET.SubElement(root, "size")
    _sub(size, "width", str(image.width))
    _sub(size, "height", str(image.height))
    _sub(size, "depth", str(image.depth))
    _sub(root, "segmented", "0")
    for box in boxes:
        b = clamp(box, image.width, image.height) if image.width > 0 and image.height > 0 else box
        x1, y1, x2, y2 = (to_pixel(v) for v in (b.x1, b.y1, b.x2, b.y2))
        if x2 <= x1 or y2 <= y1:
            continue
        obj = ET.SubElement(root, "object")
        _sub(obj, "name", box.label)
        _sub(obj, "pose", "Unspecified")
        _sub(obj, "truncated", "1" if box.truncated else "0")
        _sub(obj, "difficult", "1" if box.difficult else "0")
        bndbox = ET.SubElement(obj, "bndbox")
        _sub(bndbox, "xmin", str(x1))
        _sub(bndbox, "ymin", str(y1))
        _sub(bndbox, "xmax", str(x2))
        _sub(bndbox, "ymax", str(y2))
    ET.indent(root, space="   ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True) + b"\n"


def relabel(data: bytes, mapping: dict[str, str | None]) -> tuple[bytes, int]:
    """Rename (or, when mapped to ``None``, remove) objects by class name, keeping all other XML as is.

    Returns the new bytes and the number of objects changed. Unparsable files are returned unchanged.
    """
    try:
        root = _fromstring(data)
    except ET.ParseError:
        return data, 0
    changed = 0
    for obj in list(root.findall("object")):
        name_el = obj.find("name")
        name = (name_el.text or "").strip() if name_el is not None else ""
        if name not in mapping:
            continue
        changed += 1
        target = mapping[name]
        if target is None:
            root.remove(obj)
        elif name_el is not None:
            name_el.text = target
    if not changed:
        return data, 0
    ET.indent(root, space="   ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True) + b"\n", changed
