"""Read and write label files in YOLO, Pascal VOC and COCO (one JSON per image)."""

from __future__ import annotations

from annotamate.core.boxes import Box
from annotamate.core.formats import coco, voc, yolo
from annotamate.core.formats.base import ImageContext, LabelFormatError, ParseResult

FORMATS = ("yolo", "voc", "coco")
EXTENSIONS = {"yolo": yolo.EXTENSION, "voc": voc.EXTENSION, "coco": coco.EXTENSION}

__all__ = [
    "EXTENSIONS",
    "FORMATS",
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
    """Parse label file bytes. ``width``/``height`` are only needed to turn YOLO's normalised values into pixels."""
    if fmt == "yolo":
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            return ParseResult(readonly_reason="The label file is not valid UTF-8 text.")
        return yolo.parse(text, width or 1.0, height or 1.0)
    if fmt == "voc":
        return voc.parse(data)
    if fmt == "coco":
        return coco.parse(data)
    raise ValueError(f"unknown label format {fmt!r}")


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
    if fmt == "yolo":
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            return data, 0
        new_text, changed = yolo.relabel(text, index_map or {})
        return (new_text.encode("utf-8"), changed) if changed else (data, 0)
    if fmt == "voc":
        return voc.relabel(data, name_map or {})
    if fmt == "coco":
        return coco.relabel(data, name_map or {}, class_names or [])
    raise ValueError(f"unknown label format {fmt!r}")
