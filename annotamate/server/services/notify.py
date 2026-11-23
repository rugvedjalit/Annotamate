"""Notifications, @mentions and the activity feed."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from annotamate.server.db import Database, emit
from annotamate.server.models import Activity, Notification, Project, ProjectMember, User, utcnow
from annotamate.server.services import serialize

MENTION_RE = re.compile(r"(?<![\w@.])@([A-Za-z0-9_.-]{3,32})")
SAVE_COALESCE_WINDOW = timedelta(minutes=10)


def preview(text: str, limit: int = 80) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# ---------------------------------------------------------------------------- mentions


def parse_mentions(session: Session, body: str, *, project_id: int | None = None) -> list[int]:
    """Ids of active users written as ``@username`` (in order, deduplicated).

    In a project context only members (and administrators) can be mentioned.
    A trailing ``.`` (end of sentence) is ignored when it is not part of a real username.
    """
    names = [m.group(1).lower() for m in MENTION_RE.finditer(body)]
    if not names:
        return []
    lookup = set(names) | {n.rstrip(".") for n in names}
    users = {u.username: u for u in session.scalars(
        select(User).where(User.username.in_(lookup), User.is_active.is_(True))
    )}
    allowed: set[int] | None = None
    if project_id is not None and users:
        members = set(session.scalars(select(ProjectMember.user_id).where(
            ProjectMember.project_id == project_id, ProjectMember.user_id.in_([u.id for u in users.values()]))))
        allowed = members | {u.id for u in users.values() if u.is_admin}
    out: list[int] = []
    for name in names:
        user = users.get(name) or users.get(name.rstrip("."))
        if user is None or user.id in out or (allowed is not None and user.id not in allowed):
            continue
        out.append(user.id)
    return out


# ---------------------------------------------------------------------------- notifications


def unread_count(session: Session, user_id: int) -> int:
    return session.scalar(
        select(func.count()).select_from(Notification)
        .where(Notification.user_id == user_id, Notification.read_at.is_(None))
    ) or 0


def notify(
    session: Session,
    user_ids: Iterable[int],
    type_: str,
    text: str,
    *,
    actor: User | None,
    project: Project | None = None,
    image_id: int | None = None,
) -> list[Notification]:
    """Create one notification per recipient (never for the actor) and push it after commit."""
    created: list[Notification] = []
    seen: set[int] = set()
    for user_id in user_ids:
        if user_id in seen or (actor is not None and user_id == actor.id):
            continue
        seen.add(user_id)
        row = Notification(user_id=user_id, type=type_, actor_id=actor.id if actor else None,
                           project_id=project.id if project else None, image_id=image_id, text=text)
        session.add(row)
        created.append(row)
    if created:
        session.flush()
        for row, out in zip(created, serialize.notifications(session, created), strict=True):
            emit(session, ("user", row.user_id), {
                "type": "notification", "notification": out, "unread_count": unread_count(session, row.user_id),
            })
    return created


# ---------------------------------------------------------------------------- activity


def record(
    session: Session,
    project_id: int,
    type_: str,
    *,
    user: User | None,
    image_id: int | None = None,
    data: dict[str, Any] | None = None,
    action: str | None = None,
    subject_user_id: int | None = None,
    count: int = 1,
) -> Activity:
    row = Activity(project_id=project_id, type=type_, user_id=user.id if user else None, image_id=image_id,
                   data=data or {}, action=action, subject_user_id=subject_user_id, count=count)
    session.add(row)
    return row


def record_save(session: Session, project_id: int, user: User, image_id: int, box_count: int) -> None:
    """``annotation_saved`` coalesced to one entry per user and image per 10 minutes."""
    since = utcnow() - SAVE_COALESCE_WINDOW
    existing = session.scalar(
        select(Activity).where(
            Activity.project_id == project_id, Activity.type == "annotation_saved", Activity.user_id == user.id,
            Activity.image_id == image_id, Activity.created_at >= since,
        ).order_by(Activity.id.desc()).limit(1)
    )
    if existing is not None:
        existing.count += 1
        existing.data = {"box_count": box_count, "saves": existing.count}
        return
    record(session, project_id, "annotation_saved", user=user, image_id=image_id,
           data={"box_count": box_count, "saves": 1})


# ---------------------------------------------------------------------------- retention

#: Rows removed per transaction while pruning (short write locks, so saves never wait long).
PRUNE_BATCH = 1000


def prune_history(db: Database, days: int, should_stop: Callable[[], bool] = lambda: False) -> tuple[int, int]:
    """Remove activity entries and *read* notifications older than ``days`` days.

    Returns ``(activity entries, notifications)`` removed. Unread notifications are never removed, however
    old. Statistics that add up activity (saves and reviews per member) then cover the kept period only.
    """
    if days <= 0:
        return 0, 0
    cutoff = utcnow() - timedelta(days=days)
    removed = []
    for model, conditions in ((Activity, (Activity.created_at < cutoff,)),
                              (Notification, (Notification.created_at < cutoff, Notification.read_at.is_not(None)))):
        count = 0
        while not should_stop():
            with db.session() as session:
                ids = list(session.scalars(select(model.id).where(*conditions).order_by(model.id).limit(PRUNE_BATCH)))
                if ids:
                    session.execute(delete(model).where(model.id.in_(ids)))
                    session.commit()
            count += len(ids)
            if len(ids) < PRUNE_BATCH:
                break
        removed.append(count)
    return removed[0], removed[1]
