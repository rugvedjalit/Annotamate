"""Notifications."""

from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import select, update

from annotamate.server.deps import DB, CurrentUser
from annotamate.server.models import Notification as NotificationRow
from annotamate.server.models import utcnow
from annotamate.server.schemas import NotificationPage, NotificationsReadIn, UnreadCount
from annotamate.server.services import serialize
from annotamate.server.services.notify import unread_count

router = APIRouter(tags=["notifications"])


@router.get("/notifications", response_model=NotificationPage)
def list_notifications(user: CurrentUser, db: DB, unread: bool = False, before_id: int | None = None,
                       limit: Annotated[int, Query(ge=1, le=200)] = 30) -> dict:
    query = select(NotificationRow).where(NotificationRow.user_id == user.id)
    if unread:
        query = query.where(NotificationRow.read_at.is_(None))
    if before_id is not None:
        query = query.where(NotificationRow.id < before_id)
    rows = list(db.scalars(query.order_by(NotificationRow.id.desc()).limit(limit + 1)))
    return {"items": serialize.notifications(db, rows[:limit]), "has_more": len(rows) > limit,
            "unread_count": unread_count(db, user.id)}


@router.post("/notifications/read", response_model=UnreadCount)
def mark_read(body: NotificationsReadIn, user: CurrentUser, db: DB) -> dict:
    stmt = update(NotificationRow).where(NotificationRow.user_id == user.id, NotificationRow.read_at.is_(None))
    if not body.all:
        stmt = stmt.where(NotificationRow.id.in_(body.ids or []))
    if body.all or body.ids:
        db.execute(stmt.values(read_at=utcnow()).execution_options(synchronize_session=False))
        db.commit()
    return {"unread_count": unread_count(db, user.id)}
