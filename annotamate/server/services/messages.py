"""Project chat and direct messages."""

from __future__ import annotations

from typing import Any

from sqlalchemy import case, delete, func, or_, select, update
from sqlalchemy.orm import Session

from annotamate.server.db import emit
from annotamate.server.errors import bad_request, forbidden, not_found
from annotamate.server.models import ChatMessage, ChatRead, DirectMessage, Image, Notification, User, utcnow
from annotamate.server.services import notify, serialize
from annotamate.server.services.access import ProjectAccess


def page(query, id_column, before_id: int | None, limit: int, session: Session) -> tuple[list, bool]:
    """Newest ``limit`` rows older than ``before_id``, returned oldest first, plus ``has_more``."""
    if before_id is not None:
        query = query.where(id_column < before_id)
    rows = list(session.scalars(query.order_by(id_column.desc()).limit(limit + 1)))
    has_more = len(rows) > limit
    rows = rows[:limit]
    rows.reverse()
    return rows, has_more


# ------------------------------------------------------------------------------------------- project chat


def mark_chat_read(session: Session, project_id: int, user_id: int, last_id: int) -> None:
    marker = session.get(ChatRead, (project_id, user_id))
    if marker is None:
        session.add(ChatRead(project_id=project_id, user_id=user_id, last_read_id=max(0, last_id)))
    elif last_id > marker.last_read_id:
        marker.last_read_id = last_id


def _chat_mentions(session: Session, access: ProjectAccess, message: ChatMessage, user_ids: list[int]) -> None:
    user = access.user
    notify.notify(session, user_ids, "mention",
                  f"{user.display_name} mentioned you in {access.project.name} chat: {notify.preview(message.body)}",
                  actor=user, project=access.project, image_id=message.image_id)


def post_chat(session: Session, access: ProjectAccess, body: str, image_id: int | None) -> dict[str, Any]:
    project, user = access.project, access.user
    if image_id is not None:
        image = session.get(Image, image_id)
        if image is None or image.project_id != project.id or image.missing:
            raise bad_request("The shared image is not part of this project.")
    mentions = notify.parse_mentions(session, body, project_id=project.id)
    message = ChatMessage(project_id=project.id, user_id=user.id, body=body, image_id=image_id, mentions=mentions)
    session.add(message)
    session.flush()
    mark_chat_read(session, project.id, user.id, message.id)
    _chat_mentions(session, access, message, mentions)
    out = serialize.chat_messages(session, [message])[0]
    emit(session, ("project", project.id), {"type": "chat.message", "message": out})
    return out


def get_chat_message(session: Session, project_id: int, message_id: int) -> ChatMessage:
    message = session.get(ChatMessage, message_id)
    if message is None or message.project_id != project_id:
        raise not_found("Message not found.")
    return message


def edit_chat(session: Session, access: ProjectAccess, message: ChatMessage, body: str) -> dict[str, Any]:
    if message.deleted:
        raise not_found("Message not found.")
    if message.user_id != access.user.id:
        raise forbidden("Only the author can edit a message.")
    previous = set(message.mentions or [])
    message.body = body
    message.edited_at = utcnow()
    message.mentions = notify.parse_mentions(session, body, project_id=message.project_id)
    _chat_mentions(session, access, message, [m for m in message.mentions if m not in previous])
    session.flush()
    out = serialize.chat_messages(session, [message])[0]
    emit(session, ("project", message.project_id), {"type": "chat.updated", "message": out})
    return out


def delete_chat(session: Session, access: ProjectAccess, message: ChatMessage) -> None:
    if message.deleted:
        return
    if message.user_id != access.user.id and not access.can_manage:
        raise forbidden("Only the author or a manager can delete a message.")
    message.deleted = True
    message.body = ""
    message.mentions = []
    session.flush()
    out = serialize.chat_messages(session, [message])[0]
    emit(session, ("project", message.project_id), {"type": "chat.updated", "message": out})


# ------------------------------------------------------------------------------------------- direct messages


def conversations(session: Session, me: User) -> list[dict[str, Any]]:
    other = case((DirectMessage.sender_id == me.id, DirectMessage.recipient_id), else_=DirectMessage.sender_id)
    latest = dict(session.execute(
        select(other, func.max(DirectMessage.id))
        .where(or_(DirectMessage.sender_id == me.id, DirectMessage.recipient_id == me.id)).group_by(other)
    ).all())
    if not latest:
        return []
    unread = dict(session.execute(
        select(DirectMessage.sender_id, func.count()).where(DirectMessage.recipient_id == me.id,
                                                            DirectMessage.read_at.is_(None))
        .group_by(DirectMessage.sender_id)).all())
    messages = {m.id: m for m in session.scalars(select(DirectMessage).where(DirectMessage.id.in_(latest.values())))}
    users = serialize.briefs(session, latest)
    out = [
        {"user": users[uid], "last_message": serialize.direct_message(messages[mid]),
         "unread_count": unread.get(uid, 0)}
        for uid, mid in latest.items() if uid in users
    ]
    out.sort(key=lambda c: c["last_message"]["id"], reverse=True)
    return out


def get_other_user(session: Session, user_id: int) -> User:
    user = session.get(User, user_id)
    if user is None:
        raise not_found("User not found.")
    return user


def thread_query(me: User, other: User):
    return select(DirectMessage).where(or_(
        (DirectMessage.sender_id == me.id) & (DirectMessage.recipient_id == other.id),
        (DirectMessage.sender_id == other.id) & (DirectMessage.recipient_id == me.id),
    ))


def send_dm(session: Session, me: User, recipient: User, body: str) -> dict[str, Any]:
    if recipient.id == me.id:
        raise bad_request("You cannot message yourself.")
    if not recipient.is_active:
        raise bad_request("This account is deactivated.")
    message = DirectMessage(sender_id=me.id, recipient_id=recipient.id, body=body)
    session.add(message)
    session.flush()
    out = serialize.direct_message(message)
    emit(session, ("user", recipient.id), {"type": "dm.message", "message": out})
    emit(session, ("user", me.id), {"type": "dm.message", "message": out})

    mentioned = recipient.id in notify.parse_mentions(session, body)
    # One live notification per sender: replace the previous unread one with an updated summary.
    session.execute(delete(Notification).where(
        Notification.user_id == recipient.id, Notification.actor_id == me.id, Notification.type.in_(("dm", "mention")),
        Notification.project_id.is_(None), Notification.read_at.is_(None)))
    unread = session.scalar(select(func.count()).select_from(DirectMessage).where(
        DirectMessage.sender_id == me.id, DirectMessage.recipient_id == recipient.id,
        DirectMessage.read_at.is_(None))) or 1
    if mentioned:
        text = f"{me.display_name} mentioned you in a direct message: {notify.preview(body)}"
    elif unread > 1:
        text = f"{me.display_name} sent you {unread} messages: {notify.preview(body)}"
    else:
        text = f"{me.display_name} sent you a message: {notify.preview(body)}"
    notify.notify(session, [recipient.id], "mention" if mentioned else "dm", text, actor=me)
    return out


def mark_dm_read(session: Session, me: User, other: User) -> None:
    """Mark ``other``'s messages to ``me`` (and their DM notifications) read; tell both sides live (``dm.read``)."""
    now = utcnow()
    read = session.execute(update(DirectMessage).where(
        DirectMessage.sender_id == other.id, DirectMessage.recipient_id == me.id, DirectMessage.read_at.is_(None))
        .values(read_at=now).execution_options(synchronize_session=False)).rowcount
    cleared = session.execute(update(Notification).where(
        Notification.user_id == me.id, Notification.actor_id == other.id, Notification.type.in_(("dm", "mention")),
        Notification.project_id.is_(None), Notification.read_at.is_(None))
        .values(read_at=now).execution_options(synchronize_session=False)).rowcount
    if not (read or cleared):
        return
    event = {"type": "dm.read", "reader_id": me.id, "sender_id": other.id, "read_at": serialize.iso(now)}
    if read:
        emit(session, ("user", other.id), event)  # the sender's read receipt
    # The reader's tabs: conversation unread count and the notification badge.
    emit(session, ("user", me.id), {**event, "unread_count": notify.unread_count(session, me.id)})
