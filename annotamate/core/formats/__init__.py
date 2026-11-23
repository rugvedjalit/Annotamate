"""Read and write label files in YOLO, Pascal VOC and COCO (one JSON per image)."""

from __future__ import annotations

from annotamate.core.boxes import Box
from annotamate.core.formats import coco, voc, yolo
from annotamate.core.formats.base import ImageContext, LabelFormatError, ParseResult

FORMATS = ("yolo", "voc", "coco")
EXTENSIONS = {"yolo": yolo.EXTENSION, "voc": voc.EXTENSION, "coco": coco.EXTENSION}

#: Largest label file that is read or parsed; bigger ones make the image read-only.
MAX_LABEL_BYTES = 8 * 1024 * 1024
#: Most boxes read from one label file (the same limit the annotation PUT accepts).
MAX_BOXES = 20_000
TOO_LARGE_REASON = f"The label file is larger than {MAX_LABEL_BYTES // (1024 * 1024)} MB. Editing is disabled."
TOO_MANY_BOXES_REASON = f"The label file has more than {MAX_BOXES} boxes. Editing is disabled."

__all__ = [
    "EXTENSIONS",
    "FORMATS",
    "MAX_BOXES",
    "MAX_LABEL_BYTES",
    "TOO_LARGE_REASON",
    "TOO_MANY_BOXES_REASON",
    "ImageContext",
    "LabelFormatError",
    "ParseResult",
    "parse_label",
    "relabel",
    "serialize_label",
    "uses_class_index",
]


def uses_class_index(fmt: str) -> bool:
    """True when the format stores class indexes (YOLO) rather than class names (VOC, COCO)."""
    return fmt == "yolo"


def parse_label(fmt: str, data: bytes, width: float | None = None, height: float | None = None) -> ParseResult:
    """Parse label file bytes. ``width``/``height`` are only needed to turn YOLO's normalised values into pixels.

    Never raises for bad content: damaged, oversized or over-full files come back read-only
    (more than ``MAX_BOXES`` boxes keeps the first ``MAX_BOXES``).
    """
    if fmt not in FORMATS:
        raise ValueError(f"unknown label format {fmt!r}")
    if len(data) > MAX_LABEL_BYTES:
        return ParseResult(readonly_reason=TOO_LARGE_REASON)
    try:
        if fmt == "yolo":
            try:
                text = data.decode("utf-8-sig")
            except UnicodeDecodeError:
                return ParseResult(readonly_reason="The label file is not valid UTF-8 text.")
            result = yolo.parse(text, width or 1.0, height or 1.0, max_boxes=MAX_BOXES)
        elif fmt == "voc":
            result = voc.parse(data, max_boxes=MAX_BOXES)
        else:
            result = coco.parse(data, max_boxes=MAX_BOXES)
    except Exception:  # the parsers handle bad content themselves; this is the last line of defence
        return ParseResult(readonly_reason="The label file cannot be parsed.")
    if len(result.boxes) > MAX_BOXES:
        del result.boxes[MAX_BOXES:]
        result.readonly_reason = TOO_MANY_BOXES_REASON
    return result


def serialize_label(fmt: str, boxes: list[Box], image: ImageContext, class_names: list[str], *,
                    original: bytes | None = None, origins: list[int | None] | None = None) -> bytes:
    """Serialise boxes for ``fmt``. ``class_names`` is the project's class order (used by COCO categories).

    VOC and COCO patch ``original`` (the file's current bytes) when given: ``origins[i]`` is the index, among
    the boxes parsed from ``original``, that box ``i`` stems from (``None`` for a new box); fields the tool
    does not model are kept for those boxes and for the document itself. YOLO has nothing to preserve.
    """
    if fmt == "yolo":
        return yolo.dump(boxes, image).encode("utf-8")
    if fmt == "voc":
        return voc.dump(boxes, image, original=original, origins=origins)
    if fmt == "coco":
        return coco.dump(boxes, image, class_names, original=original, origins=origins)
    raise ValueError(f"unknown label format {fmt!r}")


def relabel(
    fmt: str,
    data: bytes,
    *,
    index_map: dict[int, int | None] | None = None,
    name_map: dict[str, str | None] | None = None,
    class_names: list[str] | None = None,
) -> tuple[bytes, int]:
    """Apply a class migration to one label file without touching anything else in it.

    YOLO uses ``index_map`` (old index -> new index or ``None`` to delete); VOC and COCO use
    ``name_map``. COCO also renumbers its categories after ``class_names`` (the new class order).
    """
    if fmt not in FORMATS:
        raise ValueError(f"unknown label format {fmt!r}")
    try:  # malformed files are left unchanged, whatever is wrong with them
        if fmt == "yolo":
            try:
                text = data.decode("utf-8-sig")
            except UnicodeDecodeError:
                return data, 0
            new_text, changed = yolo.relabel(text, index_map or {})
            return (new_text.encode("utf-8"), changed) if changed else (data, 0)
        if fmt == "voc":
            return voc.relabel(data, name_map or {})
        return coco.relabel(data, name_map or {}, class_names or [])
    except Exception:
        return data, 0
