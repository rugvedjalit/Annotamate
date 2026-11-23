"""Reading label files and mapping their labels onto project classes."""

from __future__ import annotations

import hashlib
import os
import uuid
from dataclasses import dataclass, field
from typing import BinaryIO

from sqlalchemy import select
from sqlalchemy.orm import Session

from annotamate.core.classes import write_classes
from annotamate.core.formats import MAX_LABEL_BYTES, TOO_LARGE_REASON, ParseResult, parse_label, uses_class_index
from annotamate.core.fsutil import OutsideRootError
from annotamate.server.models import Image, PendingRename, Project, ProjectClass
from annotamate.server.services.paths import RESERVED_YOLO_KEY, ProjectPaths, label_key


def read_limited(fh: BinaryIO) -> bytes | None:
    """The rest of ``fh``, or ``None`` when it is larger than ``MAX_LABEL_BYTES`` (nothing big is loaded)."""
    try:
        if os.fstat(fh.fileno()).st_size > MAX_LABEL_BYTES:
            return None
    except (OSError, AttributeError, ValueError):
        pass
    data = fh.read(MAX_LABEL_BYTES + 1)
    return None if len(data) > MAX_LABEL_BYTES else data


def label_version(data: bytes) -> str:
    """First 16 hex characters of the SHA-256 of the label file bytes."""
    return hashlib.sha256(data).hexdigest()[:16]


def stable_box_id(image_id: int, version: str | None, index: int) -> str:
    """Deterministic UUID (version 4 layout) for a box read from disk, stable across reloads."""
    digest = hashlib.sha256(f"annotamate:{image_id}:{version}:{index}".encode()).digest()
    return str(uuid.UUID(bytes=digest[:16], version=4))


@dataclass
class ClassTable:
    """A project's classes in index order, with lookups in both directions."""

    fmt: str
    classes: list[ProjectClass]
    #: Old name -> current name of renames whose label-file rewrite is still pending (VOC/COCO only).
    aliases: dict[str, str] = field(default_factory=dict)
    by_id: dict[int, ProjectClass] = field(init=False)
    by_name: dict[str, ProjectClass] = field(init=False)

    def __post_init__(self) -> None:
        self.classes = sorted(self.classes, key=lambda c: (c.position, c.id))
        self.by_id = {c.id: c for c in self.classes}
        self.by_name = {c.name: c for c in self.classes}
        self._index = {c.id: i for i, c in enumerate(self.classes)}

    @property
    def names(self) -> list[str]:
        return [c.name for c in self.classes]

    def index_of(self, cls: ProjectClass) -> int:
        """YOLO index: the position in this ordered list (what ``resolve`` reads back)."""
        return self._index[cls.id]

    def label_for(self, cls: ProjectClass) -> str:
        return str(self.index_of(cls)) if uses_class_index(self.fmt) else cls.name

    def resolve(self, label: str) -> ProjectClass | None:
        if uses_class_index(self.fmt):
            try:
                index = int(label)
            except ValueError:
                return None
            return self.classes[index] if 0 <= index < len(self.classes) else None
        cls = self.by_name.get(label)
        if cls is None and label in self.aliases:
            cls = self.by_name.get(self.aliases[label])
        return cls

    def counts(self, result: ParseResult) -> tuple[dict[int, int], int]:
        """Boxes per class id, plus the number of boxes with unknown labels."""
        per_class: dict[int, int] = {}
        unknown = 0
        for box in result.boxes:
            cls = self.resolve(box.label)
            if cls is None:
                unknown += 1
            else:
                per_class[cls.id] = per_class.get(cls.id, 0) + 1
        return per_class, unknown


def pending_aliases(session: Session, project_id: int) -> dict[str, str]:
    """``old name -> current name`` for the renames whose files have not all been rewritten yet.

    Chains collapse (a -> b, then b -> c gives a -> c and b -> c); a name renamed back maps to nothing.
    """
    aliases: dict[str, str] = {}
    for old, new in session.execute(select(PendingRename.old_name, PendingRename.new_name)
                                    .where(PendingRename.project_id == project_id).order_by(PendingRename.id)):
        for key, value in list(aliases.items()):
            if value == old:
                aliases[key] = new
        aliases[old] = new
    return {k: v for k, v in aliases.items() if k != v}


def load_class_table(session: Session, project_id: int, fmt: str) -> ClassTable:
    rows = list(session.scalars(select(ProjectClass).where(ProjectClass.project_id == project_id)))
    aliases = {} if uses_class_index(fmt) else pending_aliases(session, project_id)
    return ClassTable(fmt, rows, aliases)


@dataclass
class LabelFile:
    path: str | None           # None when the label path is unsafe
    data: bytes | None         # None when the file does not exist
    mtime: float | None
    parse: ParseResult
    readonly_reason: str | None
    #: ``(size, mtime_ns)`` of the file as it was opened (``None`` when there is no readable file).
    stat: tuple[int, int] | None = None

    @property
    def exists(self) -> bool:
        return self.data is not None

    @property
    def version(self) -> str | None:
        return label_version(self.data) if self.data is not None else None


def label_block(session: Session, project: Project, image: Image) -> str | None:
    """Why this image cannot have its own label file (shared with an earlier image, or the reserved name)."""
    key = image.label_key or label_key(image.rel_path)
    if project.label_format == "yolo" and key == RESERVED_YOLO_KEY:
        return ("The name 'classes' is reserved for the class list (classes.txt), so this image cannot be "
                "annotated. Rename the image file to annotate it.")
    owner = session.execute(
        select(Image.id, Image.rel_path).where(Image.project_id == project.id, Image.label_key == key,
                                               Image.missing.is_(False))
        .order_by(Image.sort_key, Image.id).limit(1)
    ).first()
    if owner is not None and owner.id != image.id:
        return (f"This image shares its label file with {owner.rel_path}, which owns it. Rename one of the images "
                "to give each its own labels.")
    return None


def read_label_file(paths: ProjectPaths, rel_path: str, width: float | None = None,
                    height: float | None = None, *, blocked: str | None = None) -> LabelFile:
    """Read and parse an image's label file. Problems become ``readonly_reason`` rather than errors.

    ``blocked`` (see :func:`label_block`) makes the image read-only with an empty document.
    """
    fmt = paths.project.label_format
    try:
        path = paths.label_file(rel_path)
    except OutsideRootError:
        return LabelFile(None, None, None, ParseResult(), "The label file resolves outside the label folder.")
    if blocked:
        return LabelFile(path, None, None, ParseResult(), blocked)
    try:
        with open(path, "rb") as fh:
            st = os.fstat(fh.fileno())
            mtime, stat = st.st_mtime, (st.st_size, st.st_mtime_ns)
            data = read_limited(fh)
    except FileNotFoundError:
        return LabelFile(path, None, None, ParseResult(), None)
    except IsADirectoryError:
        return LabelFile(path, None, None, ParseResult(), "The label path is a folder.")
    except OSError as exc:
        return LabelFile(path, None, None, ParseResult(), f"The label file cannot be read ({exc.strerror}).")
    if data is None:  # too large to load: unreadable for the editor, but it does exist
        return LabelFile(path, None, mtime, ParseResult(), TOO_LARGE_REASON, stat)
    result = parse_label(fmt, data, width, height)
    return LabelFile(path, data, mtime, result, result.readonly_reason, stat)


def sync_classes_file(paths: ProjectPaths, table: ClassTable, *, only_if_missing: bool = False) -> None:
    """Write ``classes.txt`` in the label folder so it matches the class list."""
    try:
        target = paths.classes_file()
    except OutsideRootError:
        raise OSError("classes.txt resolves outside the label folder") from None
    if only_if_missing and os.path.exists(target):
        return
    write_classes(target, table.names)
