"""Annotation documents and revisions."""

from fastapi import APIRouter

from annotamate.server.deps import DB, Access, Ctx
from annotamate.server.errors import not_found
from annotamate.server.models import Revision
from annotamate.server.schemas import (
    AnnotationDoc,
    AnnotationPut,
    BoxIn,
    RestoreIn,
    RevisionDetail,
    RevisionSummary,
    SaveResult,
)
from annotamate.server.services import annotations as svc
from annotamate.server.services.images import get_image
from annotamate.server.services.labels import load_class_table

router = APIRouter(tags=["annotations"])


@router.get("/projects/{pid}/images/{iid}/annotation", response_model=AnnotationDoc)
def get_annotation(iid: int, access: Access, ctx: Ctx, db: DB) -> dict:
    image = get_image(db, access.project.id, iid)
    return svc.annotation_doc(ctx, db, access, image)


@router.put("/projects/{pid}/images/{iid}/annotation", response_model=SaveResult)
def put_annotation(iid: int, body: AnnotationPut, access: Access, ctx: Ctx, db: DB) -> dict:
    image = get_image(db, access.project.id, iid)
    return svc.save_boxes(ctx, db, access, image, body.boxes, base_version=body.base_version, force=body.force)


@router.get("/projects/{pid}/images/{iid}/revisions", response_model=list[RevisionSummary])
def list_revisions(iid: int, access: Access, ctx: Ctx, db: DB) -> list[dict]:
    image = get_image(db, access.project.id, iid)
    return svc.revision_summary(db, image.id, ctx.settings.revisions_keep)


def _revision(db: DB, image_id: int, rid: int) -> Revision:
    revision = db.get(Revision, rid)
    if revision is None or revision.image_id != image_id:
        raise not_found("Revision not found.")
    return revision


@router.get("/projects/{pid}/images/{iid}/revisions/{rid}", response_model=RevisionDetail)
def get_revision(iid: int, rid: int, access: Access, db: DB) -> dict:
    image = get_image(db, access.project.id, iid)
    return svc.revision_detail(db, access, _revision(db, image.id, rid))


@router.post("/projects/{pid}/images/{iid}/revisions/{rid}/restore", response_model=SaveResult)
def restore_revision(iid: int, rid: int, body: RestoreIn, access: Access, ctx: Ctx, db: DB) -> dict:
    access.require_edit()
    image = get_image(db, access.project.id, iid)
    revision = _revision(db, image.id, rid)
    table = load_class_table(db, access.project.id, access.project.label_format)
    boxes = [BoxIn(**b) for b in svc.revision_boxes(table, access.project.label_format, revision)]
    return svc.save_boxes(ctx, db, access, image, boxes, base_version=body.base_version, force=False,
                          restored_revision=revision.id)
