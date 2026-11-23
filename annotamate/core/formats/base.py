"""Shared types for the label-file formats."""

from __future__ import annotations

from dataclasses import dataclass, field

from annotamate.core.boxes import Box


@dataclass
class ParseResult:
    """Boxes read from a label file.

    ``readonly_reason`` is set when the file holds content this tool cannot write back without
    losing information (segmentation polygons, oriented boxes, parse errors...). The boxes that
    could be understood are still returned so the image can be displayed.
    ``categories`` lists class names declared by the file itself (COCO only), in id order.
    """

    boxes: list[Box] = field(default_factory=list)
    readonly_reason: str | None = None
    categories: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ImageContext:
    """What a writer needs to know about the image a label file belongs to."""

    width: int
    height: int
    depth: int = 3
    filename: str = ""
    folder: str = ""
    path: str = ""


class LabelFormatError(ValueError):
    """Raised by writers when boxes cannot be represented in the format."""
