"""Turn ORM rows into the JSON shapes of api.md (batched to avoid N+1 queries)."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import Any

from sqlalchemy import LargeBinary, bindparam, func, literal, select
from sqlalchemy.orm import Session, aliased

from annotamate.server.models import (
    Activity,
    ChatMessage,
    Comment,
    DirectMessage,
    Image,
    ImageClassCount,
    Notification,
    Project,
    ProjectClass,
    ProjectMember,
    User,
)

Json = dict[str, Any]


def iso(value: datetime | None) -> str | None:
    """``2026-11-23T10:15:00Z`` (UTC, second precision)."""
    return value.strftime("%Y-%m-%dT%H:%M:%SZ") if value is not None else None


def brief(user: User) -> Json:
    return {"id": user.id, "username": user.username, "display_name": user.display_name,
            "avatar_color": user.avatar_color}


def user_out(user: User, online: bool | None = None) -> Json:
    out = {
        **brief(user),
        "email": user.email,
        "is_admin": user.is_admin,
        "is_active": user.is_active,
        "created_at": iso(user.created_at),
        "last_seen_at": iso(user.last_seen_at),
    }
    if online is not None:
        out["online"] = online
    return out


def user_brief_out(user: User, online: bool) -> Json:
    """What any signed-in user may see of another account: no email, no admin flag."""
    return {**brief(user), "online": online}


def briefs(session: Session, ids: Iterable[int | None]) -> dict[int, Json]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = session.execute(
        select(User.id, User.username, User.display_name, User.avatar_color).where(User.id.in_(wanted))
    )
    return {r.id: {"id": r.id, "username": r.username, "display_name": r.display_name,
                   "avatar_color": r.avatar_color} for r in rows}


def class_out(cls: ProjectClass) -> Json:
    return {"id": cls.id, "index": cls.position, "name": cls.name, "color": cls.color}


def image_refs(session: Session, ids: Iterable[int | None]) -> dict[int, Json]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    # Missing images are left out, so chat, activity and notifications show them like deleted ones (no link).
    rows = session.execute(select(Image.id, Image.filename).where(Image.id.in_(wanted), Image.missing.is_(False)))
    return {r.id: {"id": r.id, "filename": r.filename} for r in rows}


def class_ids_for(session: Session, image_ids: list[int]) -> dict[int, list[int]]:
    """Class ids present in each image, ordered by class index."""
    out: dict[int, list[int]] = {i: [] for i in image_ids}
    for start in range(0, len(image_ids), 500):
        chunk = image_ids[start:start + 500]
        rows = session.execute(
            select(ImageClassCount.image_id, ImageClassCount.class_id)
            .join(ProjectClass, ProjectClass.id == ImageClassCount.class_id)
            .where(ImageClassCount.image_id.in_(chunk))
            .order_by(ImageClassCount.image_id, ProjectClass.position)
        )
        for image_id, class_id in rows:
            out[image_id].append(class_id)
    return out


def _position_statements() -> tuple[Any, Any]:
    """The two statements of :func:`image_positions`, built once (building them costs more than running them)."""
    other = aliased(Image)
    in_scope = (other.project_id == bindparam("project_id"), other.missing == bindparam("missing"))
    # One image: the index entries before it.
    asked_key = select(Image.sort_key).where(Image.id == bindparam("image_id")).scalar_subquery()
    one = select(func.count()).select_from(other).where(*in_scope, other.sort_key < asked_key)
    # Several: put them in list order and count the entries after the previous one, up to and including each.
    asked = (select(Image.id, Image.sort_key,
                    func.lag(Image.sort_key).over(order_by=Image.sort_key).label("previous"))
             .where(Image.id.in_(bindparam("image_ids", expanding=True))).subquery())
    gap = (select(func.count()).select_from(other)
           .where(*in_scope, other.sort_key > func.coalesce(asked.c.previous, literal(b"", LargeBinary)),
                  other.sort_key <= asked.c.sort_key).scalar_subquery())
    return one, select(asked.c.id, gap).order_by(asked.c.sort_key)


_POSITION_OF_ONE, _POSITIONS_OF_MANY = _position_statements()


def image_positions(session: Session, images: list[Image]) -> dict[int, int]:
    """0-based position of each image in the natural order of its project (missing images come last).

    Positions are counted on the ``(project_id, missing, sort_key)`` index, never stored, so adding or
    removing images does not touch any other row. A single image costs one range count. Several images are
    put in list order and the index entries between each one and the one before it are counted: one statement,
    one pass over the part of the index from the start of the list to the last image asked for.
    """
    out: dict[int, int] = {}
    groups: dict[tuple[int, bool], list[int]] = {}
    for image in images:
        groups.setdefault((image.project_id, image.missing), []).append(image.id)
    for (project_id, missing), ids in groups.items():
        scope = {"project_id": project_id, "missing": missing}
        first = 0
        if missing:  # after every visible image
            first = session.scalar(select(func.count()).select_from(Image).where(
                Image.project_id == project_id, Image.missing.is_(False))) or 0
        if len(ids) == 1:
            out[ids[0]] = first + (session.scalar(_POSITION_OF_ONE, {**scope, "image_id": ids[0]}) or 0)
            continue
        position = first - 1
        for image_id, entries in session.execute(_POSITIONS_OF_MANY, {**scope, "image_ids": ids}):
            position += entries
            out[image_id] = position
    return out


def image_items(session: Session, images: list[Image], positions: dict[int, int] | None = None) -> list[Json]:
    """``positions``: the images' positions when the caller already knows them (see :func:`image_positions`)."""
    users = briefs(session, [i.assignee_id for i in images] + [i.last_editor_id for i in images])
    classes = class_ids_for(session, [i.id for i in images])
    if positions is None:
        positions = image_positions(session, list(images))
    return [
        {
            "id": img.id,
            "filename": img.filename,
            "rel_path": img.rel_path,
            "position": positions.get(img.id, 0),
            "status": img.status,
            "box_count": img.box_count,
            "class_ids": classes.get(img.id, []),
            "assignee": users.get(img.assignee_id) if img.assignee_id else None,
            "flagged": img.flagged,
            "comment_count": img.comment_count,
            "open_comment_count": img.open_comment_count,
            "last_editor": users.get(img.last_editor_id) if img.last_editor_id else None,
            "updated_at": iso(img.updated_at),
        }
        for img in images
    ]


def image_item(session: Session, image: Image) -> Json:
    return image_items(session, [image])[0]


def chat_messages(session: Session, messages: list[ChatMessage]) -> list[Json]:
    users = briefs(session, [m.user_id for m in messages])
    refs = image_refs(session, [m.image_id for m in messages])
    return [
        {
            "id": m.id,
            "project_id": m.project_id,
            "user": users[m.user_id],
            "body": "" if m.deleted else m.body,
            "image": refs.get(m.image_id) if m.image_id else None,
            "mentions": [] if m.deleted else list(m.mentions or []),
            "created_at": iso(m.created_at),
            "edited_at": iso(m.edited_at),
            "deleted": m.deleted,
        }
        for m in messages
    ]


def comments(session: Session, rows: list[Comment], *, with_image: bool = False) -> list[Json]:
    users = briefs(session, [c.user_id for c in rows])
    refs = image_refs(session, [c.image_id for c in rows]) if with_image else {}
    out = []
    for c in rows:
        item: Json = {
            "id": c.id,
            "project_id": c.project_id,
            "image_id": c.image_id,
            "user": users[c.user_id],
            "body": "" if c.deleted else c.body,
            "pin": {"x": c.pin_x, "y": c.pin_y} if c.pin_x is not None and c.pin_y is not None else None,
            "resolved": c.resolved,
            "mentions": [] if c.deleted else list(c.mentions or []),
            "created_at": iso(c.created_at),
            "edited_at": iso(c.edited_at),
            "deleted": c.deleted,
        }
        if with_image:
            item["image"] = refs.get(c.image_id, {"id": c.image_id, "filename": ""})
        out.append(item)
    return out


def direct_message(m: DirectMessage) -> Json:
    return {"id": m.id, "sender_id": m.sender_id, "recipient_id": m.recipient_id, "body": m.body,
            "created_at": iso(m.created_at), "read_at": iso(m.read_at)}


def notifications(session: Session, rows: list[Notification]) -> list[Json]:
    users = briefs(session, [n.actor_id for n in rows])
    refs = image_refs(session, [n.image_id for n in rows])
    project_ids = {n.project_id for n in rows if n.project_id is not None}
    projects = {p.id: {"id": p.id, "name": p.name} for p in
                session.scalars(select(Project).where(Project.id.in_(project_ids)))} if project_ids else {}
    # Links (and the project's current name) only for projects the recipient can still open; a user who left
    # keeps the notification text written back then, nothing newer.
    recipients = {n.user_id for n in rows}
    admins: set[int] = set()
    memberships: set[tuple[int, int]] = set()
    if recipients:
        admins = set(session.scalars(select(User.id).where(User.id.in_(recipients), User.is_admin.is_(True))))
    if recipients and project_ids:
        query = select(ProjectMember.user_id, ProjectMember.project_id).where(
            ProjectMember.user_id.in_(recipients), ProjectMember.project_id.in_(project_ids))
        memberships = {(uid, pid) for uid, pid in session.execute(query)}

    def visible(n: Notification) -> bool:
        return n.project_id is None or n.user_id in admins or (n.user_id, n.project_id) in memberships

    return [
        {
            "id": n.id,
            "type": n.type,
            "actor": users.get(n.actor_id) if n.actor_id else None,
            "project": projects.get(n.project_id) if n.project_id and visible(n) else None,
            "image": refs.get(n.image_id) if n.image_id and visible(n) else None,
            "text": n.text,
            "created_at": iso(n.created_at),
            "read_at": iso(n.read_at),
        }
        for n in rows
    ]


def activities(session: Session, rows: list[Activity]) -> list[Json]:
    users = briefs(session, [a.user_id for a in rows])
    refs = image_refs(session, [a.image_id for a in rows])
    return [
        {
            "id": a.id,
            "type": a.type,
            "user": users.get(a.user_id) if a.user_id else None,
            "image": refs.get(a.image_id) if a.image_id else None,
            "data": dict(a.data or {}),
            "created_at": iso(a.created_at),
        }
        for a in rows
    ]
