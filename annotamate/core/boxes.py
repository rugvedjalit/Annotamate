"""Bounding boxes and the geometry helpers used before anything is written to disk."""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

#: Boxes narrower or shorter than this (in image pixels) are dropped on save.
MIN_BOX_SIZE = 1.0


@dataclass(frozen=True)
class Box:
    """An axis-aligned box in image pixel coordinates.

    ``label`` is what the label file stores: the class index as a string for YOLO
    (``"0"``, ``"3"``), the class name for Pascal VOC and COCO.
    """

    x1: float
    y1: float
    x2: float
    y2: float
    label: str
    difficult: bool = False
    truncated: bool = False

    @property
    def width(self) -> float:
        return self.x2 - self.x1

    @property
    def height(self) -> float:
        return self.y2 - self.y1


def is_finite(box: Box) -> bool:
    return all(math.isfinite(v) for v in (box.x1, box.y1, box.x2, box.y2))


def normalize(box: Box) -> Box:
    """Return the box with ``x1 <= x2`` and ``y1 <= y2``."""
    x1, x2 = sorted((box.x1, box.x2))
    y1, y2 = sorted((box.y1, box.y2))
    if (x1, y1, x2, y2) == (box.x1, box.y1, box.x2, box.y2):
        return box
    return replace(box, x1=x1, y1=y1, x2=x2, y2=y2)


def clamp(box: Box, width: float, height: float) -> Box:
    """Clamp every edge into ``[0, width] x [0, height]`` (the box is normalised first)."""
    box = normalize(box)
    x1 = min(max(box.x1, 0.0), width)
    x2 = min(max(box.x2, 0.0), width)
    y1 = min(max(box.y1, 0.0), height)
    y2 = min(max(box.y2, 0.0), height)
    if (x1, y1, x2, y2) == (box.x1, box.y1, box.x2, box.y2):
        return box
    return replace(box, x1=x1, y1=y1, x2=x2, y2=y2)


def sanitize(boxes: list[Box], width: float, height: float, min_size: float = MIN_BOX_SIZE) -> list[Box]:
    """Normalise and clamp boxes to the image, dropping non-finite and degenerate ones."""
    out: list[Box] = []
    for box in boxes:
        if not is_finite(box):
            continue
        box = clamp(box, width, height)
        if box.width >= min_size and box.height >= min_size:
            out.append(box)
    return out
