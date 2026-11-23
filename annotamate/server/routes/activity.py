"""Project activity feed."""

from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import select

from annotamate.server.deps import DB, Access
from annotamate.server.models import Activity as ActivityRow
from annotamate.server.schemas import ActivityPage
from annotamate.server.services import serialize

router = APIRouter(tags=["activity"])


@router.get("/projects/{pid}/activity", response_model=ActivityPage)
def activity(access: Access, db: DB, before_id: int | None = None, limit: Annotated[int, Query(ge=1, le=200)] = 50,
             user_id: int | None = None, image_id: int | None = None) -> dict:
    query = select(ActivityRow).where(ActivityRow.project_id == access.project.id)
    if user_id is not None:
        query = query.where(ActivityRow.user_id == user_id)
    if image_id is not None:
        query = query.where(ActivityRow.image_id == image_id)
    if before_id is not None:
        query = query.where(ActivityRow.id < before_id)
    rows = list(db.scalars(query.order_by(ActivityRow.id.desc()).limit(limit + 1)))
    return {"items": serialize.activities(db, rows[:limit]), "has_more": len(rows) > limit}
