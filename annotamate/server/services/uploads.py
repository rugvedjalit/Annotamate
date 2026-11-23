"""Image uploads into a project's folder (managers only)."""

from __future__ import annotations

import contextlib
import os
import posixpath
import shutil
from dataclasses import dataclass
from typing import BinaryIO

from PIL import Image as PILImage
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from annotamate.core.fsutil import OutsideRootError, create_unique, resolve_inside, sanitize_filename
from annotamate.core.images import budget_error
from annotamate.core.scanning import IMAGE_EXTENSIONS, IMAGE_FORMATS, natural_key
from annotamate.server.context import AppContext
from annotamate.server.db import emit
from annotamate.server.errors import ApiError, bad_request
from annotamate.server.models import Image, Project
from annotamate.server.services import notify, serialize
from annotamate.server.services.access import ProjectAccess
from annotamate.server.services.indexing import counts_for, parse_for_index, replace_class_counts, set_label_state
from annotamate.server.services.labels import load_class_table
from annotamate.server.services.paths import RESERVED_YOLO_KEY, ProjectPaths, label_key


@dataclass
class IncomingFile:
    filename: str
    size: int
    stream: BinaryIO


def _target_dir(paths: ProjectPaths, recursive: bool, subdir: str | None) -> str:
    if not subdir or not subdir.strip("/\\ "):
        return paths.image_root
    if not recursive:
        raise bad_request("Uploading into a sub-folder needs the project's 'recursive' setting.")
    parts = []
    for part in subdir.replace("\\", "/").split("/"):
        if not part.strip() or part in (".", ".."):
            continue
        clean = sanitize_filename(part)
        if clean is None or clean.startswith("."):
            raise bad_request("Invalid sub-folder name.")
        parts.append(clean)
    try:
        target = resolve_inside(paths.image_root, os.path.join(*parts) if parts else ".")
    except OutsideRootError:
        raise bad_request("The sub-folder is outside the project folder.") from None
    os.makedirs(target, exist_ok=True)
    return target


def _check_image(stream: BinaryIO) -> str | None:
    """``None`` for a valid image within the pixel budget, otherwise the reason it is refused."""
    try:
        stream.seek(0)
        with PILImage.open(stream, formats=list(IMAGE_FORMATS)) as img:
            too_big = budget_error(img.size)
            if too_big:
                return too_big
            img.verify()
        return None
    except Exception:  # Pillow raises many types for corrupt input
        return "Not a valid image."
    finally:
        stream.seek(0)


def _folder_keys(directory: str) -> dict[str, str]:
    """``label key -> file name`` of the images already in ``directory`` (indexed or not)."""
    keys: dict[str, str] = {}
    try:
        names = os.listdir(directory)
    except OSError:
        return keys
    for name in sorted(names, key=natural_key):
        if not name.startswith(".") and os.path.splitext(name)[1].lower() in IMAGE_EXTENSIONS:
            keys.setdefault(label_key(name), name)
    return keys


def _stem_clash(session: Session, project: Project, rel: str, folder_keys: dict[str, str]) -> str | None:
    """Reason an image stored at ``rel`` must be refused because its label file would be shared (or reserved)."""
    key = label_key(rel)
    if project.label_format == "yolo" and key == RESERVED_YOLO_KEY:
        return "The name 'classes' is reserved for the class list (classes.txt)."
    name = posixpath.basename(rel)
    other = folder_keys.get(posixpath.basename(key))
    if other is not None and other != name:
        return f"Its label file would be shared with {other} (same name, different extension)."
    owner = session.scalar(select(Image.rel_path).where(Image.project_id == project.id, Image.label_key == key,
                                                        Image.missing.is_(False), Image.rel_path != rel).limit(1))
    if owner is not None:
        return f"Its label file would be shared with {owner} (same name, different extension)."
    return None


def save_uploads(ctx: AppContext, session: Session, access: ProjectAccess, files: list[IncomingFile],
                 subdir: str | None) -> dict:
    access.require_manage()
    project = access.project
    ctx.refuse_while_migrating(project.id)
    paths = ProjectPaths(ctx.settings, project)
    paths.check()
    limit = ctx.settings.max_upload_bytes
    if len(files) == 1 and files[0].size > limit:
        raise ApiError(413, "too_large", f"The file is larger than {ctx.settings.max_upload_mb} MB.")
    target = _target_dir(paths, project.recursive, subdir)

    folder_keys = _folder_keys(target)
    written: list[str] = []
    skipped: list[dict[str, str]] = []
    for incoming in files:
        original = incoming.filename or ""
        name = sanitize_filename(original)
        if name is None or name.startswith("."):
            skipped.append({"filename": original, "reason": "Invalid file name."})
            continue
        if os.path.splitext(name)[1].lower() not in IMAGE_EXTENSIONS:
            skipped.append({"filename": original, "reason": "Unsupported file type."})
            continue
        if incoming.size > limit:
            skipped.append({"filename": original, "reason": f"Larger than {ctx.settings.max_upload_mb} MB."})
            continue
        problem = _check_image(incoming.stream)
        if problem:
            skipped.append({"filename": original, "reason": problem})
            continue
        path, fd = create_unique(target, name)
        rel_new = os.path.relpath(path, paths.image_root).replace(os.sep, "/")
        clash = _stem_clash(session, project, rel_new, folder_keys)
        if clash:
            os.close(fd)
            with contextlib.suppress(OSError):
                os.unlink(path)
            skipped.append({"filename": original, "reason": clash})
            continue
        folder_keys.setdefault(label_key(posixpath.basename(path)), os.path.basename(path))
        try:
            with os.fdopen(fd, "wb") as out:
                shutil.copyfileobj(incoming.stream, out, 1024 * 1024)
        except OSError as exc:
            with contextlib.suppress(OSError):
                os.unlink(path)
            skipped.append({"filename": original, "reason": f"Could not be saved ({exc.strerror or exc})."})
            continue
        written.append(os.path.relpath(path, paths.image_root).replace(os.sep, "/"))

    added: list[Image] = []
    if written:
        with ctx.quiet_label_lock(project.id):  # the files are written: index them after a class migration
            table = load_class_table(session, project.id, project.label_format)
            class_version = session.scalar(select(Project.class_version).where(Project.id == project.id)) or 0
            existing = dict(session.execute(select(Image.rel_path, Image.id).where(
                Image.project_id == project.id, Image.rel_path.in_(written))).all())
            revived = list(existing.values())  # rows of files that had gone missing and are back
            if revived:
                session.execute(update(Image).where(Image.id.in_(revived)).values(missing=False))
            for rel in sorted(written, key=natural_key):
                if rel in existing:
                    continue
                parsed = parse_for_index(paths, rel)
                per_class, unknown, boxes = counts_for(table, parsed)
                # The sort key (set from the path) places the image in the list: no other row changes.
                image = Image(project_id=project.id, rel_path=rel, filename=posixpath.basename(rel),
                              label_key=label_key(rel),
                              status="done" if parsed.has_label else "todo", has_label=parsed.has_label,
                              box_count=boxes, unknown_count=unknown, flagged=False, comment_count=0,
                              open_comment_count=0)
                set_label_state(image, parsed.stat, class_version)
                session.add(image)
                session.flush()
                replace_class_counts(session, image.id, per_class)
                added.append(image)
            notify.record(session, project.id, "images_uploaded", user=access.user, count=len(added),
                          data={"count": len(added)})
            emit(session, ("project", project.id), {"type": "images.bulk_updated", "project_id": project.id,
                                                    "count": len(added)})
            emit(session, ("project", project.id), {"type": "project.updated", "project_id": project.id})
            session.commit()
            for image in added:
                session.refresh(image)
    return {"added": serialize.image_items(session, added), "skipped": skipped}
