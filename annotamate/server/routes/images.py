"""Image list, details, pixels, thumbnails and workflow."""

import os
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse

from annotamate.core.images import DiskCache, ImageError, make_thumbnail, probe, reencode
from annotamate.server.deps import DB, Access, Ctx
from annotamate.server.errors import not_found
from annotamate.server.schemas import (
    BulkIn,
    BulkResult,
    ImageDetail,
    ImageItem,
    ImageList,
    ImagePatch,
    Neighbors,
    StatusActionIn,
)
from annotamate.server.services import images as svc
from annotamate.server.services import serialize
from annotamate.server.services.annotations import probe_image
from annotamate.server.services.paths import ProjectPaths

router = APIRouter(tags=["images"])

IMMUTABLE = "private, max-age=31536000, immutable"


def image_filter(q: str | None = None, status: str | None = None, assignee: str | None = None,
                 flagged: bool | None = None, class_id: int | None = None, has_comments: str | None = None,
                 sort: str = "name") -> svc.ImageFilter:
    return svc.ImageFilter.build(q=q, status=status, assignee=assignee, flagged=flagged, class_id=class_id,
                                 has_comments=has_comments, sort=sort)


Filter = Annotated[svc.ImageFilter, Depends(image_filter)]


@router.get("/projects/{pid}/images", response_model=ImageList)
def list_images(access: Access, db: DB, flt: Filter, offset: Annotated[int, Query(ge=0)] = 0,
                limit: Annotated[int, Query(ge=1, le=500)] = 100) -> dict:
    return svc.list_images(db, access, flt, offset, limit)


@router.post("/projects/{pid}/images/bulk", response_model=BulkResult)
def bulk(body: BulkIn, access: Access, db: DB) -> dict:
    flt = svc.ImageFilter.from_body(body.filter) if body.filter is not None else None
    updated = svc.bulk(db, access, image_ids=body.image_ids, flt=flt, action=body.action,
                       assignee_id=body.assignee_id, status=body.status, user_ids=body.user_ids, limit=body.limit)
    db.commit()
    return {"updated": updated}


@router.get("/projects/{pid}/images/{iid}", response_model=ImageDetail)
def get_image(iid: int, access: Access, ctx: Ctx, db: DB) -> dict:
    image = svc.get_image(db, access.project.id, iid)
    paths = ProjectPaths(ctx.settings, access.project)
    paths.check()
    info, error = probe_image(paths, image)
    try:
        mtime_ns = os.stat(paths.image_file(image.rel_path)).st_mtime_ns
    except OSError:
        mtime_ns = 0
    return {
        **serialize.image_item(db, image),
        "width": info.width if info else None,
        "height": info.height if info else None,
        "error": error,
        "label_path": paths.label_rel(image.rel_path),
        "file_url": f"api/projects/{access.project.id}/images/{image.id}/file?v={mtime_ns}",
    }


@router.get("/projects/{pid}/images/{iid}/neighbors", response_model=Neighbors)
def neighbors(iid: int, access: Access, db: DB, flt: Filter) -> dict:
    image = svc.get_image(db, access.project.id, iid)
    return svc.neighbors(db, access, image, flt)


@router.get("/projects/{pid}/images/{iid}/file")
def image_file(iid: int, access: Access, ctx: Ctx, db: DB, v: str | None = None) -> FileResponse:
    image = svc.get_image(db, access.project.id, iid)
    paths = ProjectPaths(ctx.settings, access.project)
    paths.check()
    path = paths.image_file(image.rel_path)
    mode = access.project.exif_mode
    try:
        info = probe(path, mode)
        headers = {"Cache-Control": IMMUTABLE if v else "private, no-cache"}
        if not info.needs_reencode:
            return FileResponse(path, media_type=info.media_type, headers=headers)
        ext, media = (".jpg", "image/jpeg") if info.format in ("JPEG", "MPO") else (".png", "image/png")
        cached = ctx.renders.get_or_create(DiskCache.source_key(path, "render", mode), ext,
                                           lambda: reencode(path, mode)[0])
    except (ImageError, OSError) as exc:
        raise not_found(str(exc) if isinstance(exc, ImageError) else "File not found") from None
    return FileResponse(cached, media_type=media, headers=headers)


@router.get("/projects/{pid}/images/{iid}/thumb")
def thumbnail(iid: int, access: Access, ctx: Ctx, db: DB, size: Annotated[int, Query(ge=64, le=512)] = 256,
              v: str | None = None) -> FileResponse:
    image = svc.get_image(db, access.project.id, iid)
    paths = ProjectPaths(ctx.settings, access.project)
    paths.check()
    path = paths.image_file(image.rel_path)
    mode = access.project.exif_mode
    try:
        cached = ctx.thumbs.get_or_create(DiskCache.source_key(path, "thumb", size, mode), ".webp",
                                          lambda: make_thumbnail(path, size, mode))
    except (ImageError, OSError) as exc:
        raise not_found(str(exc) if isinstance(exc, ImageError) else "File not found") from None
    return FileResponse(cached, media_type="image/webp",
                        headers={"Cache-Control": IMMUTABLE if v else "private, max-age=3600"})


@router.patch("/projects/{pid}/images/{iid}", response_model=ImageItem)
def patch_image(iid: int, body: ImagePatch, access: Access, db: DB) -> dict:
    image = svc.get_image(db, access.project.id, iid)
    fields = {name: getattr(body, name) for name in body.model_fields_set}
    item = svc.patch_image(db, access, image, fields)
    db.commit()
    return item


@router.post("/projects/{pid}/images/{iid}/status", response_model=ImageItem)
def change_status(iid: int, body: StatusActionIn, access: Access, ctx: Ctx, db: DB) -> dict:
    image = svc.get_image(db, access.project.id, iid)
    item = svc.change_status(ctx, db, access, image, body.action, body.comment)
    db.commit()
    return item
