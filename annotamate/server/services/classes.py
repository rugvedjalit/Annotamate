"""Class list changes and the label-file migrations they require.

Every change takes the project's label lock, so class positions (= YOLO indexes) can never be
assigned twice and no annotation save interleaves with a migration. Deleting or merging a class rewrites
label files in a background job (``ClassDeleteJob``); while it runs the project is "migrating" and every
other change to its labels and classes is refused with ``409 migrating``.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import Counter

from sqlalchemy import bindparam, case, delete, func, insert, select, update
from sqlalchemy.orm import Session

from annotamate.core.classes import next_color
from annotamate.core.formats import parse_label, relabel, uses_class_index
from annotamate.core.fsutil import StagedRewrite, atomic_write
from annotamate.server.context import AppContext, ClassMigration
from annotamate.server.db import emit
from annotamate.server.errors import ApiError, bad_request, conflict, not_found
from annotamate.server.models import Image, ImageClassCount, PendingRename, Project, ProjectClass, User
from annotamate.server.schemas import INVISIBLE_CHARS
from annotamate.server.services import notify, serialize
from annotamate.server.services.access import ProjectAccess
from annotamate.server.services.indexing import (
    LabelLister,
    ParsedLabel,
    counts_for,
    replace_class_counts,
    schedule_unknown_recount,
)
from annotamate.server.services.labels import ClassTable, load_class_table, pending_aliases, sync_classes_file
from annotamate.server.services.paths import RESERVED_YOLO_KEY, ProjectPaths, fold_case, label_key

log = logging.getLogger("annotamate.classes")

BATCH = 500
#: Seconds between two progress events of a class migration.
PROGRESS_INTERVAL = 0.5


def clean_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise bad_request("Class name is required.")
    if len(name) > 100:
        raise bad_request("Class names are at most 100 characters.")
    if any(ord(ch) < 32 or ch == "\x7f" or ch in INVISIBLE_CHARS for ch in name):
        raise bad_request("Class names cannot contain line breaks, control characters or invisible formatting "
                          "characters.")
    return name


def get_class(session: Session, project_id: int, class_id: int) -> ProjectClass:
    cls = session.get(ProjectClass, class_id)
    if cls is None or cls.project_id != project_id:
        raise not_found("Class not found.")
    return cls


def _refuse_while_indexing(ctx: AppContext, project_id: int) -> None:
    if ctx.is_indexing(project_id):
        raise conflict("conflict", "The project is being indexed. Try again when indexing has finished.")


def _refuse_while_recounting(ctx: AppContext, project_id: int) -> None:
    """No other label job of the project may be queued ahead of a class migration.

    Such a job waits for the migration to end (``AppContext.quiet_label_lock``) while it occupies a job
    thread; queued behind it, the migration could be left without a thread to run on.
    """
    if ctx.jobs.is_running(("recount", project_id)) or ctx.jobs.is_running(("rename", project_id)):
        raise conflict("conflict", "The label counts of the project are being refreshed. Try again in a moment.")


def _refuse_while_renaming(session: Session, project_id: int) -> None:
    if has_pending_renames(session, project_id):
        raise conflict("conflict", "A class rename is still being applied to the label files. "
                                   "Try again in a moment.")


def _after_change(ctx: AppContext, session: Session, project: Project) -> ClassTable:
    """Keep ``classes.txt`` in sync and queue the ``classes.updated`` broadcast."""
    session.flush()
    table = load_class_table(session, project.id, project.label_format)
    paths = ProjectPaths(ctx.settings, project)
    try:
        paths.check()
        sync_classes_file(paths, table)
    except (OSError, ApiError) as exc:
        log.warning("Could not update classes.txt for project %s: %s", project.id, exc)
    emit(session, ("project", project.id), {
        "type": "classes.updated", "project_id": project.id, "classes": [serialize.class_out(c) for c in table.classes],
    })
    return table


def add_class(ctx: AppContext, session: Session, access: ProjectAccess, name: str, color: str | None) -> ProjectClass:
    project = access.project
    name = clean_name(name)
    with ctx.label_locks(project.id):
        ctx.refuse_while_migrating(project.id)
        existing = list(session.scalars(select(ProjectClass).where(ProjectClass.project_id == project.id)))
        if any(c.name == name for c in existing):
            raise conflict("exists", f"A class named '{name}' already exists.")
        _refuse_reused_name(session, project, name)
        cls = ProjectClass(project_id=project.id, position=len(existing), name=name,
                           color=(color or next_color([c.color for c in existing])).lower())
        session.add(cls)
        session.flush()
        _after_change(ctx, session, project)
        notify.record(session, project.id, "class_added", user=access.user,
                      data={"class_id": cls.id, "name": cls.name, "color": cls.color})
        session.commit()
    schedule_unknown_recount(ctx, session, project.id)
    return cls


def update_class(ctx: AppContext, session: Session, access: ProjectAccess, cls: ProjectClass, *,
                 name: str | None, color: str | None) -> ProjectClass:
    project = access.project
    with ctx.label_locks(project.id):
        ctx.refuse_while_migrating(project.id)
        session.refresh(cls)
        old_name = cls.name
        changes: dict[str, object] = {}
        if name is not None:
            name = clean_name(name)
            if name != cls.name:
                clash = session.scalar(select(ProjectClass.id).where(
                    ProjectClass.project_id == project.id, ProjectClass.name == name, ProjectClass.id != cls.id))
                if clash:
                    raise conflict("exists", f"A class named '{name}' already exists.")
                if not uses_class_index(project.label_format):
                    _refuse_while_indexing(ctx, project.id)
                    _refuse_reused_name(session, project, name)
                    # Persisted with the new name, so an interrupted rewrite is resumed at the next start.
                    session.add(PendingRename(project_id=project.id, old_name=old_name, new_name=name))
                cls.name = name
                changes["name"] = name
                changes["old_name"] = old_name
        if color is not None and color.lower() != cls.color:
            cls.color = color.lower()
            changes["color"] = cls.color
        if not changes:
            return cls
        _after_change(ctx, session, project)
        notify.record(session, project.id, "class_updated", user=access.user,
                      data={"class_id": cls.id, "name": cls.name, **changes})
        if "name" in changes:
            ctx.bump_class_epoch(project.id)
        session.commit()
    if "name" in changes:
        if uses_class_index(project.label_format):
            schedule_unknown_recount(ctx, session, project.id)
        else:
            schedule_rename(ctx, project.id)
    return cls


def _refuse_reused_name(session: Session, project: Project, name: str) -> None:
    """A name that files may still carry (renamed class, rewrite pending) cannot be given to another class."""
    if name in pending_aliases(session, project.id) and not uses_class_index(project.label_format):
        raise conflict("conflict", f"'{name}' is the previous name of a class whose rename is still being applied "
                                   "to the label files. Try again in a moment.")


#: Seconds before retrying a rename job that could not rewrite every file (the last value repeats).
RENAME_RETRY_DELAYS: tuple[float, ...] = (30, 120, 600, 1800)


def schedule_rename(ctx: AppContext, project_id: int) -> None:
    """Queue (or resume) the label-file rewrite for the project's pending VOC/COCO renames."""
    ctx.jobs.submit(("rename", project_id), lambda: rename_in_files(ctx, project_id), coalesce=True)


def _retry_rename_later(ctx: AppContext, project_id: int) -> None:
    """Some files could not be rewritten: try again later, backing off (a rescan also retries at once)."""
    attempt = ctx.rename_retries.get(project_id, 0)
    ctx.rename_retries[project_id] = attempt + 1
    delay = RENAME_RETRY_DELAYS[min(attempt, len(RENAME_RETRY_DELAYS) - 1)]

    def fire() -> None:
        if not ctx.jobs.stopping.is_set():
            schedule_rename(ctx, project_id)

    timer = threading.Timer(delay, fire)
    timer.daemon = True
    timer.start()


def has_pending_renames(session: Session, project_id: int) -> bool:
    query = select(PendingRename.id).where(PendingRename.project_id == project_id).limit(1)
    return session.scalar(query) is not None


def resume_renames(ctx: AppContext) -> None:
    """Start-up hook: finish the renames that were interrupted by a restart."""
    with ctx.db.session() as session:
        project_ids = list(session.scalars(select(PendingRename.project_id).distinct()))
    for project_id in project_ids:
        schedule_rename(ctx, project_id)


def _label_files(session: Session, paths: ProjectPaths) -> list[tuple[int, str]]:
    """``(image id, label path)`` of every label file on disk right now.

    Class migrations look at the files themselves (one directory listing per folder), never at
    cached counts or ``has_label``, which can be stale when files are edited outside the app.
    """
    lister = LabelLister(paths)
    rows = session.execute(select(Image.id, Image.rel_path).where(Image.project_id == paths.project.id)
                           .order_by(Image.missing, Image.sort_index, Image.id))
    out = []
    seen: set[str] = set()
    reserved = uses_class_index(paths.project.label_format)
    for image_id, rel_path in rows:
        if reserved and label_key(rel_path) == RESERVED_YOLO_KEY:
            continue  # classes.txt is the class list, never a label file
        path = lister.path(paths.label_rel(rel_path))
        if path is not None and fold_case(path) not in seen:  # images sharing a stem share one file
            seen.add(fold_case(path))
            out.append((image_id, path))
    return out


def _read(path: str) -> bytes | None:
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


def rename_in_files(ctx: AppContext, project_id: int) -> None:
    """Background job: apply the project's pending VOC/COCO class renames to every label file.

    Until it has rewritten every file the renames stay recorded (``pending_renames``): readers map the old
    names onto the renamed classes and a restart resumes the job. Failed files keep the records alive.
    """
    with ctx.db.session() as session:
        project = session.get(Project, project_id)
        if project is None:
            return
        pending = list(session.scalars(select(PendingRename).where(PendingRename.project_id == project_id)
                                       .order_by(PendingRename.id)))
        if not pending:
            return
        last_id = pending[-1].id
        name_map: dict[str, str | None] = dict(pending_aliases(session, project_id))
        images = _label_files(session, ProjectPaths(ctx.settings, project))
    failed = 0
    for start in range(0, len(images), BATCH):
        if ctx.jobs.stopping.is_set():
            return
        chunk = dict(images[start:start + BATCH])
        with ctx.quiet_label_lock(project_id), ctx.db.session() as session:
            project = session.get(Project, project_id)
            if project is None or ctx.jobs.stopping.is_set():
                return
            paths = ProjectPaths(ctx.settings, project)
            try:
                paths.check()
            except ApiError:
                log.warning("Project %s: folder outside the roots; class rename not applied to files", project_id)
                return
            table = load_class_table(session, project_id, project.label_format)
            for image in session.scalars(select(Image).where(Image.id.in_(chunk))):
                path = chunk[image.id]
                data = _read(path)
                if data is None:
                    if os.path.lexists(path):  # unreadable right now (permissions, sharing violation): retry
                        log.warning("Could not read %s; the class rename will be retried", path)
                        failed += 1
                    continue
                try:
                    new, changed = relabel(project.label_format, data, name_map=name_map, class_names=table.names)
                except Exception:  # a malformed file is read-only anyway; it must not stop the job
                    log.warning("Skipping %s: it could not be parsed for the class rename", path, exc_info=True)
                    continue
                if changed:
                    try:
                        atomic_write(path, new)
                    except OSError as exc:
                        log.warning("Could not rewrite %s: %s", path, exc)
                        failed += 1
                        continue
                    _recount(session, table, project.label_format, image, new)
            ctx.bump_class_epoch(project_id)  # an index pass that read these files must read them again
            session.commit()
    if failed:
        log.warning("Project %s: %d label files could not be renamed; the rename stays pending", project_id, failed)
        _retry_rename_later(ctx, project_id)
    else:
        ctx.rename_retries.pop(project_id, None)
        with ctx.db.session() as session:
            session.execute(delete(PendingRename).where(PendingRename.project_id == project_id,
                                                        PendingRename.id <= last_id))
            session.commit()
    ctx.send_project(project_id, {"type": "images.bulk_updated", "project_id": project_id, "count": len(images)})


def _counts(table: ClassTable, fmt: str, data: bytes) -> tuple[dict[int, int], int, int]:
    """``(per class id, unknown boxes, total boxes)`` of a label file's content."""
    result = parse_label(fmt, data)
    return counts_for(table, ParsedLabel(True, Counter(b.label for b in result.boxes), result.categories))


def _recount(session: Session, table: ClassTable, fmt: str, image: Image, data: bytes) -> None:
    per_class, unknown, boxes = _counts(table, fmt, data)
    image.has_label, image.box_count, image.unknown_count = True, boxes, unknown
    replace_class_counts(session, image.id, per_class)


# ------------------------------------------------------------------------------------- delete / merge


class MigrationFailedError(Exception):
    """A class delete/merge stopped; the label files are as they were before (unless ``code`` says otherwise)."""

    def __init__(self, code: str, detail: str, **extra: object) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.extra = extra


def _in_use_message(name: str, in_use: int, in_use_missing: int) -> str:
    hint = (f" {in_use_missing} of them are missing from the image folder; restore their files or remove "
            "them in the project settings.") if in_use_missing else ""
    return f"{in_use} images still use '{name}'.{hint}"


def _indexed_use(session: Session, class_id: int) -> tuple[int, int]:
    """``(images, of which missing)`` that use the class according to the index (no file is read)."""
    row = session.execute(
        select(func.count(), func.coalesce(func.sum(case((Image.missing.is_(True), 1), else_=0)), 0))
        .select_from(ImageClassCount).join(Image, Image.id == ImageClassCount.image_id)
        .where(ImageClassCount.class_id == class_id)
    ).one()
    return int(row[0] or 0), int(row[1] or 0)


def start_delete(ctx: AppContext, session: Session, access: ProjectAccess, cls: ProjectClass, *, strategy: str,
                 merge_into: int | None) -> None:
    """Check a class delete and start the background job that carries it out (:class:`ClassDeleteJob`).

    Everything that can be refused cheaply is refused here: an unknown merge target, a project that is being
    indexed or migrated, and (``forbid``) a class the index knows to be in use. The label files themselves are
    read by the job, which verifies the rest (the index can lag behind files edited outside the app).

    From here until the job ends the project is "migrating": every write to its labels and classes gets
    ``409 migrating`` (see ``AppContext.refuse_while_migrating``) while reads keep working.
    """
    project = access.project
    target: ProjectClass | None = None
    if strategy == "merge":
        if merge_into is None:
            raise bad_request("merge_into is required for the merge strategy.")
        if merge_into == cls.id:
            raise bad_request("A class cannot be merged into itself.")
        target = get_class(session, project.id, merge_into)
    elif strategy not in ("forbid", "delete_boxes"):
        raise bad_request("strategy must be forbid, delete_boxes or merge.")

    with ctx.label_locks(project.id):
        ctx.refuse_while_migrating(project.id)
        _refuse_while_indexing(ctx, project.id)
        _refuse_while_renaming(session, project.id)
        _refuse_while_recounting(ctx, project.id)
        ProjectPaths(ctx.settings, project).check()
        if session.scalar(select(ProjectClass.id).where(ProjectClass.id == cls.id)) is None:
            raise not_found("Class not found.")  # deleted by a job that finished a moment ago
        if strategy == "forbid":
            in_use, in_use_missing = _indexed_use(session, cls.id)
            if in_use:
                raise conflict("in_use", _in_use_message(cls.name, in_use, in_use_missing), images=in_use)
        migration = ClassMigration("merge" if target is not None else "delete", cls.name)
        ctx.begin_migration(project.id, migration)
    job = ClassDeleteJob(ctx, project.id, cls.id, strategy, target.id if target is not None else None,
                         access.user.id, migration)
    job.announce()
    if not ctx.jobs.submit(("classes", project.id), job.run):
        with ctx.label_locks(project.id):
            ctx.migrations.pop(project.id, None)
        job.announce(finished=True, error="The server is shutting down. Nothing was changed.", code="interrupted")
        raise ApiError(503, "busy", "The server is shutting down. Try again in a moment.")


class ClassDeleteJob:
    """Background job: delete a class (or merge it into another one), rewriting the label files that need it.

    1. Every label file is read (cached counts may be stale) and its new content is staged next to it, in
       batches (``StagedRewrite``): the originals stay untouched, so reads keep working and memory stays flat.
    2. The staged files replace the originals; each original is kept as a backup until the end.
    3. The database change (class removed, positions closed up, counts of the affected images, activity entry)
       is committed in one transaction, then the backups go.

    Any failure before the commit restores every file; a crash is undone at the next start from the journal.
    No request waits for the job and it does not hold the label lock while it works: writers are turned away
    by the project's migration flag instead, which is cleared when the job ends, whatever the outcome.
    """

    def __init__(self, ctx: AppContext, project_id: int, class_id: int, strategy: str, target_id: int | None,
                 user_id: int, migration: ClassMigration) -> None:
        self.ctx = ctx
        self.project_id = project_id
        self.class_id = class_id
        self.strategy = strategy
        self.target_id = target_id
        self.user_id = user_id
        self.migration = migration
        self._last_progress = time.monotonic()

    def announce(self, finished: bool = False, **extra: object) -> None:
        self.ctx.hub.send_project(self.project_id, {
            "type": "classes.migration", "project_id": self.project_id, **self.migration.out(),
            "finished": finished, **extra,
        })

    def _progress(self, done: int, total: int) -> None:
        self.migration.done, self.migration.total = done, total
        now = time.monotonic()
        if now - self._last_progress >= PROGRESS_INTERVAL:
            self._last_progress = now
            self.announce()

    def _check_stop(self) -> None:
        if self.ctx.jobs.stopping.is_set():
            raise MigrationFailedError("interrupted", "The server is shutting down. Nothing was changed.")

    def run(self) -> None:
        ctx, project_id = self.ctx, self.project_id
        outcome: dict[str, object]
        try:
            outcome = {"rewritten_files": self._run()}
        except MigrationFailedError as exc:
            outcome = {"error": exc.detail, "code": exc.code, **exc.extra}
        except Exception:
            log.exception("Class migration for project %s failed", project_id)
            outcome = {"error": "The class could not be deleted because of an unexpected error. "
                                "Nothing was changed.", "code": "error"}
        finally:
            with ctx.label_locks(project_id):
                if ctx.migrations.get(project_id) is self.migration:
                    del ctx.migrations[project_id]
                ctx.bump_class_epoch(project_id)  # an index pass that read these files must read them again
        if "error" in outcome:
            log.warning("Project %s: class '%s' was not deleted: %s", project_id, self.migration.class_name,
                        outcome["error"])
            if outcome["code"] != "interrupted":
                self._record_failure(outcome)
        self.announce(finished=True, **outcome)
        if outcome.get("rewritten_files"):
            ctx.send_project(project_id, {"type": "images.bulk_updated", "project_id": project_id,
                                          "count": outcome["rewritten_files"]})

    def _run(self) -> int:
        ctx, project_id, strategy = self.ctx, self.project_id, self.strategy
        with ctx.db.session() as session:
            project = session.get(Project, project_id)
            cls = session.get(ProjectClass, self.class_id)
            if project is None or cls is None or cls.project_id != project_id:
                raise MigrationFailedError("not_found", "The class no longer exists.")
            fmt = project.label_format
            paths = ProjectPaths(ctx.settings, project)
            try:
                paths.check()
            except ApiError as exc:
                raise MigrationFailedError("bad_request", str(exc.detail)) from None
            old = load_class_table(session, project_id, fmt).classes
            target = next((c for c in old if c.id == self.target_id), None)
            if self.target_id is not None and target is None:
                raise MigrationFailedError("not_found", "The class to merge into no longer exists.")
            remaining = [c for c in old if c.id != cls.id]
            new_index = {c.id: i for i, c in enumerate(remaining)}
            old_index = next(i for i, c in enumerate(old) if c.id == cls.id)
            if uses_class_index(fmt):
                key = str(old_index)
                index_map: dict[int, int | None] = {i: new_index[c.id] for i, c in enumerate(old)
                                                     if c.id != cls.id and new_index[c.id] != i}
                index_map[old_index] = None if target is None else new_index[target.id]
                name_map: dict[str, str | None] = {}
            else:
                key = cls.name
                index_map = {}
                name_map = {cls.name: None if target is None else target.name}
            new_names = [c.name for c in remaining]
            after = ClassTable(fmt, remaining)  # how labels resolve once the class is gone
            images = _label_files(session, paths)
            missing_ids = set(session.scalars(select(Image.id).where(Image.project_id == project_id,
                                                                     Image.missing.is_(True))))

        # Progress: reading and staging is the first half, replacing the files the second.
        total = max(1, 2 * len(images))
        # The database transaction in _store is the commit point: after a crash, recovery keeps the new files
        # exactly when the class is gone from the database (see app._class_change_committed).
        rewrite = StagedRewrite(str(ctx.settings.journal_dir),
                                meta={"kind": "class_change", "project_id": project_id, "class_id": self.class_id})
        try:
            #: Images that contained the class: ``(per class, unknown, boxes)`` of their new content.
            touched: dict[int, tuple[dict[int, int], int, int]] = {}
            batch: list[tuple[str, bytes]] = []
            in_use = 0
            in_use_missing = 0  # of those, images whose file is gone (their label files are migrated too)
            for n, (image_id, path) in enumerate(images, start=1):
                if n % 64 == 0:
                    self._check_stop()
                data = _read(path)
                if data is None:
                    if not os.path.lexists(path):
                        continue  # deleted since it was listed
                    raise MigrationFailedError("bad_request", f"The label file {os.path.basename(path)} could not "
                                                              "be read. Nothing was changed.")
                uses = any(b.label == key for b in parse_label(fmt, data).boxes)
                in_use += uses
                in_use_missing += uses and image_id in missing_ids
                if not (strategy == "forbid" and in_use):  # else: keep counting, nothing will be written
                    try:
                        new, changed = relabel(fmt, data, index_map=index_map, name_map=name_map,
                                               class_names=new_names)
                        if uses:
                            touched[image_id] = _counts(after, fmt, new)
                    except Exception:
                        log.warning("Could not rewrite %s for a class change", path, exc_info=True)
                        raise MigrationFailedError("bad_request", f"The label file {os.path.basename(path)} could "
                                                                  "not be rewritten. Nothing was changed.") from None
                    if changed:
                        batch.append((path, new))
                        if len(batch) >= BATCH:
                            rewrite.stage(batch)
                            batch = []
                self._progress(n, total)
            if strategy == "forbid" and in_use:
                raise MigrationFailedError("in_use", _in_use_message(self.migration.class_name, in_use,
                                                                     in_use_missing), images=in_use)
            rewrite.stage(batch)
            self._check_stop()
            staged = max(1, rewrite.staged)
            rewrite.commit(lambda done: self._progress(len(images) + done * len(images) // staged, total))
            self._store(touched, rewrite.staged)
        except BaseException as exc:
            failed = rewrite.discard()
            if failed:
                log.error("Class migration for project %s left files in an unknown state: %s", project_id, failed)
                raise MigrationFailedError(
                    "migration_incomplete", "Some label files could not be restored after a failed rewrite. Their "
                    "original content is kept in hidden .bak files next to them.",
                    files=[os.path.basename(path) for path in failed]) from None
            if isinstance(exc, OSError):
                where = f" ({os.path.basename(exc.filename)})" if exc.filename else ""
                raise MigrationFailedError(
                    "bad_request", f"Label files could not be rewritten: {exc.strerror or exc}{where}. "
                    "Nothing was changed.") from None
            raise
        rewrite.finalize()
        self.migration.done = self.migration.total = total
        return rewrite.staged

    def _store(self, touched: dict[int, tuple[dict[int, int], int, int]], rewritten: int) -> None:
        """The files are in place: remove the class and refresh the counts, in one transaction."""
        ctx, project_id = self.ctx, self.project_id
        with ctx.label_locks(project_id), ctx.db.session() as session:
            project = session.get(Project, project_id)
            cls = session.get(ProjectClass, self.class_id)
            if project is None or cls is None:
                raise MigrationFailedError("not_found", "The class no longer exists. Nothing was changed.")
            remaining = [c for c in load_class_table(session, project_id, project.label_format).classes
                         if c.id != cls.id]
            removed: dict[str, object] = {"class_id": cls.id, "name": cls.name, "strategy": self.strategy}
            target = session.get(ProjectClass, self.target_id) if self.target_id is not None else None
            if target is not None:
                removed["merge_into"] = target.id
                removed["merge_into_name"] = target.name
            session.delete(cls)
            session.flush()
            for position, c in enumerate(remaining):
                c.position = position
            session.flush()
            ids = list(touched)
            recount = (update(Image).where(Image.id == bindparam("_id"))
                       .values(has_label=True, box_count=bindparam("_boxes"), unknown_count=bindparam("_unknown")))
            for start in range(0, len(ids), BATCH):
                chunk = ids[start:start + BATCH]
                session.execute(delete(ImageClassCount).where(ImageClassCount.image_id.in_(chunk)))
                counts = [{"image_id": i, "class_id": class_id, "count": n}
                          for i in chunk for class_id, n in touched[i][0].items()]
                if counts:
                    session.execute(insert(ImageClassCount), counts)
                session.connection().execute(recount, [{"_id": i, "_boxes": touched[i][2], "_unknown": touched[i][1]}
                                                       for i in chunk])
            _after_change(ctx, session, project)
            notify.record(session, project_id, "class_deleted", user=session.get(User, self.user_id),
                          data={**removed, "rewritten_files": rewritten})
            session.commit()
            # Still under the label lock: no save can slip in between the commit and the end of the migration.
            ctx.migrations.pop(project_id, None)
            ctx.bump_class_epoch(project_id)

    def _record_failure(self, outcome: dict[str, object]) -> None:
        """An activity entry, so the project shows why the class is still there."""
        try:
            with self.ctx.db.session() as session:
                if session.get(Project, self.project_id) is None:
                    return
                data: dict[str, object] = {**outcome, "class_id": self.class_id, "name": self.migration.class_name,
                                           "strategy": self.strategy}
                target = session.get(ProjectClass, self.target_id) if self.target_id is not None else None
                if target is not None:
                    data["merge_into"] = target.id
                    data["merge_into_name"] = target.name
                notify.record(session, self.project_id, "class_delete_failed", user=session.get(User, self.user_id),
                              data=data)
                session.commit()
        except Exception:
            log.exception("Could not record the failed class delete of project %s", self.project_id)
