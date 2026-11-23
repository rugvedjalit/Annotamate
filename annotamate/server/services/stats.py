"""Project statistics, computed with aggregate queries (no per-image loading)."""

from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Any

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from annotamate.server.context import AppContext
from annotamate.server.models import Activity, Image, ImageClassCount, ProjectClass, ProjectMember, utcnow
from annotamate.server.schemas import STATUSES
from annotamate.server.services import serialize

DAYS = 30


def project_stats(ctx: AppContext, session: Session, project_id: int, tz_offset_minutes: int = 0) -> dict[str, Any]:
    """Aggregates for the overview. ``tz_offset_minutes`` (east of UTC) sets the viewer's calendar days.

    Every open overview asks for these after each change in the project, so the result comes from the
    aggregate cache: computed once per change (at most every couple of seconds) however many clients ask.
    """
    return ctx.aggregates.get(project_id, ("stats", tz_offset_minutes),
                              lambda: _project_stats(session, project_id, tz_offset_minutes))


def _project_stats(session: Session, project_id: int, tz_offset_minutes: int) -> dict[str, Any]:
    live = Image.missing.is_(False)
    status_counts = dict.fromkeys(STATUSES, 0)
    for status, n in session.execute(select(Image.status, func.count()).where(Image.project_id == project_id, live)
                                     .group_by(Image.status)):
        status_counts[status] = n
    boxes_total = session.scalar(select(func.coalesce(func.sum(Image.box_count), 0))
                                 .where(Image.project_id == project_id, live)) or 0

    class_counts = [
        {"class_id": cid, "boxes": int(boxes or 0), "images": int(images or 0)}
        for cid, boxes, images in session.execute(
            select(ProjectClass.id, func.sum(case((Image.id.is_not(None), ImageClassCount.count), else_=0)),
                   func.count(Image.id))
            .outerjoin(ImageClassCount, ImageClassCount.class_id == ProjectClass.id)
            .outerjoin(Image, and_(Image.id == ImageClassCount.image_id, live))
            .where(ProjectClass.project_id == project_id)
            .group_by(ProjectClass.id, ProjectClass.position).order_by(ProjectClass.position)
        )
    ]

    per: dict[int, dict[str, int]] = {}

    def bucket(user_id: int) -> dict[str, int]:
        return per.setdefault(user_id, dict.fromkeys(("saves", "boxes", "submitted", "approved", "rejected",
                                                      "reviewed"), 0))

    for (uid,) in session.execute(select(ProjectMember.user_id).where(ProjectMember.project_id == project_id)):
        bucket(uid)
    for uid, n in session.execute(
        select(Activity.user_id, func.sum(Activity.count)).where(
            Activity.project_id == project_id, Activity.type == "annotation_saved", Activity.user_id.is_not(None))
        .group_by(Activity.user_id)
    ):
        bucket(uid)["saves"] = int(n or 0)
    for uid, n in session.execute(
        select(Image.last_editor_id, func.sum(Image.box_count)).where(
            Image.project_id == project_id, live, Image.last_editor_id.is_not(None)).group_by(Image.last_editor_id)
    ):
        bucket(uid)["boxes"] = int(n or 0)
    status_events = (Activity.project_id == project_id, Activity.type == "status_changed")
    for uid, submitted, reviewed in session.execute(
        select(Activity.user_id,
               func.sum(case((Activity.action == "submit", 1), else_=0)),
               func.sum(case((Activity.action.in_(("approve", "reject")), 1), else_=0)))
        .where(*status_events, Activity.user_id.is_not(None)).group_by(Activity.user_id)
    ):
        b = bucket(uid)
        b["submitted"], b["reviewed"] = int(submitted or 0), int(reviewed or 0)
    for uid, approved, rejected in session.execute(
        select(Activity.subject_user_id,
               func.sum(case((Activity.action == "approve", 1), else_=0)),
               func.sum(case((Activity.action == "reject", 1), else_=0)))
        .where(*status_events, Activity.subject_user_id.is_not(None)).group_by(Activity.subject_user_id)
    ):
        b = bucket(uid)
        b["approved"], b["rejected"] = int(approved or 0), int(rejected or 0)
    users = serialize.briefs(session, per)
    per_user = [{"user": users[uid], **counts} for uid, counts in per.items() if uid in users]
    per_user.sort(key=lambda r: (r["user"]["display_name"].casefold(), r["user"]["id"]))

    daily = _daily(session, project_id, tz_offset_minutes)
    return {
        "status_counts": status_counts,
        "images_total": sum(status_counts.values()),
        "boxes_total": int(boxes_total),
        "class_counts": class_counts,
        "per_user": per_user,
        "daily": daily,
    }


def _daily(session: Session, project_id: int, tz_offset_minutes: int) -> list[dict[str, Any]]:
    """Saves and finished images per day for the last ``DAYS`` days of the viewer's calendar.

    Rows are bucketed in Python (portable across SQLite/PostgreSQL and any UTC offset, e.g. +05:30); the window
    is small (activity saves are already coalesced per user and image).
    """
    offset = timedelta(minutes=tz_offset_minutes)
    today = (utcnow() + offset).date()
    since = today - timedelta(days=DAYS - 1)
    start = datetime.combine(since, time.min) - offset  # naive UTC, like the stored timestamps
    daily = {(since + timedelta(days=i)).isoformat(): {"saves": 0, "done": 0} for i in range(DAYS)}
    rows = session.execute(
        select(Activity.created_at, Activity.type, Activity.count, Activity.data["to"].as_string())
        .where(Activity.project_id == project_id, Activity.created_at >= start,
               Activity.type.in_(("annotation_saved", "status_changed")))
    )
    for created_at, type_, count, to in rows:
        bucket = daily.get((created_at + offset).date().isoformat())
        if bucket is None:
            continue
        if type_ == "annotation_saved":
            bucket["saves"] += int(count or 0)
        elif to == "done":
            bucket["done"] += int(count or 0)
    return [{"date": d, **v} for d, v in daily.items()]
