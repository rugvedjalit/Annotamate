"""Background indexing: scan a project's folder, parse existing label files, sync the image table."""

from __future__ import annotations

import logging
import os
import posixpath
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import bindparam, delete, insert, select, update
from sqlalchemy.orm import Session

from annotamate.core.classes import next_color, read_classes
from annotamate.core.formats import parse_label, uses_class_index
from annotamate.core.fsutil import OutsideRootError, is_inside, resolve_inside
from annotamate.core.scanning import ScanResult, natural_key, scan
from annotamate.server.context import AppContext, IndexProgress
from annotamate.server.errors import ApiError
from annotamate.server.models import Image, ImageClassCount, Project, ProjectClass, utcnow
from annotamate.server.services import notify
from annotamate.server.services.labels import ClassTable, load_class_table, sync_classes_file
from annotamate.server.services.paths import ProjectPaths

log = logging.getLogger("annotamate.indexing")

BATCH = 1000
MAX_ATTEMPTS = 3
PROGRESS_INTERVAL = 0.5
_NORM = str.lower if os.name == "nt" else str


@dataclass
class ParsedLabel:
    has_label: bool
    labels: Counter
    categories: list[str]


class LabelLister:
    """Finds label files with one directory listing per folder (no per-file ``realpath``).

    A folder is checked against the label root once; only entries that are symlinks are resolved
    individually, so a link pointing outside the project is still never read.
    """

    def __init__(self, paths: ProjectPaths) -> None:
        self.paths = paths
        self._folders: dict[str, tuple[str, dict[str, bool]] | None] = {}

    def _folder(self, folder: str) -> tuple[str, dict[str, bool]] | None:
        if folder in self._folders:
            return self._folders[folder]
        root = self.paths.label_root
        directory = os.path.join(root, *folder.split("/")) if folder else root
        entry: tuple[str, dict[str, bool]] | None = None
        if is_inside(root, directory):
            try:
                with os.scandir(directory) as it:
                    entry = (directory, {_NORM(e.name): e.is_symlink() for e in it})
            except OSError:
                entry = None
        self._folders[folder] = entry
        return entry

    def path(self, label_rel: str) -> str | None:
        """Path of an existing, safe label file, or None."""
        folder, name = posixpath.split(label_rel)
        found = self._folder(folder)
        if found is None:
            return None
        directory, listing = found
        is_link = listing.get(_NORM(name))
        if is_link is None:
            return None
        path = os.path.join(directory, name)
        if is_link:
            try:
                return resolve_inside(self.paths.label_root, path)
            except OutsideRootError:
                return None
        return path


def parse_for_index(paths: ProjectPaths, rel_path: str, lister: LabelLister | None = None) -> ParsedLabel:
    """Label names (with counts) found in an image's label file; YOLO values stay normalised."""
    try:
        path = lister.path(paths.label_rel(rel_path)) if lister is not None else paths.label_file(rel_path)
        if path is None:
            return ParsedLabel(False, Counter(), [])
        with open(path, "rb") as fh:
            data = fh.read()
    except (OSError, OutsideRootError):
        return ParsedLabel(False, Counter(), [])
    result = parse_label(paths.project.label_format, data)
    return ParsedLabel(True, Counter(b.label for b in result.boxes), result.categories)


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


def renumber(session: Session, project_id: int) -> None:
    """Make ``sort_index`` the 0-based natural-sort position of every image in the project."""
    rows = session.execute(select(Image.id, Image.rel_path, Image.sort_index).where(Image.project_id == project_id))
    ordered = sorted(rows, key=lambda r: natural_key(r.rel_path))
    changes = [{"_id": r.id, "_pos": pos} for pos, r in enumerate(ordered) if r.sort_index != pos]
    stmt = update(Image).where(Image.id == bindparam("_id")).values(sort_index=bindparam("_pos"))
    for start in range(0, len(changes), BATCH):
        session.connection().execute(stmt, changes[start:start + BATCH])


def replace_class_counts(session: Session, image_id: int, per_class: dict[int, int]) -> None:
    session.execute(delete(ImageClassCount).where(ImageClassCount.image_id == image_id))
    if per_class:
        session.execute(insert(ImageClassCount), [
            {"image_id": image_id, "class_id": cid, "count": n} for cid, n in per_class.items()
        ])


class Indexer:
    def __init__(self, ctx: AppContext, project_id: int, *, discover_classes: bool, record_activity: bool) -> None:
        self.ctx = ctx
        self.project_id = project_id
        self.discover_classes = discover_classes
        self.record_activity = record_activity
        self._last_progress = 0.0

    def _progress(self, done: int, total: int, finished: bool = False) -> None:
        self.ctx.progress[self.project_id] = IndexProgress(done, total)
        now = time.monotonic()
        if not finished and now - self._last_progress < PROGRESS_INTERVAL and done not in (0, total):
            return
        self._last_progress = now
        self.ctx.hub.send_project(self.project_id, {
            "type": "project.indexing", "project_id": self.project_id, "done": done, "total": total,
            "finished": finished,
        })

    def run(self) -> None:
        try:
            self._run()
        finally:
            self.ctx.progress.pop(self.project_id, None)

    def _scan(self, paths: ProjectPaths, recursive: bool) -> tuple[ScanResult, dict[str, ParsedLabel]] | None:
        """List the images and parse their label files (no locks held); None when interrupted."""
        result = scan(paths.image_root, recursive)
        total = len(result.paths)
        self._progress(0, total)
        lister = LabelLister(paths)
        parsed: dict[str, ParsedLabel] = {}
        for n, rel in enumerate(result.paths, start=1):
            if n % 256 == 0 and self.ctx.jobs.stopping.is_set():
                return None
            parsed[rel] = parse_for_index(paths, rel, lister)
            self._progress(n, total)
        return result, parsed

    def _run(self) -> None:
        ctx = self.ctx
        with ctx.db.session() as session:
            project = session.get(Project, self.project_id)
            if project is None:
                return
            paths = ProjectPaths(ctx.settings, project)
            recursive = project.recursive
            pre_ids = set(session.scalars(select(Image.id).where(Image.project_id == self.project_id)))
        try:
            paths.check()
        except ApiError:
            log.warning("Project %s: folder is outside the configured roots; not indexed", self.project_id)
            self._progress(0, 0, finished=True)
            return

        total = 0
        for _attempt in range(MAX_ATTEMPTS):
            started = utcnow()
            epoch = ctx.class_epoch(self.project_id)
            try:
                scanned = self._scan(paths, recursive)
            except OSError as exc:
                log.warning("Project %s: cannot read %s (%s); index left unchanged", self.project_id,
                            paths.image_root, exc)
                self._progress(0, 0, finished=True)
                return
            if scanned is None:
                return
            result, parsed = scanned
            total = len(result.paths)
            with ctx.label_locks(self.project_id):
                if ctx.class_epoch(self.project_id) != epoch:
                    continue  # classes were migrated while the files were read: read them again
                with ctx.db.session() as session:
                    project = session.get(Project, self.project_id)
                    if project is None:
                        return
                    if self.discover_classes:
                        self._discover(session, project, paths, result.paths, parsed)
                    table = load_class_table(session, self.project_id, project.label_format)
                    added, removed = self._sync(session, result, parsed, table, pre_ids, started)
                    renumber(session, self.project_id)
                    project.indexed_at = utcnow()
                    if self.record_activity:
                        notify.record(session, self.project_id, "rescanned", user=None,
                                      data={"added": added, "removed": removed, "total": total})
                    session.commit()
            break
        else:
            log.warning("Project %s: classes kept changing during indexing; try a rescan", self.project_id)
        self._progress(total, total, finished=True)
        ctx.hub.send_project(self.project_id, {"type": "images.bulk_updated", "project_id": self.project_id,
                                               "count": total})
        ctx.hub.send_project(self.project_id, {"type": "project.updated", "project_id": self.project_id})

    def _discover(self, session: Session, project: Project, paths: ProjectPaths, rel_paths: list[str],
                  parsed: dict[str, ParsedLabel]) -> None:
        """Create classes from ``classes.txt`` or, for VOC/COCO, from the label files themselves."""
        if session.scalar(select(ProjectClass.id).where(ProjectClass.project_id == project.id).limit(1)):
            return
        names = read_classes(paths.classes_file()) or []
        from_file = bool(names)
        if not names and not uses_class_index(project.label_format):
            seen: dict[str, None] = {}
            for rel in rel_paths:
                item = parsed[rel]
                for name in [*item.categories, *item.labels]:
                    if name and "\n" not in name:
                        seen.setdefault(name.strip(), None)
            names = [n for n in seen if n]
        colors: list[str] = []
        for position, name in enumerate(dict.fromkeys(names)):
            color = next_color(colors)
            colors.append(color)
            session.add(ProjectClass(project_id=project.id, position=position, name=name[:100], color=color))
        session.flush()
        if names and not from_file:
            table = load_class_table(session, project.id, project.label_format)
            try:
                sync_classes_file(paths, table)
            except OSError:
                log.warning("Could not write %s", paths.classes_file())

    def _sync(self, session: Session, result: ScanResult, parsed: dict[str, ParsedLabel], table: ClassTable,
              pre_ids: set[int], started: datetime) -> tuple[int, int]:
        rel_paths = result.paths
        existing = {
            r.rel_path: r for r in session.execute(
                select(Image.id, Image.rel_path, Image.status, Image.has_label, Image.box_count, Image.unknown_count,
                       Image.updated_at).where(Image.project_id == self.project_id)
            )
        }
        old_counts: dict[int, dict[int, int]] = {}
        for image_id, class_id, n in session.execute(
            select(ImageClassCount.image_id, ImageClassCount.class_id, ImageClassCount.count)
            .join(Image, Image.id == ImageClassCount.image_id).where(Image.project_id == self.project_id)
        ):
            old_counts.setdefault(image_id, {})[class_id] = n

        new_rows: list[dict] = []
        new_counts: dict[str, dict[int, int]] = {}
        updates: list[dict] = []
        now_done: list[int] = []
        count_changes: dict[int, dict[int, int]] = {}
        for position, rel in enumerate(rel_paths):
            item = parsed[rel]
            per_class, unknown, boxes = counts_for(table, item)
            row = existing.get(rel)
            if row is None:
                new_rows.append({
                    "project_id": self.project_id, "rel_path": rel, "filename": posixpath.basename(rel),
                    "sort_index": position, "status": "done" if item.has_label else "todo",
                    "has_label": item.has_label, "box_count": boxes, "unknown_count": unknown, "flagged": False,
                    "comment_count": 0, "open_comment_count": 0,
                })
                if per_class:
                    new_counts[rel] = per_class
                continue
            if row.updated_at is not None and row.updated_at >= started:
                continue  # saved while we were scanning: the save already stored fresh counts
            if (row.has_label, row.box_count, row.unknown_count) != (item.has_label, boxes, unknown):
                updates.append({"_id": row.id, "_has": item.has_label, "_boxes": boxes, "_unknown": unknown})
            if row.status == "todo" and item.has_label:
                now_done.append(row.id)
            if old_counts.get(row.id, {}) != per_class:
                count_changes[row.id] = per_class

        on_disk = set(rel_paths)
        unreadable = tuple(result.unreadable)
        stale = [r.id for rel, r in existing.items()
                 if rel not in on_disk and r.id in pre_ids and not (unreadable and rel.startswith(unreadable))]
        if not rel_paths and stale:
            # e.g. an unmounted network share: never wipe comments, revisions and statuses
            log.warning("Project %s: the image folder looks empty; keeping %d indexed images", self.project_id,
                        len(stale))
            stale = []
        for start in range(0, len(stale), BATCH):
            session.execute(delete(Image).where(Image.id.in_(stale[start:start + BATCH])))

        for start in range(0, len(new_rows), BATCH):
            chunk = new_rows[start:start + BATCH]
            ids = session.execute(insert(Image).returning(Image.id, Image.rel_path), chunk).all()
            counts = [{"image_id": image_id, "class_id": cid, "count": n}
                      for image_id, rel in ids for cid, n in new_counts.get(rel, {}).items()]
            if counts:
                session.execute(insert(ImageClassCount), counts)
            session.flush()

        if updates:
            stmt = (update(Image).where(Image.id == bindparam("_id"))
                    .values(has_label=bindparam("_has"), box_count=bindparam("_boxes"),
                            unknown_count=bindparam("_unknown")))
            for start in range(0, len(updates), BATCH):
                session.connection().execute(stmt, updates[start:start + BATCH])
        for start in range(0, len(now_done), BATCH):
            # conditional, so a status change committed since the rows were read is never overwritten
            session.execute(update(Image).where(Image.id.in_(now_done[start:start + BATCH]), Image.status == "todo")
                            .values(status="done").execution_options(synchronize_session=False))
        for image_id, per_class in count_changes.items():
            replace_class_counts(session, image_id, per_class)
        return len(new_rows), len(stale)


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
        with ctx.label_locks(project_id), ctx.db.session() as session:
            project = session.get(Project, project_id)
            if project is None:
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
                replace_class_counts(session, image.id, per_class)
            session.commit()
    ctx.hub.send_project(project_id, {"type": "images.bulk_updated", "project_id": project_id,
                                      "count": len(image_ids)})


def schedule_unknown_recount(ctx: AppContext, session: Session, project_id: int) -> None:
    """After a class was added, images with unknown labels may now match it."""
    ids = list(session.scalars(select(Image.id).where(Image.project_id == project_id, Image.unknown_count > 0)))
    if ids:
        ctx.jobs.submit(("recount", project_id), lambda: recount_images(ctx, project_id, ids), coalesce=True)
