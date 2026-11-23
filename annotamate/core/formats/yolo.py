"""YOLO detection labels: one ``class cx cy w h`` line per box, normalised to the image size."""

from __future__ import annotations

import math

from annotamate.core.boxes import Box, clamp
from annotamate.core.formats.base import ImageContext, LabelFormatError, ParseResult

EXTENSION = ".txt"

READONLY_EXTRA_COLUMNS = (
    "This label file contains segmentation or oriented-box lines (more than 5 values per line). "
    "Editing is disabled so they are not lost."
)


#: Longest piece of file content (a token, a label) echoed into a message shown to users.
ECHO_LIMIT = 100


def _clip(value: object, limit: int = ECHO_LIMIT) -> str:
    """``str(value)`` cut to ``limit`` characters, so a hostile file cannot produce a huge message."""
    text = str(value)
    return text if len(text) <= limit else f"{text[:limit]}..."


def _class_index(token: str) -> int:
    try:
        value = float(token)
    except (ValueError, OverflowError):
        raise ValueError(f"invalid class id {_clip(repr(token))}") from None
    if not math.isfinite(value) or not value.is_integer() or value < 0:
        raise ValueError(f"invalid class id {_clip(repr(token))}")
    return int(value)


def _finite(tokens: list[str]) -> list[float]:
    values = [float(t) for t in tokens]
    if not all(math.isfinite(v) for v in values):
        raise ValueError("non-finite coordinate")
    return values


def parse(text: str, width: float = 1.0, height: float = 1.0, *, max_boxes: int | None = None) -> ParseResult:
    """Parse YOLO text. Coordinates are scaled to ``width`` x ``height`` pixels.

    With the default size of 1 the boxes stay normalised, which is enough to count labels.
    Lines with more than 5 values are reduced to their bounding rectangle and make the file read-only.
    Malformed input never raises: it makes the file read-only. With ``max_boxes`` parsing stops as
    soon as more boxes than that were found (the caller reports it).
    """
    result = ParseResult()
    try:
        _parse_lines(text, width, height, max_boxes, result)
    except Exception as exc:  # a label file is untrusted input: nothing in it may escape as an error
        result.readonly_reason = result.readonly_reason or f"The label file cannot be parsed ({_clip(exc)})."
    return result


def _parse_lines(text: str, width: float, height: float, max_boxes: int | None, result: ParseResult) -> None:
    for lineno, line in enumerate(text.splitlines(), start=1):
        if max_boxes is not None and len(result.boxes) > max_boxes:
            return
        tokens = line.split()
        if not tokens:
            continue
        try:
            label = str(_class_index(tokens[0]))
            if len(tokens) < 5:
                raise ValueError(f"expected 5 values, found {len(tokens)}")
            coords = _finite(tokens[1:])
        except (ValueError, OverflowError) as exc:
            result.readonly_reason = (result.readonly_reason
                                      or f"Line {lineno} of the label file cannot be parsed ({_clip(exc)}).")
            continue
        if len(coords) == 4:
            cx, cy, w, h = coords
            x1, y1, x2, y2 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
        else:
            if result.readonly_reason is None:
                result.readonly_reason = READONLY_EXTRA_COLUMNS
            if len(coords) % 2 == 0 and len(coords) >= 6:  # polygon (segmentation) or OBB corner points
                xs, ys = coords[0::2], coords[1::2]
                x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
            else:  # e.g. "cx cy w h confidence"
                cx, cy, w, h = coords[:4]
                x1, y1, x2, y2 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
        result.boxes.append(Box(x1 * width, y1 * height, x2 * width, y2 * height, label))


def dump(boxes: list[Box], image: ImageContext) -> str:
    """Serialise boxes; labels must be non-negative class indexes. Values keep 6 decimals."""
    if image.width <= 0 or image.height <= 0:
        raise LabelFormatError("image size is required to write YOLO labels")
    lines = []
    for box in boxes:
        try:
            index = _class_index(box.label)
        except ValueError:
            raise LabelFormatError(f"YOLO labels must be class indexes, got {_clip(repr(box.label))}") from None
        b = clamp(box, image.width, image.height)
        if b.width <= 0 or b.height <= 0:
            continue
        cx = (b.x1 + b.x2) / 2 / image.width
        cy = (b.y1 + b.y2) / 2 / image.height
        nw = b.width / image.width
        nh = b.height / image.height
        lines.append(f"{index} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}\n")
    return "".join(lines)


def relabel(text: str, mapping: dict[int, int | None]) -> tuple[str, int]:
    """Change class indexes in place, line by line, keeping everything else byte-for-byte.

    ``mapping`` maps an old index to a new one, or to ``None`` to drop the line. Indexes not in the
    mapping and lines that cannot be parsed are kept unchanged. Returns the new text and the number
    of lines changed or removed.
    """
    out: list[str] = []
    changed = 0
    for line in text.splitlines(keepends=True):
        stripped = line.lstrip()
        tokens = stripped.split(maxsplit=1)
        if not tokens:
            out.append(line)
            continue
        try:
            index = _class_index(tokens[0])
        except ValueError:
            out.append(line)
            continue
        if index not in mapping:
            out.append(line)
            continue
        target = mapping[index]
        changed += 1
        if target is None:
            continue
        indent = line[: len(line) - len(stripped)]
        out.append(f"{indent}{target}{stripped[len(tokens[0]):]}")
    return "".join(out), changed
