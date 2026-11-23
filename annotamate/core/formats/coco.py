"""COCO labels stored as one JSON document per image (the desktop app's layout).

Each file looks like ``{"images": [one image], "annotations": [...], "categories": [...]}`` with
1-based category ids that follow the project's class order. Dataset-level export lives in the server.
"""

from __future__ import annotations

import copy
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


def _original_document(original: bytes | None) -> dict[str, Any] | None:
    """The parsed original file when it can be patched (one image, plain boxes, one annotation per box)."""
    if original is None:
        return None
    try:
        doc = _load(original)
    except (ValueError, UnicodeDecodeError):
        return None
    parsed = parse(original)
    annotations = doc.get("annotations") or []
    if (parsed.readonly_reason or not isinstance(annotations, list) or len(annotations) != len(parsed.boxes)
            or not all(isinstance(a, dict) for a in annotations)):
        return None
    return doc


def _unchanged(box: Box, before: Box) -> bool:
    return all(abs(a - b) < 0.0005 for a, b in ((box.x1, before.x1), (box.y1, before.y1),
                                                  (box.x2, before.x2), (box.y2, before.y2)))


def _patch(doc: dict[str, Any], boxes: list[Box], image: ImageContext, class_names: list[str],
           origins: list[int | None]) -> dict[str, Any]:
    """Update the original document: unmapped fields, ids and document-level extras are kept."""
    old_annotations: list[dict[str, Any]] = doc.get("annotations") or []
    old_boxes = parse(json.dumps(doc).encode("utf-8")).boxes
    categories = [dict(c) for c in doc.get("categories") or [] if isinstance(c, dict) and "id" in c]
    ids = {str(c.get("name", c["id"])): c["id"] for c in categories}
    next_category = max((c["id"] for c in categories if isinstance(c["id"], int)), default=0) + 1
    for name in [*class_names, *(b.label for b in boxes)]:
        if name not in ids:
            ids[name] = next_category
            categories.append({"id": next_category, "name": name, "supercategory": "none"})
            next_category += 1
    images = doc.get("images")
    first = dict(images[0]) if isinstance(images, list) and images and isinstance(images[0], dict) else {"id": 1}
    first.update(width=image.width, height=image.height, file_name=image.filename)
    image_id = first.get("id", 1)
    used = {a["id"] for a in old_annotations if isinstance(a.get("id"), int)}
    next_id = max(used, default=0) + 1
    annotations: list[dict[str, Any]] = []
    for i, box in enumerate(boxes):
        b = clamp(box, image.width, image.height) if image.width > 0 and image.height > 0 else box
        if b.width <= 0 or b.height <= 0:
            continue
        origin = origins[i] if i < len(origins) else None
        if origin is not None and 0 <= origin < len(old_annotations):
            ann = copy.deepcopy(old_annotations[origin])
            before = old_boxes[origin]
            if not _unchanged(b, before):
                ann["bbox"] = [_round(b.x1), _round(b.y1), _round(b.width), _round(b.height)]
                ann["area"] = _round(b.width * b.height)
            if box.label != before.label:
                ann["category_id"] = ids[box.label]
        else:
            ann = {"id": next_id, "image_id": image_id, "category_id": ids[box.label], "segmentation": [],
                   "area": _round(b.width * b.height),
                   "bbox": [_round(b.x1), _round(b.y1), _round(b.width), _round(b.height)], "iscrowd": 0}
            next_id += 1
        annotations.append(ann)
    out = dict(doc)
    out["images"] = [first, *(images[1:] if isinstance(images, list) else [])]
    out["annotations"] = annotations
    out["categories"] = categories
    return out


def dump(boxes: list[Box], image: ImageContext, class_names: list[str], *, original: bytes | None = None,
         origins: list[int | None] | None = None) -> bytes:
    """Serialise boxes; category ids are ``index + 1`` in ``class_names``.

    With ``original`` (the file's current bytes) the document is patched instead of rebuilt: box ``i``
    that stems from original annotation ``origins[i]`` keeps its other fields (``attributes``, ``iscrowd``,
    ``score``, ids...), and document-level extras (``info``, ``licenses``...) and category ids are kept.
    New boxes are written in the standard shape.
    """
    base = _original_document(original)
    if base is not None:
        patched = _patch(base, boxes, image, class_names, origins or [])
        return (json.dumps(patched, indent=4, ensure_ascii=False) + "\n").encode("utf-8")
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
