"""Annotation documents: read, save (versioned, lock-aware), revisions and restore."""

from __future__ import annotations

import logging
import os
import posixpath
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from annotamate.core.boxes import Box, sanitize
from annotamate.core.formats import ImageContext, LabelFormatError, serialize_label, uses_class_index
from annotamate.core.formats.voc import to_pixel
from annotamate.core.fsutil import atomic_write
from annotamate.core.images import ImageError, ImageInfo, probe
from annotamate.server.context import AppContext
from annotamate.server.db import emit
from annotamate.server.errors import ApiError, conflict, forbidden, validation_error
from annotamate.server.models import Image, Revision, User, utcnow
from annotamate.server.schemas import BoxIn
from annotamate.server.services import notify, serialize
from annotamate.server.services.access import ProjectAccess
from annotamate.server.services.indexing import replace_class_counts
from annotamate.server.services.labels import (
    ClassTable,
    LabelFile,
    label_version,
    load_class_table,
    read_label_file,
    stable_box_id,
    sync_classes_file,
)
from annotamate.server.services.paths import ProjectPaths

log = logging.getLogger("annotamate.annotations")

REVISIONS_KEPT = 50


def probe_image(paths: ProjectPaths, image: Image) -> tuple[ImageInfo | None, str | None]:
    """``(info, None)`` or ``(None, error message)`` for an image of the project."""
    try:
        return probe(paths.image_file(image.rel_path), paths.project.exif_mode), None
    except ImageError as exc:
        return None, str(exc)


def _latest_revision(session: Session, image_id: int) -> Revision | None:
    return session.scalar(select(Revision).where(Revision.image_id == image_id).order_by(Revision.id.desc()).limit(1))


def _box_out(table: ClassTable, box: Box, box_id: str) -> dict[str, Any]:
    cls = table.resolve(box.label)
    return {
        "id": box_id,
        "class_id": cls.id if cls else None,
        "raw_label": None if cls else box.label,
        # 6 decimals drop float noise from YOLO's normalised values without changing what is written back.
        "x1": round(box.x1, 6), "y1": round(box.y1, 6), "x2": round(box.x2, 6), "y2": round(box.y2, 6),
        "difficult": box.difficult, "truncated": box.truncated,
    }


def build_doc(session: Session, paths: ProjectPaths, image: Image, label: LabelFile, image_error: str | None,
              table: ClassTable) -> dict[str, Any]:
    version = label.version
    latest = _latest_revision(session, image.id)
    current = latest if latest is not None and latest.version == version else None
    saved_ids = [b.get("id") for b in current.boxes] if current is not None else []
    if len(saved_ids) != len(label.parse.boxes):
        saved_ids = []
    boxes = [
        _box_out(table, box, saved_ids[i] if saved_ids else stable_box_id(image.id, version, i))
        for i, box in enumerate(label.parse.boxes)
    ]
    readonly = label.readonly_reason
    if readonly is None and image_error is not None:
        readonly = f"The image cannot be read ({image_error}), so its labels cannot be edited."
    if current is not None:
        updated_at = serialize.iso(current.created_at)
        updated_by = serialize.briefs(session, [current.user_id]).get(current.user_id) if current.user_id else None
    elif label.mtime is not None:
        updated_at = serialize.iso(datetime.fromtimestamp(label.mtime, timezone.utc).replace(tzinfo=None))
        updated_by = None
    else:
        updated_at, updated_by = None, None
    return {"version": version, "boxes": boxes, "readonly_reason": readonly, "updated_at": updated_at,
            "updated_by": updated_by}


def annotation_doc(ctx: AppContext, session: Session, access: ProjectAccess, image: Image) -> dict[str, Any]:
    paths = ProjectPaths(ctx.settings, access.project)
    paths.check()
    info, error = probe_image(paths, image)
    label = read_label_file(paths, image.rel_path, info.width if info else None, info.height if info else None)
    table = load_class_table(session, access.project.id, access.project.label_format)
    return build_doc(session, paths, image, label, error, table)


def _convert(table: ClassTable, fmt: str, boxes: list[BoxIn]) -> list[tuple[Box, dict[str, Any]]]:
    """Validate API boxes and turn them into label-file boxes, keeping what each one meant."""
    out: list[tuple[Box, dict[str, Any]]] = []
    seen_ids: set[str] = set()
    for i, b in enumerate(boxes):
        if b.class_id is not None:
            cls = table.by_id.get(b.class_id)
            if cls is None:
                raise validation_error(["body", "boxes", i, "class_id"], f"Unknown class id {b.class_id}.")
            label, name, class_id, raw = table.label_for(cls), cls.name, cls.id, None
        else:
            raw = (b.raw_label or "").strip()
            if not raw:
                raise validation_error(["body", "boxes", i, "raw_label"], "Boxes without a class need a raw_label.")
            if uses_class_index(fmt) and not (raw.isascii() and raw.isdigit()):
                raise validation_error(["body", "boxes", i, "raw_label"],
                                       "YOLO labels must be class indexes (non-negative integers).")
            label, name, class_id = raw, raw, None
        box_id = b.id if b.id and b.id not in seen_ids else str(uuid.uuid4())
        seen_ids.add(box_id)
        coords = (b.x1, b.y1, b.x2, b.y2)
        if fmt == "voc":
            coords = tuple(float(to_pixel(v)) for v in coords)
        box = Box(*coords, label=label, difficult=b.difficult, truncated=b.truncated)
        out.append((box, {"id": box_id, "class_id": class_id, "raw_label": raw, "name": name}))
    return out


def save_boxes(ctx: AppContext, session: Session, access: ProjectAccess, image: Image, boxes: list[BoxIn], *,
               base_version: str | None, force: bool, restored_revision: int | None = None) -> dict[str, Any]:
    """Validate, check versions/locks and write the label file atomically. Returns the PUT response."""
    project, user = access.project, access.user
    access.require_edit()
    if access.restricted_annotator and image.assignee_id not in (None, user.id):
        raise forbidden("This image is assigned to someone else.")
    holder = ctx.hub.lock_holder(image.id)
    if holder is not None and holder[0] != user.id:
        raise ApiError(423, "locked", f"{holder[1]['display_name']} is editing this image.", holder=holder[1])
    holds_lock = holder is not None
    paths = ProjectPaths(ctx.settings, project)
    paths.check()

    with ctx.label_locks(project.id):
        session.refresh(image)
        info, error = probe_image(paths, image)
        label = read_label_file(paths, image.rel_path, info.width if info else None, info.height if info else None)
        if label.readonly_reason:
            raise conflict("readonly", label.readonly_reason)
        if info is None or label.path is None:
            raise conflict("readonly", f"The image cannot be read ({error}), so its labels cannot be edited.")
        table = load_class_table(session, project.id, project.label_format)
        if base_version != label.version:
            if not force:
                raise conflict("conflict", "Someone else saved this image in the meantime.",
                               current=build_doc(session, paths, image, label, error, table))
            if not (access.can_review or holds_lock):
                raise forbidden("Only reviewers or the person holding the edit lock can overwrite a newer version.")

        written: list[tuple[Box, dict[str, Any]]] = []
        for box, meta in _convert(table, project.label_format, boxes):
            kept = sanitize([box], info.width, info.height)  # clamp to the image, drop boxes < 1 px
            if kept:
                written.append((kept[0], meta))

        folder = posixpath.dirname(image.rel_path)
        image_path = paths.image_file(image.rel_path)
        context = ImageContext(width=info.width, height=info.height, depth=info.depth, filename=image.filename,
                               folder=posixpath.basename(folder) if folder else os.path.basename(paths.image_root),
                               path=image_path)
        try:
            data = serialize_label(project.label_format, [b for b, _ in written], context, table.names)
        except LabelFormatError as exc:
            raise validation_error(["body", "boxes"], str(exc)) from None
        try:
            os.makedirs(os.path.dirname(label.path), exist_ok=True)
            atomic_write(label.path, data)
        except OSError as exc:
            raise ApiError(500, "write_failed", f"The label file could not be written ({exc.strerror or exc}).") \
                from None
        version = label_version(data)
        try:
            sync_classes_file(paths, table, only_if_missing=True)
        except OSError as exc:
            log.warning("Could not write classes.txt for project %s: %s", project.id, exc)

        now = utcnow()
        per_class: dict[int, int] = {}
        unknown = 0
        for _box, meta in written:
            if meta["class_id"] is None:
                unknown += 1
            else:
                per_class[meta["class_id"]] = per_class.get(meta["class_id"], 0) + 1
        if image.status in ("todo", "rejected"):
            image.status = "in_progress"
        claimed = access.restricted_annotator and image.assignee_id is None
        if claimed:
            image.assignee_id = user.id
        image.has_label = True
        image.box_count = len(written)
        image.unknown_count = unknown
        image.last_editor_id = user.id
        image.updated_at = now
        replace_class_counts(session, image.id, per_class)

        session.add(Revision(image_id=image.id, user_id=user.id, created_at=now, version=version,
                             box_count=len(written), boxes=[_revision_box(b, m) for b, m in written]))
        session.flush()
        _prune_revisions(session, image.id)
        notify.record_save(session, project.id, user, image.id, len(written))
        if claimed:
            notify.record(session, project.id, "assigned", user=user, image_id=image.id,
                          data={"assignee": serialize.brief(user), "claimed": True}, subject_user_id=user.id)
        if restored_revision is not None:
            notify.record(session, project.id, "revision_restored", user=user, image_id=image.id,
                          data={"revision_id": restored_revision, "box_count": len(written)})
        session.flush()
        # What a GET returns from now on: coordinates as stored in the file (rounded/clamped), ids kept.
        saved = build_doc(session, paths, image, read_label_file(paths, image.rel_path, info.width, info.height),
                          error, table)["boxes"]
        item = serialize.image_item(session, image)
        emit(session, ("project", project.id), {"type": "image.updated", "project_id": project.id, "image": item,
                                                "version": version, "by": serialize.brief(user)})
        session.commit()
    return {"version": version, "updated_at": serialize.iso(now), "box_count": len(written), "image": item,
            "boxes": saved}


def _revision_box(box: Box, meta: dict[str, Any]) -> dict[str, Any]:
    return {"id": meta["id"], "class_id": meta["class_id"], "raw_label": meta["raw_label"] or None,
            "name": meta["name"], "x1": box.x1, "y1": box.y1, "x2": box.x2, "y2": box.y2,
            "difficult": box.difficult, "truncated": box.truncated}


def _prune_revisions(session: Session, image_id: int) -> None:
    keep = select(Revision.id).where(Revision.image_id == image_id).order_by(Revision.id.desc()).limit(REVISIONS_KEPT)
    session.execute(delete(Revision).where(Revision.image_id == image_id, Revision.id.not_in(keep.scalar_subquery())))


def revision_boxes(table: ClassTable, fmt: str, revision: Revision) -> list[dict[str, Any]]:
    """A revision's boxes in API form, mapped onto the current classes.

    Boxes whose class was deleted since come back as unknown labels (their name) for VOC/COCO;
    for YOLO they map by name when possible and are otherwise dropped (an index could mean another class).
    """
    out: list[dict[str, Any]] = []
    for raw in revision.boxes:
        class_id = raw.get("class_id")
        raw_label = raw.get("raw_label")
        if class_id is not None and class_id not in table.by_id:
            cls = table.by_name.get(raw.get("name") or "")
            if cls is not None:
                class_id, raw_label = cls.id, None
            elif uses_class_index(fmt):
                continue
            else:
                class_id, raw_label = None, raw.get("name")
        out.append({"id": raw["id"], "class_id": class_id, "raw_label": None if class_id is not None else raw_label,
                    "x1": raw["x1"], "y1": raw["y1"], "x2": raw["x2"], "y2": raw["y2"],
                    "difficult": bool(raw.get("difficult")), "truncated": bool(raw.get("truncated"))})
    return out


def revision_summary(session: Session, image_id: int) -> list[dict[str, Any]]:
    rows = list(session.scalars(select(Revision).where(Revision.image_id == image_id)
                                .order_by(Revision.id.desc()).limit(REVISIONS_KEPT)))
    users = serialize.briefs(session, [r.user_id for r in rows])
    return [{"id": r.id, "user": users.get(r.user_id) if r.user_id else None, "created_at": serialize.iso(r.created_at),
             "box_count": r.box_count, "version": r.version} for r in rows]


def revision_detail(session: Session, access: ProjectAccess, revision: Revision) -> dict[str, Any]:
    table = load_class_table(session, access.project.id, access.project.label_format)
    user: User | None = session.get(User, revision.user_id) if revision.user_id else None
    return {"id": revision.id, "user": serialize.brief(user) if user else None,
            "created_at": serialize.iso(revision.created_at),
            "boxes": revision_boxes(table, access.project.label_format, revision)}
