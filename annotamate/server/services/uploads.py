"""Image uploads into a project's folder (managers only)."""

from __future__ import annotations

import contextlib
import os
import posixpath
import shutil
from dataclasses import dataclass
from typing import BinaryIO

from PIL import Image as PILImage
from sqlalchemy import select
from sqlalchemy.orm import Session

from annotamate.core.fsutil import OutsideRootError, create_unique, resolve_inside, sanitize_filename
from annotamate.core.scanning import IMAGE_EXTENSIONS, natural_key
from annotamate.server.context import AppContext
from annotamate.server.db import emit
from annotamate.server.errors import ApiError, bad_request
from annotamate.server.models import Image
from annotamate.server.services import notify, serialize
from annotamate.server.services.access import ProjectAccess
from annotamate.server.services.indexing import counts_for, parse_for_index, renumber, replace_class_counts
from annotamate.server.services.labels import load_class_table
from annotamate.server.services.paths import ProjectPaths


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


def _is_image(stream: BinaryIO) -> bool:
    try:
        stream.seek(0)
        with PILImage.open(stream) as img:
            img.verify()
        return True
    except Exception:  # Pillow raises many types for corrupt input
        return False
    finally:
        stream.seek(0)


def save_uploads(ctx: AppContext, session: Session, access: ProjectAccess, files: list[IncomingFile],
                 subdir: str | None) -> dict:
    access.require_manage()
    project = access.project
    paths = ProjectPaths(ctx.settings, project)
    paths.check()
    limit = ctx.settings.max_upload_bytes
    if len(files) == 1 and files[0].size > limit:
        raise ApiError(413, "too_large", f"The file is larger than {ctx.settings.max_upload_mb} MB.")
    target = _target_dir(paths, project.recursive, subdir)

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
        if not _is_image(incoming.stream):
            skipped.append({"filename": original, "reason": "Not a valid image."})
            continue
        path, fd = create_unique(target, name)
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
        with ctx.label_locks(project.id):
            table = load_class_table(session, project.id, project.label_format)
            existing = set(session.scalars(select(Image.rel_path).where(Image.project_id == project.id,
                                                                        Image.rel_path.in_(written))))
            for rel in sorted(written, key=natural_key):
                if rel in existing:
                    continue
                parsed = parse_for_index(paths, rel)
                per_class, unknown, boxes = counts_for(table, parsed)
                image = Image(project_id=project.id, rel_path=rel, filename=posixpath.basename(rel), sort_index=0,
                              status="done" if parsed.has_label else "todo", has_label=parsed.has_label,
                              box_count=boxes, unknown_count=unknown, flagged=False, comment_count=0,
                              open_comment_count=0)
                session.add(image)
                session.flush()
                replace_class_counts(session, image.id, per_class)
                added.append(image)
            renumber(session, project.id)
            notify.record(session, project.id, "images_uploaded", user=access.user, count=len(added),
                          data={"count": len(added)})
            emit(session, ("project", project.id), {"type": "images.bulk_updated", "project_id": project.id,
                                                    "count": len(added)})
            emit(session, ("project", project.id), {"type": "project.updated", "project_id": project.id})
            session.commit()
            for image in added:
                session.refresh(image)
    return {"added": serialize.image_items(session, added), "skipped": skipped}
