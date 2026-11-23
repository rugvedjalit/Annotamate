"""Background indexing: scan a project's folder, parse existing label files, sync the image table.

A rescan reads only the label files that changed. With every count the image row keeps the size and
modification time of the label file it was computed from and the project's class-list version
(``Image.label_size``, ``label_mtime_ns``, ``counted_version``); see :func:`counts_still_valid` for the rule
and why it gives exactly the rows a full re-parse would.
"""

from __future__ import annotations

import logging
import os
import posixpath
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import bindparam, delete, insert, select, update
from sqlalchemy.orm import Session

from annotamate.core.classes import next_color, read_classes
from annotamate.core.formats import parse_label, uses_class_index
from annotamate.core.fsutil import OutsideRootError, is_inside, resolve_inside
from annotamate.core.scanning import natural_sort_key, scan
from annotamate.server.context import AppContext, IndexProgress
from annotamate.server.errors import ApiError
from annotamate.server.models import Image, ImageClassCount, Project, ProjectClass, utcnow
from annotamate.server.services import notify
from annotamate.server.services.labels import ClassTable, load_class_table, read_limited, sync_classes_file
from annotamate.server.services.paths import RESERVED_YOLO_KEY, ProjectPaths, label_key

log = logging.getLogger("annotamate.indexing")

BATCH = 1000
MAX_ATTEMPTS = 3
PROGRESS_INTERVAL = 0.5
_NORM = str.lower if os.name == "nt" else str
#: A file modified less than this long ago can be modified again without its size or timestamp changing
#: (file systems and clocks tick in steps of up to two seconds). Its state is then not remembered, so the
#: next rescan reads it again. Files written by a save of this server are exempt (it knows what it wrote).
RACY_NS = 2_000_000_000

#: ``(size, mtime_ns)`` of a label file.
FileStat = tuple[int, int]


@dataclass
class ParsedLabel:
    has_label: bool
    labels: Counter
    categories: list[str]
    #: State of the file whose content was parsed, when it pins that content down; ``None`` otherwise
    #: (no file, an unreadable one, or one modified a moment ago).
    stat: FileStat | None = None


def _no_label() -> ParsedLabel:
    return ParsedLabel(False, Counter(), [])


class LabelLister:
    """Finds label files with one directory listing per folder (no per-file ``realpath``).

    A folder is checked against the label root once; only entries that are symlinks are resolved
    individually, so a link pointing outside the project is still never read. The listing also gives each
    file's size and modification time without opening it.
    """

    def __init__(self, paths: ProjectPaths) -> None:
        self.paths = paths
        self._folders: dict[str, tuple[str, dict[str, tuple[bool, FileStat | None]]] | None] = {}

    def _folder(self, folder: str) -> tuple[str, dict[str, tuple[bool, FileStat | None]]] | None:
        if folder in self._folders:
            return self._folders[folder]
        root = self.paths.label_root
        directory = os.path.join(root, *folder.split("/")) if folder else root
        entry: tuple[str, dict[str, tuple[bool, FileStat | None]]] | None = None
        if is_inside(root, directory):
            extension = self.paths.extension
            listing: dict[str, tuple[bool, FileStat | None]] = {}
            try:
                with os.scandir(directory) as it:
                    for item in it:
                        name = _NORM(item.name)
                        if not name.endswith(extension):
                            continue  # only label files are ever looked up
                        try:
                            st = item.stat()
                            stat: FileStat | None = (st.st_size, st.st_mtime_ns)
                        except OSError:
                            stat = None
                        listing[name] = (item.is_symlink(), stat)
                entry = (directory, listing)
            except OSError:
                entry = None
        self._folders[folder] = entry
        return entry

    def find(self, label_rel: str) -> tuple[str, FileStat | None] | None:
        """``(path, (size, mtime_ns))`` of an existing, safe label file, or None."""
        folder, name = posixpath.split(label_rel)
        found = self._folder(folder)
        if found is None:
            return None
        directory, listing = found
        entry = listing.get(_NORM(name))
        if entry is None:
            return None
        is_link, stat = entry
        path = os.path.join(directory, name)
        if is_link:
            try:
                return resolve_inside(self.paths.label_root, path), stat
            except OutsideRootError:
                return None
        return path, stat

    def path(self, label_rel: str) -> str | None:
        """Path of an existing, safe label file, or None."""
        found = self.find(label_rel)
        return found[0] if found is not None else None


def pinned_stat(st: os.stat_result) -> FileStat | None:
    """``(size, mtime_ns)`` when the file is old enough for them to identify its content (see ``RACY_NS``)."""
    if time.time_ns() - st.st_mtime_ns <= RACY_NS:
        return None
    return st.st_size, st.st_mtime_ns


def parse_for_index(paths: ProjectPaths, rel_path: str, lister: LabelLister | None = None) -> ParsedLabel:
    """Label names (with counts) found in an image's label file; YOLO values stay normalised.

    One file never affects another: a file that is too large, damaged or otherwise raises is recorded as
    an existing label file without boxes (the editor shows why it is read-only).
    """
    try:
        path = lister.path(paths.label_rel(rel_path)) if lister is not None else paths.label_file(rel_path)
    except OutsideRootError:
        return _no_label()
    if path is None:
        return _no_label()
    return parse_label_file(paths.project.label_format, path, rel_path)


def parse_label_file(fmt: str, path: str, rel_path: str) -> ParsedLabel:
    """Read and parse the label file at ``path`` (already checked to be inside the label folder)."""
    try:
        with open(path, "rb") as fh:
            # Taken before the content is read: a write that lands later always shows in a later listing.
            stat = pinned_stat(os.fstat(fh.fileno()))
            data = read_limited(fh)
    except OSError:
        return _no_label()
    if data is None:  # larger than the label size limit: counted as present, never loaded
        return ParsedLabel(True, Counter(), [], stat)
    try:
        result = parse_label(fmt, data)
    except Exception:
        log.warning("Label file of %s could not be indexed", rel_path, exc_info=True)
        return ParsedLabel(True, Counter(), [], stat)
    return ParsedLabel(True, Counter(b.label for b in result.boxes), result.categories, stat)


def counts_for(table: ClassTable, parsed: ParsedLabel) -> tuple[dict[int, int], int, int]:
    """``(per class id, unknown boxes, total boxes)``."""
    per_class: dict[int, int] = {}
    unknown = 0
    for label, n in parsed.labels.items():
        cls = table.resolve(label)
        if cls is None:
            unknown += n
        else:
            per_class[cls.id] = per_class.get(cls.id, 0) + n
    return per_class, unknown, sum(parsed.labels.values())


def counts_still_valid(row: Any, key: str, stat: FileStat | None, version: int, floor: int) -> bool:
    """True when the counts stored for an image are what parsing its label file again would give.

    ``row`` has the image's stored state, ``stat`` is the file's current size and modification time and
    ``version`` / ``floor`` are the project's ``class_version`` / ``class_floor``. The counts are reused when

    1. the file is the one that was counted: same label key, same size, same modification time (a state is
       only ever stored when it identifies the content, see ``RACY_NS``), and
    2. the class list still maps its labels the same way: either it has not changed at all since
       (``counted_version == version``), or every label of the file was known then (``unknown_count == 0``)
       and nothing that changes the meaning of a known label has happened since (``counted_version >= floor``).
       Adding a class appends it, and a rename keeps the class (the old name stays an alias until every file is
       rewritten): a label that was known keeps its class. Deleting or merging a class and dropping a rename's
       alias raise the floor.
    """
    if stat is None or not row.has_label or row.label_key != key or row.counted_version is None:
        return False
    if (row.label_size, row.label_mtime_ns) != stat:
        return False
    return row.counted_version == version or (row.unknown_count == 0 and row.counted_version >= floor)


def bump_class_version(project: Project, *, known_labels_change: bool = False) -> None:
    """Record a change to the project's class list (the caller holds the label lock and commits).

    ``known_labels_change``: the change can alter the class of a label that was already known (delete, merge,
    the end of a rename), so no count made before it may be reused.
    """
    project.class_version = (project.class_version or 0) + 1
    if known_labels_change:
        project.class_floor = project.class_version


def set_label_state(image: Image, stat: FileStat | None, class_version: int) -> None:
    """Remember which label file (and class list) the image's counts were computed from; ``None`` = unknown."""
    image.label_size, image.label_mtime_ns = stat if stat is not None else (None, None)
    image.counted_version = class_version if stat is not None else None


def label_owners(rel_paths: list[str], keys: list[str], fmt: str) -> dict[str, str]:
    """``label key -> rel path`` of the image that owns each label file: the first in natural order.

    ``rel_paths`` must be in natural order, ``keys`` are their label keys. For YOLO the key ``classes``
    (``classes.txt``) has no owner.
    """
    owners: dict[str, str] = {}
    for rel, key in zip(rel_paths, keys, strict=True):
        owners.setdefault(key, rel)
    if fmt == "yolo":
        owners.pop(RESERVED_YOLO_KEY, None)
    return owners


def replace_class_counts(session: Session, image_id: int, per_class: dict[int, int]) -> None:
    session.execute(delete(ImageClassCount).where(ImageClassCount.image_id == image_id))
    if per_class:
        session.execute(insert(ImageClassCount), [
            {"image_id": image_id, "class_id": cid, "count": n} for cid, n in per_class.items()
        ])


class _RetryChunkError(Exception):
    """The rows of a chunk changed between reading its files and storing the result: read it again."""


_ROW_COLUMNS = (Image.id, Image.rel_path, Image.has_label, Image.box_count, Image.unknown_count, Image.updated_at,
                Image.missing, Image.label_key, Image.label_size, Image.label_mtime_ns, Image.counted_version)


class Indexer:
    """One index pass over a project, in chunks of ``BATCH`` images.

    For each chunk the label files that changed are read without any lock, then the project's label lock is
    taken just long enough to store the chunk (one short transaction). Saves and class changes therefore wait
    for one chunk at most, never for the whole pass, and memory stays flat: parsed labels live for one chunk.

    What keeps this correct without holding the lock while files are read:

    * a save that lands between reading a file and storing its chunk wins: rows updated after the chunk
      started are left alone (the save stored fresh counts);
    * a class change in that window makes the chunk start over: the class epoch (label files rewritten) and the
      project's class versions are compared under the lock before anything is stored.
    """

    def __init__(self, ctx: AppContext, project_id: int, *, discover_classes: bool, record_activity: bool) -> None:
        self.ctx = ctx
        self.project_id = project_id
        self.discover_classes = discover_classes
        self.record_activity = record_activity
        self._last_progress = 0.0
        #: Classes are created from the names found in VOC/COCO label files while the pass runs.
        self._discovering = False
        self._discovered = False

    def _progress(self, done: int, total: int, finished: bool = False) -> None:
        self.ctx.progress[self.project_id] = IndexProgress(done, total)
        now = time.monotonic()
        if not finished and now - self._last_progress < PROGRESS_INTERVAL and done not in (0, total):
            return
        self._last_progress = now
        self.ctx.send_project(self.project_id, {
            "type": "project.indexing", "project_id": self.project_id, "done": done, "total": total,
            "finished": finished,
        })

    def run(self) -> None:
        try:
            self._run()
        finally:
            self.ctx.progress.pop(self.project_id, None)
        if not self.ctx.jobs.stopping.is_set():
            self.ctx.db.optimize()  # the tables just changed a lot: refresh the planner's statistics

    def _run(self) -> None:
        ctx = self.ctx
        with ctx.db.session() as session:
            project = session.get(Project, self.project_id)
            if project is None:
                return
            paths = ProjectPaths(ctx.settings, project)
            recursive = project.recursive
            fmt = project.label_format
            pre_ids = set(session.scalars(select(Image.id).where(Image.project_id == self.project_id)))
        try:
            paths.check()
        except ApiError:
            log.warning("Project %s: folder is outside the configured roots; not indexed", self.project_id)
            self._progress(0, 0, finished=True)
            return
        try:
            result = scan(paths.image_root, recursive)
        except OSError as exc:
            log.warning("Project %s: cannot read %s (%s); index left unchanged", self.project_id,
                        paths.image_root, exc)
            self._progress(0, 0, finished=True)
            return
        rel_paths = result.paths
        total = len(rel_paths)
        self._progress(0, total)
        if self.discover_classes and not self._prepare_discovery(paths):
            return

        lister = LabelLister(paths)
        label_keys = [label_key(rel) for rel in rel_paths]
        owners = label_owners(rel_paths, label_keys, fmt)
        added = 0
        complete = True
        for start in range(0, total, BATCH):
            keys = dict(zip(rel_paths[start:start + BATCH], label_keys[start:start + BATCH], strict=True))
            stored = self._chunk(paths, lister, owners, keys, start, total)
            if stored is None:
                return  # stopping, or the project is gone
            if stored < 0:
                complete = False
                break
            added += stored
        if complete:
            if self._finish(paths, rel_paths, tuple(result.unreadable), pre_ids, added) is None:
                return
        else:
            log.warning("Project %s: classes kept changing during indexing; try a rescan", self.project_id)
        self._progress(total, total, finished=True)
        ctx.send_project(self.project_id, {"type": "images.bulk_updated", "project_id": self.project_id,
                                           "count": total})
        ctx.send_project(self.project_id, {"type": "project.updated", "project_id": self.project_id})

    # ------------------------------------------------------------------ classes found in the files

    def _prepare_discovery(self, paths: ProjectPaths) -> bool:
        """A project without classes gets them from ``classes.txt`` or, for VOC/COCO, from its label files.

        Returns False when the pass must stop (shutting down, project deleted).
        """
        ctx = self.ctx
        with ctx.quiet_label_lock(self.project_id), ctx.db.session() as session:
            project = session.get(Project, self.project_id)
            if project is None or ctx.jobs.stopping.is_set():
                return False
            if session.scalar(select(ProjectClass.id).where(ProjectClass.project_id == project.id).limit(1)):
                return True
            try:
                names = read_classes(paths.classes_file()) or []
            except OutsideRootError:
                log.warning("Project %s: classes.txt resolves outside the label folder; ignored", project.id)
                names = []
            if names:
                self._add_classes(session, project, names)
                session.commit()
            elif not uses_class_index(project.label_format):
                self._discovering = True  # names are collected chunk by chunk, in the order they first appear
        return True

    def _add_classes(self, session: Session, project: Project, names: list[str]) -> bool:
        """Append the names that are not classes yet; True when at least one was added."""
        existing = list(session.scalars(select(ProjectClass).where(ProjectClass.project_id == project.id)
                                        .order_by(ProjectClass.position, ProjectClass.id)))
        known = {c.name for c in existing}
        colors = [c.color for c in existing]
        position = len(existing)
        for name in dict.fromkeys(n[:100] for n in names):
            if name in known:
                continue
            known.add(name)
            color = next_color(colors)
            colors.append(color)
            session.add(ProjectClass(project_id=project.id, position=position, name=name, color=color))
            position += 1
        if position == len(existing):
            return False
        bump_class_version(project)
        session.flush()
        return True

    def _discover(self, session: Session, project: Project, parsed: dict[str, ParsedLabel]) -> None:
        """Create the classes named in this chunk's VOC/COCO label files that do not exist yet."""
        seen: dict[str, None] = {}
        for item in parsed.values():
            for name in [*item.categories, *item.labels]:
                if name and "\n" not in name:
                    seen.setdefault(name.strip(), None)
        if self._add_classes(session, project, [n for n in seen if n]):
            self._discovered = True

    # ------------------------------------------------------------------ one chunk

    def _rows(self, session: Session, chunk: list[str]) -> dict[str, Any]:
        return {r.rel_path: r for r in session.connection().execute(
            select(*_ROW_COLUMNS).where(Image.project_id == self.project_id, Image.rel_path.in_(chunk)))}

    def _chunk(self, paths: ProjectPaths, lister: LabelLister, owners: dict[str, str], keys: dict[str, str],
               start: int, total: int) -> int | None:
        """Read and store one chunk (``keys``: ``rel path -> label key`` of its images, in list order).

        Returns the number of new images, -1 after too many attempts, or None when the pass must stop.
        """
        ctx, project_id = self.ctx, self.project_id
        fmt = paths.project.label_format
        chunk = list(keys)
        for _attempt in range(MAX_ATTEMPTS):
            if ctx.jobs.stopping.is_set():
                return None
            started = utcnow()
            epoch = ctx.class_epoch(project_id)
            with ctx.db.session() as session:
                versions = session.execute(select(Project.class_version, Project.class_floor)
                                           .where(Project.id == project_id)).first()
                if versions is None:
                    return None
                known = self._rows(session, chunk)
            version, floor = versions
            #: Label of every image that owns a label file and whose stored counts cannot be reused.
            parsed: dict[str, ParsedLabel] = {}
            #: Images whose label file is unchanged: their rows keep their counts.
            unchanged: set[str] = set()
            for n, (rel, key) in enumerate(keys.items(), start=1):
                if n % 256 == 0:
                    if ctx.jobs.stopping.is_set():
                        return None
                    self._progress(start + n, total)
                if owners.get(key) != rel:
                    continue  # shares its label file with an earlier image (or the reserved name): no labels
                found = lister.find(paths.label_rel(rel))
                if found is None:
                    continue
                path, stat = found
                row = known.get(rel)
                if (row is not None and not self._discovering
                        and counts_still_valid(row, key, stat, version, floor)):
                    unchanged.add(rel)
                else:
                    parsed[rel] = parse_label_file(fmt, path, rel)
            with ctx.quiet_label_lock(project_id):
                if ctx.jobs.stopping.is_set():
                    return None
                if ctx.class_epoch(project_id) != epoch:
                    continue  # label files were rewritten while they were read: read them again
                with ctx.db.session() as session:
                    project = session.get(Project, project_id)
                    if project is None or (project.image_dir, project.label_dir) != (
                            paths.project.image_dir, paths.project.label_dir):
                        return None  # gone, or its folders changed: the pass that was queued for that takes over
                    if (project.class_version, project.class_floor) != (version, floor):
                        continue  # the class list changed since the decision to reuse counts was made
                    if self._discovering:
                        self._discover(session, project, parsed)
                    table = load_class_table(session, project_id, project.label_format)
                    try:
                        added = self._store(session, project, keys, parsed, unchanged, table, started)
                    except _RetryChunkError:
                        continue
                    session.commit()
            self._progress(start + len(chunk), total)
            return added
        return -1

    def _store(self, session: Session, project: Project, keys: dict[str, str], parsed: dict[str, ParsedLabel],
               unchanged: set[str], table: ClassTable, started: datetime) -> int:
        """Bring the rows of one chunk in line with what was read (the caller holds the label lock).

        ``keys``: ``rel path -> label key`` of the chunk's images, in list order.
        """
        chunk = list(keys)
        existing = self._rows(session, chunk)
        compared = [existing[rel].id for rel in chunk if rel in existing and rel not in unchanged]
        old_counts: dict[int, dict[int, int]] = {}
        if compared:
            for image_id, class_id, n in session.execute(
                select(ImageClassCount.image_id, ImageClassCount.class_id, ImageClassCount.count)
                .where(ImageClassCount.image_id.in_(compared))
            ):
                old_counts.setdefault(image_id, {})[class_id] = n

        new_rows: list[dict] = []
        new_counts: dict[str, dict[int, int]] = {}
        updates: list[dict] = []
        revived: list[int] = []
        count_changes: dict[int, dict[int, int]] = {}
        nothing = _no_label()
        for rel, key in keys.items():
            row = existing.get(rel)
            if rel in unchanged:
                if row is None:
                    raise _RetryChunkError  # removed (pruned) since its file was looked at
                if row.missing:
                    revived.append(row.id)
                continue
            item = parsed.get(rel, nothing)
            per_class, unknown, boxes = counts_for(table, item)
            size, mtime_ns = item.stat if item.stat is not None else (None, None)
            counted = project.class_version if item.stat is not None else None
            if row is None:
                new_rows.append({
                    "project_id": self.project_id, "rel_path": rel, "filename": posixpath.basename(rel),
                    # Given here (not left to the column default) so that the rows go in as one statement.
                    "label_key": key, "missing": False, "sort_key": natural_sort_key(rel),
                    "status": "done" if item.has_label else "todo",
                    "has_label": item.has_label, "box_count": boxes, "unknown_count": unknown, "flagged": False,
                    "comment_count": 0, "open_comment_count": 0,
                    "label_size": size, "label_mtime_ns": mtime_ns, "counted_version": counted,
                })
                if per_class:
                    new_counts[rel] = per_class
                continue
            if row.updated_at is not None and row.updated_at >= started and not row.missing:
                continue  # saved while we were scanning: the save already stored fresh counts
            if ((row.has_label, row.box_count, row.unknown_count, row.label_key, row.missing, row.label_size,
                 row.label_mtime_ns, row.counted_version)
                    != (item.has_label, boxes, unknown, key, False, size, mtime_ns, counted)):
                updates.append({"_id": row.id, "_has": item.has_label, "_boxes": boxes, "_unknown": unknown,
                                "_key": key, "_size": size, "_mtime": mtime_ns, "_counted": counted})
            if old_counts.get(row.id, {}) != per_class:
                count_changes[row.id] = per_class

        if new_rows:
            # render_nulls: rows with and without a label file keep the same columns, so they go in one batch
            ids = session.execute(insert(Image).returning(Image.id, Image.rel_path)
                                  .execution_options(render_nulls=True), new_rows).all()
            counts = [{"image_id": image_id, "class_id": cid, "count": n}
                      for image_id, rel in ids for cid, n in new_counts.get(rel, {}).items()]
            if counts:
                session.execute(insert(ImageClassCount), counts)
        if revived:
            session.execute(update(Image).where(Image.id.in_(revived)).values(missing=False)
                            .execution_options(synchronize_session=False))
        if updates:
            stmt = (update(Image).where(Image.id == bindparam("_id"))
                    .values(has_label=bindparam("_has"), box_count=bindparam("_boxes"),
                            unknown_count=bindparam("_unknown"), label_key=bindparam("_key"), missing=False,
                            label_size=bindparam("_size"), label_mtime_ns=bindparam("_mtime"),
                            counted_version=bindparam("_counted")))
            session.connection().execute(stmt, updates)
        for image_id, per_class in count_changes.items():
            replace_class_counts(session, image_id, per_class)
        return len(new_rows)

    # ------------------------------------------------------------------ after the last chunk

    def _finish(self, paths: ProjectPaths, rel_paths: list[str], unreadable: tuple[str, ...], pre_ids: set[int],
                added: int) -> int | None:
        """Mark the images whose files are gone, stamp the project and record the pass; None when stopping."""
        ctx = self.ctx
        on_disk = set(rel_paths)
        with ctx.quiet_label_lock(self.project_id):
            if ctx.jobs.stopping.is_set():
                return None
            with ctx.db.session() as session:
                project = session.get(Project, self.project_id)
                if project is None:
                    return None
                rows = session.execute(
                    select(Image.id, Image.rel_path)
                    .where(Image.project_id == self.project_id, Image.missing.is_(False))
                    .execution_options(yield_per=BATCH))
                stale = [image_id for image_id, rel in rows
                         if rel not in on_disk and image_id in pre_ids
                         and not (unreadable and rel.startswith(unreadable))]
                if not rel_paths and stale:
                    # e.g. an unmounted network share: never wipe comments, revisions and statuses
                    log.warning("Project %s: the image folder looks empty; keeping %d indexed images",
                                self.project_id, len(stale))
                    stale = []
                for start in range(0, len(stale), BATCH):
                    # Soft delete: comments, revisions and workflow state survive a temporarily missing file.
                    session.execute(update(Image).where(Image.id.in_(stale[start:start + BATCH]))
                                    .values(missing=True).execution_options(synchronize_session=False))
                if self._discovered:
                    try:
                        sync_classes_file(paths, load_class_table(session, project.id, project.label_format))
                    except OSError:
                        log.warning("Could not write classes.txt for project %s", project.id)
                project.indexed_at = utcnow()
                if self.record_activity:
                    notify.record(session, self.project_id, "rescanned", user=None,
                                  data={"added": added, "removed": len(stale), "total": len(rel_paths)})
                session.commit()
        return len(stale)


def index_project(ctx: AppContext, project_id: int, *, discover_classes: bool = False,
                  record_activity: bool = False) -> bool:
    """Schedule a background index of the project; returns False when one is already queued."""
    indexer = Indexer(ctx, project_id, discover_classes=discover_classes, record_activity=record_activity)
    return ctx.jobs.submit(("index", project_id), indexer.run, coalesce=True)


def recount_images(ctx: AppContext, project_id: int, image_ids: list[int]) -> None:
    """Re-parse some label files and refresh their counts (after the class list changed)."""
    for start in range(0, len(image_ids), BATCH):
        if ctx.jobs.stopping.is_set():
            return
        chunk = image_ids[start:start + BATCH]
        with ctx.quiet_label_lock(project_id), ctx.db.session() as session:
            project = session.get(Project, project_id)
            if project is None or ctx.jobs.stopping.is_set():
                return
            paths = ProjectPaths(ctx.settings, project)
            try:
                paths.check()
            except ApiError:
                return
            table = load_class_table(session, project_id, project.label_format)
            for image in session.scalars(select(Image).where(Image.id.in_(chunk))):
                item = parse_for_index(paths, image.rel_path)
                per_class, unknown, boxes = counts_for(table, item)
                image.has_label, image.box_count, image.unknown_count = item.has_label, boxes, unknown
                set_label_state(image, item.stat, project.class_version)
                replace_class_counts(session, image.id, per_class)
            session.commit()
    ctx.send_project(project_id, {"type": "images.bulk_updated", "project_id": project_id, "count": len(image_ids)})


def schedule_unknown_recount(ctx: AppContext, session: Session, project_id: int) -> None:
    """After a class was added, images with unknown labels may now match it."""
    ids = list(session.scalars(select(Image.id).where(Image.project_id == project_id, Image.unknown_count > 0)))
    if ids:
        ctx.jobs.submit(("recount", project_id), lambda: recount_images(ctx, project_id, ids), coalesce=True)
