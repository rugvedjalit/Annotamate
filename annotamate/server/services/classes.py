"""Class list changes and the label-file migrations they require.

Every change takes the project's label lock, so class positions (= YOLO indexes) can never be
assigned twice and no annotation save interleaves with a migration.
"""

from __future__ import annotations

import logging
from collections import Counter

from sqlalchemy import select
from sqlalchemy.orm import Session

from annotamate.core.classes import next_color
from annotamate.core.formats import parse_label, relabel, uses_class_index
from annotamate.core.fsutil import atomic_write, atomic_write_many
from annotamate.server.context import AppContext
from annotamate.server.db import emit
from annotamate.server.errors import ApiError, bad_request, conflict, not_found
from annotamate.server.models import Image, Project, ProjectClass
from annotamate.server.services import notify, serialize
from annotamate.server.services.access import ProjectAccess
from annotamate.server.services.indexing import (
    LabelLister,
    ParsedLabel,
    counts_for,
    replace_class_counts,
    schedule_unknown_recount,
)
from annotamate.server.services.labels import ClassTable, load_class_table, sync_classes_file
from annotamate.server.services.paths import ProjectPaths

log = logging.getLogger("annotamate.classes")

BATCH = 500


def clean_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise bad_request("Class name is required.")
    if len(name) > 100:
        raise bad_request("Class names are at most 100 characters.")
    if any(ord(ch) < 32 or ch == "\x7f" for ch in name):
        raise bad_request("Class names cannot contain line breaks or control characters.")
    return name


def get_class(session: Session, project_id: int, class_id: int) -> ProjectClass:
    cls = session.get(ProjectClass, class_id)
    if cls is None or cls.project_id != project_id:
        raise not_found("Class not found.")
    return cls


def _refuse_while_indexing(ctx: AppContext, project_id: int) -> None:
    if ctx.is_indexing(project_id):
        raise conflict("conflict", "The project is being indexed. Try again when indexing has finished.")


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
        existing = list(session.scalars(select(ProjectClass).where(ProjectClass.project_id == project.id)))
        if any(c.name == name for c in existing):
            raise conflict("exists", f"A class named '{name}' already exists.")
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
            new_name = cls.name
            ctx.jobs.submit(("rename", project.id), lambda: rename_in_files(ctx, project.id, {old_name: new_name}))
    return cls


def _label_files(session: Session, paths: ProjectPaths) -> list[tuple[int, str]]:
    """``(image id, label path)`` of every label file on disk right now.

    Class migrations look at the files themselves (one directory listing per folder), never at
    cached counts or ``has_label``, which can be stale when files are edited outside the app.
    """
    lister = LabelLister(paths)
    rows = session.execute(select(Image.id, Image.rel_path).where(Image.project_id == paths.project.id)
                           .order_by(Image.id))
    out = []
    for image_id, rel_path in rows:
        path = lister.path(paths.label_rel(rel_path))
        if path is not None:
            out.append((image_id, path))
    return out


def _read(path: str) -> bytes | None:
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


def rename_in_files(ctx: AppContext, project_id: int, name_map: dict[str, str | None]) -> None:
    """Background job: apply a VOC/COCO class rename to every label file of the project."""
    with ctx.db.session() as session:
        project = session.get(Project, project_id)
        if project is None:
            return
        images = _label_files(session, ProjectPaths(ctx.settings, project))
    for start in range(0, len(images), BATCH):
        if ctx.jobs.stopping.is_set():
            return
        chunk = dict(images[start:start + BATCH])
        with ctx.label_locks(project_id), ctx.db.session() as session:
            project = session.get(Project, project_id)
            if project is None:
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
                    continue
                new, changed = relabel(project.label_format, data, name_map=name_map, class_names=table.names)
                if changed:
                    try:
                        atomic_write(path, new)
                    except OSError as exc:
                        log.warning("Could not rewrite %s: %s", path, exc)
                        continue
                    _recount(session, table, project.label_format, image, new)
            ctx.bump_class_epoch(project_id)  # an index pass that read these files must read them again
            session.commit()
    ctx.hub.send_project(project_id, {"type": "images.bulk_updated", "project_id": project_id,
                                      "count": len(images)})


def _recount(session: Session, table: ClassTable, fmt: str, image: Image, data: bytes) -> None:
    result = parse_label(fmt, data)
    parsed = ParsedLabel(True, Counter(b.label for b in result.boxes), result.categories)
    per_class, unknown, boxes = counts_for(table, parsed)
    image.has_label, image.box_count, image.unknown_count = True, boxes, unknown
    replace_class_counts(session, image.id, per_class)


def delete_class(ctx: AppContext, session: Session, access: ProjectAccess, cls: ProjectClass, *, strategy: str,
                 merge_into: int | None) -> int:
    """Delete a class, rewriting label files as needed; returns the number of files rewritten.

    Runs synchronously under the project's label lock. Every label file is read (cached counts may
    be stale), all new contents are staged and only then replaced (``atomic_write_many``); the
    database changes come last, in one short transaction.
    """
    project = access.project
    fmt = project.label_format
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
        _refuse_while_indexing(ctx, project.id)
        paths = ProjectPaths(ctx.settings, project)
        paths.check()
        old = load_class_table(session, project.id, fmt).classes
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

        staged: list[tuple[str, bytes]] = []
        touched: dict[int, bytes] = {}  # images that contained the deleted class: their counts change
        in_use = 0
        for image_id, path in _label_files(session, paths):
            data = _read(path)
            if data is None:
                continue
            uses = any(b.label == key for b in parse_label(fmt, data).boxes)
            in_use += uses
            if strategy == "forbid" and in_use:
                continue  # keep counting, nothing will be written
            new, changed = relabel(fmt, data, index_map=index_map, name_map=name_map, class_names=new_names)
            if changed:
                staged.append((path, new))
            if uses:
                touched[image_id] = new
        if strategy == "forbid" and in_use:
            raise conflict("in_use", f"{in_use} images still use '{cls.name}'.", images=in_use)
        try:
            atomic_write_many(staged)
        except OSError as exc:
            raise bad_request(f"Label files could not be rewritten ({exc.strerror or exc}); nothing was changed.") \
                from None

        removed: dict[str, object] = {"class_id": cls.id, "name": cls.name, "strategy": strategy}
        if target is not None:
            removed["merge_into"] = target.id
            removed["merge_into_name"] = target.name
        session.delete(cls)
        session.flush()
        for c in remaining:
            c.position = new_index[c.id]
        session.flush()
        table = load_class_table(session, project.id, fmt)
        touched_ids = list(touched)
        for start in range(0, len(touched_ids), BATCH):
            for image in session.scalars(select(Image).where(Image.id.in_(touched_ids[start:start + BATCH]))):
                _recount(session, table, fmt, image, touched[image.id])
        _after_change(ctx, session, project)
        notify.record(session, project.id, "class_deleted", user=access.user,
                      data={**removed, "rewritten_files": len(staged)})
        ctx.bump_class_epoch(project.id)
        session.commit()
    if staged:
        ctx.hub.send_project(project.id, {"type": "images.bulk_updated", "project_id": project.id,
                                          "count": len(staged)})
    return len(staged)
