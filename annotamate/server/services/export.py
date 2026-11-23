"""Dataset export as a streamed zip: YOLO (+ data.yaml), Pascal VOC, or one dataset-level COCO file."""

from __future__ import annotations

import json
import logging
import os
import posixpath
import tempfile
import unicodedata
import zipfile
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from typing import IO, Any

from sqlalchemy import bindparam, select, update
from sqlalchemy.orm import Session

from annotamate.core.boxes import Box, sanitize
from annotamate.core.formats import (
    TOO_MANY_BOXES_REASON,
    ImageContext,
    parse_label,
    serialize_label,
    uses_class_index,
)
from annotamate.core.fsutil import OutsideRootError
from annotamate.core.images import ImageError, probe
from annotamate.server.context import AppContext
from annotamate.server.errors import ApiError
from annotamate.server.models import Image, Project
from annotamate.server.services.labels import ClassTable, read_limited
from annotamate.server.services.paths import ProjectPaths

log = logging.getLogger("annotamate.export")


#: Size of the pieces image files are copied in (the archive is never built in memory).
CHUNK = 1024 * 1024
#: Bytes of a COCO export's image and annotation records kept in memory; beyond it they go to a temporary file.
SPOOL_MEMORY = 4 * 1024 * 1024
#: Pixel sizes read during an export are stored in batches of this many images.
REMEMBER_BATCH = 500

#: ``(image id, width, height, file size, file mtime_ns)``: a pixel size read from an image file.
SizeRecord = tuple[int, int, int, int, int]


class _SkipError(Exception):
    """An item's label cannot be exported; the item is left out and the export goes on."""


def safe_entry_name(rel_path: str) -> bool:
    """True when ``rel_path`` can be used as a zip entry name without surprising extraction tools.

    Refused: backslashes, control characters, drive colons, ``.``/``..``/empty segments and absolute names
    (on Linux a dataset file can be named with backslashes, e.g. a fake parent-folder path).
    """
    if not rel_path or rel_path.startswith("/") or "\\" in rel_path or ":" in rel_path:
        return False
    if any(unicodedata.category(c) == "Cc" for c in rel_path):
        return False
    return all(part not in ("", ".", "..") for part in rel_path.split("/"))


@dataclass(slots=True)
class ExportItem:
    rel_path: str
    filename: str
    image_id: int | None = None
    #: Pixel size remembered by the index, valid while the image file still has this size and mtime.
    width: int | None = None
    height: int | None = None
    file_size: int | None = None
    file_mtime_ns: int | None = None


class _Sink:
    """File-like object that collects what ``zipfile`` writes so it can be streamed in chunks."""

    def __init__(self) -> None:
        self._chunks: list[bytes] = []
        self._pos = 0

    def write(self, data: bytes) -> int:
        self._chunks.append(bytes(data))
        self._pos += len(data)
        return len(data)

    def tell(self) -> int:
        return self._pos

    def flush(self) -> None:
        pass

    def drain(self) -> bytes:
        data = b"".join(self._chunks)
        self._chunks.clear()
        return data


def select_items(session: Session, project: Project, scope: str) -> list[ExportItem]:
    """``all`` = every image with a label file; ``done`` = every image whose status is done."""
    query = select(Image.rel_path, Image.filename, Image.id, Image.width, Image.height, Image.file_size,
                   Image.file_mtime_ns).where(Image.project_id == project.id, Image.missing.is_(False))
    query = query.where(Image.status == "done") if scope == "done" else query.where(Image.has_label.is_(True))
    return [ExportItem(*row) for row in session.execute(query.order_by(Image.sort_key))]


def remember_sizes(ctx: AppContext, project_id: int, exif_mode: str, sizes: list[SizeRecord]) -> None:
    """Store pixel sizes an export had to read from the image files, so the next one does not open them.

    Skipped when the project's EXIF mode is no longer the one the sizes were read with.
    """
    with ctx.label_locks(project_id), ctx.db.session() as session:
        if session.scalar(select(Project.exif_mode).where(Project.id == project_id)) != exif_mode:
            return
        session.connection().execute(
            update(Image).where(Image.id == bindparam("_id"), Image.project_id == project_id)
            .values(width=bindparam("_w"), height=bindparam("_h"), file_size=bindparam("_size"),
                    file_mtime_ns=bindparam("_mtime")),
            [{"_id": i, "_w": w, "_h": h, "_size": size, "_mtime": mtime} for i, w, h, size, mtime in sizes])
        session.commit()


class _CocoDocument:
    """A dataset-level COCO file built with flat memory.

    Image and annotation records are appended to two spools (memory first, a temporary file beyond
    ``SPOOL_MEMORY``) while the label files are read; the document is then written straight into the archive:
    ``images``, ``annotations`` and finally ``categories``, which is only complete once every label was seen.
    Ids are 1-based and follow the export order, one record per line.
    """

    _HEAD = b'{\n"images": [\n'
    _MIDDLE = b'\n],\n"annotations": [\n'

    def __init__(self, names: list[str]) -> None:
        self.categories: dict[str, int] = {name: i + 1 for i, name in enumerate(names)}
        self._images: IO[bytes] = tempfile.SpooledTemporaryFile(max_size=SPOOL_MEMORY)  # noqa: SIM115
        self._annotations: IO[bytes] = tempfile.SpooledTemporaryFile(max_size=SPOOL_MEMORY)  # noqa: SIM115
        self.image_count = 0
        self.annotation_count = 0

    @staticmethod
    def _append(spool: IO[bytes], first: bool, record: dict[str, Any]) -> None:
        spool.write((b"" if first else b",\n") + json.dumps(record, ensure_ascii=False).encode("utf-8"))

    def add(self, item: ExportItem, boxes: list[Box], context: ImageContext) -> None:
        self.image_count += 1
        image_id = self.image_count
        self._append(self._images, image_id == 1, {"id": image_id, "file_name": item.rel_path,
                                                   "width": context.width, "height": context.height})
        for box in boxes:
            category = self.categories.setdefault(box.label, len(self.categories) + 1)
            w, h = box.x2 - box.x1, box.y2 - box.y1
            self.annotation_count += 1
            self._append(self._annotations, self.annotation_count == 1, {
                "id": self.annotation_count, "image_id": image_id, "category_id": category,
                "bbox": [round(box.x1, 3), round(box.y1, 3), round(w, 3), round(h, 3)],
                "area": round(w * h, 3), "iscrowd": 0, "segmentation": [],
            })

    def _tail(self) -> bytes:
        categories = ",\n".join(json.dumps({"id": cid, "name": name, "supercategory": "none"}, ensure_ascii=False)
                                for name, cid in self.categories.items())
        return ('\n],\n"categories": [\n' + categories + "\n]\n}\n").encode("utf-8")

    def size(self) -> int:
        return (len(self._HEAD) + self._images.tell() + len(self._MIDDLE) + self._annotations.tell()
                + len(self._tail()))

    def pieces(self) -> Iterator[bytes]:
        """The document's bytes, in pieces of at most ``CHUNK``."""
        yield self._HEAD
        for spool, after in ((self._images, self._MIDDLE), (self._annotations, self._tail())):
            spool.seek(0)
            while block := spool.read(CHUNK):
                yield block
            yield after

    def close(self) -> None:
        self._images.close()
        self._annotations.close()


def _yaml_str(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)  # JSON strings are valid YAML scalars


def data_yaml(names: list[str], include_images: bool) -> str:
    lines = ["# Generated by Annotamate", "path: .", "train: images", "val: images", f"nc: {len(names)}", "names:"]
    lines += [f"  {i}: {_yaml_str(n)}" for i, n in enumerate(names)]
    if not include_images:
        lines.insert(1, "# Images are not included: copy them into ./images (same sub-folders as labels/).")
    return "\n".join(lines) + "\n"


class Exporter:
    def __init__(self, paths: ProjectPaths, table: ClassTable, fmt: str, items: list[ExportItem],
                 include_images: bool, label_lock: AbstractContextManager[Any] | None = None,
                 remember: Callable[[list[SizeRecord]], None] | None = None) -> None:
        """``remember`` receives the pixel sizes that had to be read from image files (see ``remember_sizes``)."""
        self.label_lock = label_lock or nullcontext()
        self.remember = remember
        self._learned: list[SizeRecord] = []
        self.paths = paths
        self.table = table
        self.fmt = fmt
        self.items = items
        self.include_images = include_images
        self.source_fmt = paths.project.label_format

    def _read(self, item: ExportItem) -> tuple[bytes | None, ImageContext | None]:
        try:
            with self.label_lock, open(self.paths.label_file(item.rel_path), "rb") as fh:  # not mid-save/migration
                data: bytes | None = read_limited(fh)
        except (OSError, OutsideRootError):
            data = None
        else:
            if data is None:
                raise _SkipError("the label file is too large")
        context = None
        if self.fmt != self.source_fmt or self.fmt == "coco" or data is None:
            try:
                image_path = self.paths.image_file(item.rel_path)
                width, height, depth = self._image_size(item, image_path)
            except (ImageError, ApiError):  # unreadable images are exported without labels
                return data, None
            folder = posixpath.dirname(item.rel_path)
            context = ImageContext(width, height, depth, item.filename,
                                   posixpath.basename(folder) if folder else "", item.rel_path)
        return data, context

    def _image_size(self, item: ExportItem, image_path: str) -> tuple[int, int, int]:
        """``(width, height, depth)``: from the index when the file is still the one it was read from.

        Only COCO can do without opening the image (it does not store the depth); what is read here is handed
        to ``remember`` so that the next export finds it in the index.
        """
        try:
            st = os.stat(image_path)
            state: tuple[int, int] | None = (st.st_size, st.st_mtime_ns)
        except OSError:
            state = None
        if (self.fmt == "coco" and state is not None and item.width is not None and item.height is not None
                and state == (item.file_size, item.file_mtime_ns)):
            return item.width, item.height, 3
        info = probe(image_path, self.paths.project.exif_mode)
        if state is not None and item.image_id is not None and self.remember is not None:
            self._learned.append((item.image_id, info.width, info.height, *state))
            if len(self._learned) >= REMEMBER_BATCH:
                self._flush_learned()
        return info.width, info.height, info.depth

    def _flush_learned(self) -> None:
        sizes, self._learned = self._learned, []
        if sizes and self.remember is not None:
            try:
                self.remember(sizes)
            except Exception:  # a convenience for the next export: never a reason to fail this one
                log.warning("Could not store %d image sizes read during an export", len(sizes), exc_info=True)

    def _boxes(self, data: bytes | None, context: ImageContext) -> list[Box]:
        """Boxes relabelled for the target format; unknown labels are kept where the target can express them."""
        if data is None:
            return []
        result = parse_label(self.source_fmt, data, context.width, context.height)
        if result.readonly_reason == TOO_MANY_BOXES_REASON:
            raise _SkipError("the label file has too many boxes")
        out: list[Box] = []
        for box in sanitize(result.boxes, context.width, context.height):
            cls = self.table.resolve(box.label)
            if cls is not None:
                label = str(self.table.index_of(cls)) if uses_class_index(self.fmt) else cls.name
            elif uses_class_index(self.fmt) == uses_class_index(self.source_fmt):
                label = box.label
            else:
                continue  # an unknown name has no YOLO index (and vice versa)
            out.append(Box(box.x1, box.y1, box.x2, box.y2, label, box.difficult, box.truncated))
        return out

    def _add_label(self, zf: zipfile.ZipFile, coco: _CocoDocument | None, item: ExportItem) -> None:
        data, context = self._read(item)
        stem = posixpath.splitext(item.rel_path)[0]
        if coco is not None:
            if context is not None:
                # The boxes first: nothing is added for an item that fails there.
                coco.add(item, self._boxes(data, context), context)
        elif self.fmt == self.source_fmt and data is not None:
            folder = "labels" if self.fmt == "yolo" else "Annotations"
            zf.writestr(f"{folder}/{stem}{'.txt' if self.fmt == 'yolo' else '.xml'}", data)
        elif context is not None:
            boxes = self._boxes(data, context)
            payload = serialize_label(self.fmt, boxes, context, self.table.names)
            folder = "labels" if self.fmt == "yolo" else "Annotations"
            zf.writestr(f"{folder}/{stem}{'.txt' if self.fmt == 'yolo' else '.xml'}", payload)

    def _copy_image(self, zf: zipfile.ZipFile, sink: _Sink, item: ExportItem) -> Iterator[bytes]:
        """Copy an image into the archive in chunks, yielding what the archive produced after each one."""
        source = self.paths.image_file(item.rel_path)
        info = zipfile.ZipInfo.from_file(source, f"images/{item.rel_path}", strict_timestamps=False)
        info.compress_type = zipfile.ZIP_STORED
        with open(source, "rb") as src, zf.open(info, "w") as dest:
            while block := src.read(CHUNK):
                dest.write(block)
                piece = sink.drain()
                if piece:
                    yield piece

    def stream(self) -> Iterator[bytes]:
        """The archive in chunks. A problem with one item skips that item (with a warning), never the archive."""
        sink = _Sink()
        coco = _CocoDocument(self.table.names) if self.fmt == "coco" else None
        try:
            with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED) as zf:  # type: ignore[arg-type]
                for item in self.items:
                    if not safe_entry_name(item.rel_path):
                        log.warning("Export skipped %r: its name is not safe to store in an archive", item.rel_path)
                        continue
                    try:
                        self._add_label(zf, coco, item)
                    except _SkipError as exc:
                        log.warning("Export skipped the labels of %s: %s", item.rel_path, exc)
                    except Exception:
                        log.warning("Export skipped the labels of %s", item.rel_path, exc_info=True)
                    if self.include_images:
                        try:
                            yield from self._copy_image(zf, sink, item)
                        except (OSError, ApiError) as exc:
                            log.warning("Export skipped image %s: %s", item.rel_path, exc)
                        except Exception:
                            log.warning("Export skipped image %s", item.rel_path, exc_info=True)
                    chunk = sink.drain()
                    if chunk:
                        yield chunk
                if self.fmt == "yolo":
                    zf.writestr("classes.txt", "".join(f"{n}\n" for n in self.table.names))
                    zf.writestr("data.yaml", data_yaml(self.table.names, self.include_images))
                elif coco is not None:
                    # Written piece by piece: neither the document nor its compressed form is held in memory.
                    big = coco.size() * 1.05 > zipfile.ZIP64_LIMIT
                    with zf.open("annotations.json", "w", force_zip64=big) as dest:
                        for piece in coco.pieces():
                            dest.write(piece)
                            chunk = sink.drain()
                            if chunk:
                                yield chunk
            tail = sink.drain()
            if tail:
                yield tail
        finally:
            if coco is not None:
                coco.close()
            self._flush_learned()
