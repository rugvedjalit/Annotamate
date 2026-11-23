"""Server-side folder browser for project creation (administrators only, limited to the roots)."""

import os
import time

from fastapi import APIRouter

from annotamate.core.fsutil import is_inside
from annotamate.core.scanning import count_images, list_subdirectories
from annotamate.server.deps import AdminUser, Ctx
from annotamate.server.errors import bad_request, not_found
from annotamate.server.schemas import FsBrowse, FsRoot
from annotamate.server.services.paths import resolve_in_roots

router = APIRouter(tags=["fs"])

COUNT_BUDGET = 3.0  # seconds spent counting images in sub-folders before giving up (null counts)


def _root_name(path: str) -> str:
    return os.path.basename(path.rstrip("\\/")) or path


@router.get("/fs/roots", response_model=list[FsRoot])
def roots(_admin: AdminUser, ctx: Ctx) -> list[dict]:
    return [{"path": root, "name": _root_name(root)} for root in ctx.settings.roots]


@router.get("/fs/browse", response_model=FsBrowse)
def browse(_admin: AdminUser, ctx: Ctx, path: str | None = None) -> dict:
    target = resolve_in_roots(ctx.settings, path) if path else ctx.settings.roots[0]
    if not os.path.isdir(target):
        raise not_found("Folder not found.")
    try:
        subdirs = list_subdirectories(target)
    except OSError as exc:
        raise bad_request(f"The folder cannot be read ({exc.strerror or exc}).") from None
    deadline = time.monotonic() + COUNT_BUDGET
    entries = []
    for name, sub in subdirs:
        if not any(is_inside(root, sub) for root in ctx.settings.roots):
            continue  # symlink pointing outside the roots
        counted = count_images(sub, deadline=deadline) if time.monotonic() < deadline else None
        entries.append({"name": name, "path": os.path.realpath(sub), "image_count": counted})
    is_root = any(os.path.normcase(target) == os.path.normcase(root) for root in ctx.settings.roots)
    return {
        "path": target,
        "parent": None if is_root else os.path.dirname(target),
        "image_count": count_images(target) or 0,
        "entries": entries,
    }
