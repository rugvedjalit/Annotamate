"""COCO labels stored as one JSON document per image (the desktop app's layout).

Each file looks like ``{"images": [one image], "annotations": [...], "categories": [...]}`` with
1-based category ids that follow the project's class order. Dataset-level export lives in the server.
"""

from __future__ import annotations

import json
import math
from typing import Any

from annotamate.core.boxes import Box, clamp
from annotamate.core.formats.base import ImageContext, ParseResult

EXTENSION = ".json"


def _round(value: float) -> float:
    rounded = round(value, 3)
    return int(rounded) if float(rounded).is_integer() else rounded


def _load(data: bytes) -> dict[str, Any]:
    doc = json.loads(data.decode("utf-8-sig"))
    if not isinstance(doc, dict):
        raise ValueError("top level is not an object")
    return doc


def parse(data: bytes) -> ParseResult:
    """Parse a per-image COCO file. Segmentations or several images make it read-only."""
    result = ParseResult()
    try:
        doc = _load(data)
    except (ValueError, UnicodeDecodeError) as exc:
        result.readonly_reason = f"The label file is not valid JSON ({exc})."
        return result
    try:
        categories = sorted(
            (c for c in doc.get("categories") or [] if isinstance(c, dict) and "id" in c),
            key=lambda c: c["id"],
        )
        names = {c["id"]: str(c.get("name", c["id"])) for c in categories}
        result.categories = [names[c["id"]] for c in categories]
        images = doc.get("images") or []
        if len(images) > 1:
            result.readonly_reason = "This COCO file describes several images. Editing is disabled."
        for n, ann in enumerate(doc.get("annotations") or [], start=1):
            try:
                x, y, w, h = (float(v) for v in ann["bbox"])
                if not all(math.isfinite(v) for v in (x, y, w, h)):
                    raise ValueError("non-finite bbox")
                cat = ann.get("category_id")
                label = names.get(cat, str(cat))
            except (KeyError, TypeError, ValueError) as exc:
                result.readonly_reason = result.readonly_reason or f"Annotation {n} cannot be parsed ({exc})."
                continue
            if ann.get("segmentation"):
                result.readonly_reason = result.readonly_reason or (
                    "This label file contains segmentation masks. Editing is disabled so they are not lost."
                )
            result.boxes.append(Box(x, y, x + w, y + h, label))
    except (TypeError, AttributeError, KeyError) as exc:
        result.readonly_reason = f"The label file is not a COCO document ({exc})."
    return result


def _categories(boxes: list[Box], class_names: list[str]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    ids = {name: i + 1 for i, name in enumerate(class_names)}
    for box in boxes:  # unknown labels are kept as extra categories
        ids.setdefault(box.label, len(ids) + 1)
    categories = [{"id": cid, "name": name, "supercategory": "none"} for name, cid in ids.items()]
    return categories, ids


def dump(boxes: list[Box], image: ImageContext, class_names: list[str]) -> bytes:
    """Serialise boxes; category ids are ``index + 1`` in ``class_names``."""
    categories, ids = _categories(boxes, class_names)
    annotations = []
    for box in boxes:
        b = clamp(box, image.width, image.height) if image.width > 0 and image.height > 0 else box
        if b.width <= 0 or b.height <= 0:
            continue
        annotations.append({
            "id": len(annotations) + 1,
            "image_id": 1,
            "category_id": ids[box.label],
            "segmentation": [],
            "area": _round(b.width * b.height),
            "bbox": [_round(b.x1), _round(b.y1), _round(b.width), _round(b.height)],
            "iscrowd": 0,
        })
    doc = {
        "images": [{"id": 1, "width": image.width, "height": image.height, "file_name": image.filename}],
        "annotations": annotations,
        "categories": categories,
    }
    return (json.dumps(doc, indent=4, ensure_ascii=False) + "\n").encode("utf-8")


def relabel(data: bytes, mapping: dict[str, str | None], class_names: list[str]) -> tuple[bytes, int]:
    """Rename or drop annotations by category name and renumber categories after ``class_names``.

    Every other field of the document and of each annotation is preserved. Returns the new bytes
    and the number of annotations changed; unparsable files are returned unchanged.
    """
    try:
        doc = _load(data)
        old_names = {c["id"]: str(c.get("name", c["id"])) for c in doc.get("categories") or []}
        anns = list(doc.get("annotations") or [])
    except (ValueError, UnicodeDecodeError, TypeError, KeyError, AttributeError):
        return data, 0
    changed = 0
    kept: list[tuple[dict[str, Any], str]] = []
    for ann in anns:
        name = old_names.get(ann.get("category_id"), str(ann.get("category_id")))
        if name in mapping:
            changed += 1
            target = mapping[name]
            if target is None:
                continue
            name = target
        kept.append((ann, name))
    if not changed:
        return data, 0
    ids = {name: i + 1 for i, name in enumerate(class_names)}
    for _, name in kept:
        ids.setdefault(name, len(ids) + 1)
    for ann, name in kept:
        ann["category_id"] = ids[name]
    doc["annotations"] = [ann for ann, _ in kept]
    doc["categories"] = [{"id": cid, "name": name, "supercategory": "none"} for name, cid in ids.items()]
    return (json.dumps(doc, indent=4, ensure_ascii=False) + "\n").encode("utf-8"), changed
