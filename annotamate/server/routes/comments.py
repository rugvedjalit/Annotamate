"""Image comment threads."""

from typing import Annotated

from fastapi import APIRouter, Query, Response
from sqlalchemy import select

from annotamate.server.deps import DB, Access, Ctx
from annotamate.server.models import Comment as CommentRow
from annotamate.server.models import Image
from annotamate.server.schemas import Comment, CommentCreate, CommentPage, CommentPatch
from annotamate.server.services import comments as svc
from annotamate.server.services import serialize
from annotamate.server.services.images import get_image
from annotamate.server.services.messages import page

router = APIRouter(tags=["comments"])


@router.get("/projects/{pid}/images/{iid}/comments", response_model=list[Comment])
def list_comments(iid: int, access: Access, db: DB) -> list[dict]:
    image = get_image(db, access.project.id, iid)
    rows = list(db.scalars(select(CommentRow).where(CommentRow.image_id == image.id).order_by(CommentRow.id)))
    return serialize.comments(db, rows)


@router.post("/projects/{pid}/images/{iid}/comments", response_model=Comment)
def add_comment(iid: int, body: CommentCreate, access: Access, ctx: Ctx, db: DB) -> dict:
    image = get_image(db, access.project.id, iid)
    out = svc.create_comment(ctx, db, access, image, body.body, body.pin.model_dump() if body.pin else None)
    db.commit()
    return out


@router.patch("/projects/{pid}/comments/{cid}", response_model=Comment)
def edit_comment(cid: int, body: CommentPatch, access: Access, db: DB) -> dict:
    comment = svc.get_comment(db, access.project.id, cid)
    out = svc.update_comment(db, access, comment, body=body.body, resolved=body.resolved)
    db.commit()
    return out


@router.delete("/projects/{pid}/comments/{cid}", status_code=204)
def delete_comment(cid: int, access: Access, db: DB) -> Response:
    comment = svc.get_comment(db, access.project.id, cid)
    svc.delete_comment(db, access, comment)
    db.commit()
    return Response(status_code=204)


@router.get("/projects/{pid}/comments", response_model=CommentPage)
def project_comments(access: Access, db: DB, resolved: bool | None = None, before_id: int | None = None,
                     limit: Annotated[int, Query(ge=1, le=200)] = 50) -> dict:
    query = (select(CommentRow).join(Image, Image.id == CommentRow.image_id)
             .where(CommentRow.project_id == access.project.id, CommentRow.deleted.is_(False),
                    Image.missing.is_(False)))
    if resolved is not None:
        query = query.where(CommentRow.resolved.is_(resolved))
    rows, has_more = page(query, CommentRow.id, before_id, limit, db)
    return {"items": serialize.comments(db, rows, with_image=True), "has_more": has_more}
