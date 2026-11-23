"""Image comment threads."""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from annotamate.server.context import AppContext
from annotamate.server.db import emit
from annotamate.server.errors import forbidden, not_found
from annotamate.server.models import Comment, Image, ProjectMember, User, utcnow
from annotamate.server.services import notify, serialize
from annotamate.server.services.access import ProjectAccess


def refresh_comment_counts(session: Session, image: Image) -> None:
    session.flush()
    live = [Comment.image_id == image.id, Comment.deleted.is_(False)]
    image.comment_count = session.scalar(select(func.count()).select_from(Comment).where(*live)) or 0
    image.open_comment_count = session.scalar(
        select(func.count()).select_from(Comment).where(*live, Comment.resolved.is_(False))) or 0


def _emit_comment(session: Session, comment: Comment, image: Image, kind: str, actor: User) -> dict[str, Any]:
    session.flush()
    out = serialize.comments(session, [comment])[0]
    emit(session, ("project", comment.project_id), {"type": kind, "comment": out})
    emit(session, ("project", comment.project_id), {"type": "image.updated", "project_id": comment.project_id,
                                                    "image": serialize.image_item(session, image),
                                                    "by": serialize.brief(actor)})
    return out


def _watchers(session: Session, image: Image, exclude: set[int]) -> list[int]:
    """Assignee and previous commenters who still have access to the project."""
    ids = set(session.scalars(select(Comment.user_id).where(Comment.image_id == image.id,
                                                            Comment.deleted.is_(False))))
    if image.assignee_id is not None:
        ids.add(image.assignee_id)
    ids -= exclude
    if not ids:
        return []
    members = set(session.scalars(select(ProjectMember.user_id).where(
        ProjectMember.project_id == image.project_id, ProjectMember.user_id.in_(ids))))
    admins = set(session.scalars(select(User.id).where(User.id.in_(ids), User.is_admin.is_(True))))
    active = set(session.scalars(select(User.id).where(User.id.in_(ids), User.is_active.is_(True))))
    return sorted((members | admins) & active)


def _notify_mentions(session: Session, access: ProjectAccess, image: Image, mention_ids: list[int],
                     body: str) -> None:
    user = access.user
    notify.notify(session, mention_ids, "mention",
                  f"{user.display_name} mentioned you in a comment on {image.filename}: {notify.preview(body)}",
                  actor=user, project=access.project, image_id=image.id)


def create_comment(ctx: AppContext, session: Session, access: ProjectAccess, image: Image, body: str,
                   pin: dict[str, float] | None, *, notify_watchers: bool = True) -> dict[str, Any]:
    user, project = access.user, access.project
    mentions = notify.parse_mentions(session, body, project_id=project.id)
    comment = Comment(project_id=project.id, image_id=image.id, user_id=user.id, body=body,
                      pin_x=pin["x"] if pin else None, pin_y=pin["y"] if pin else None, mentions=mentions)
    session.add(comment)
    session.flush()
    _notify_mentions(session, access, image, mentions, body)
    if notify_watchers:
        watchers = _watchers(session, image, exclude={user.id, *mentions})
        notify.notify(session, watchers, "comment",
                      f"{user.display_name} commented on {image.filename}: {notify.preview(body)}",
                      actor=user, project=project, image_id=image.id)
    notify.record(session, project.id, "comment_added", user=user, image_id=image.id,
                  data={"comment_id": comment.id, "preview": notify.preview(body)})
    refresh_comment_counts(session, image)
    return _emit_comment(session, comment, image, "comment.created", user)


def get_comment(session: Session, project_id: int, comment_id: int) -> Comment:
    comment = session.get(Comment, comment_id)
    if comment is None or comment.project_id != project_id:
        raise not_found("Comment not found.")
    return comment


def update_comment(session: Session, access: ProjectAccess, comment: Comment, *, body: str | None,
                   resolved: bool | None) -> dict[str, Any]:
    user = access.user
    if comment.deleted:
        raise not_found("Comment not found.")
    image = session.get(Image, comment.image_id)
    assert image is not None
    if body is not None and body != comment.body:
        if comment.user_id != user.id:
            raise forbidden("Only the author can edit a comment.")
        previous = set(comment.mentions or [])
        comment.body = body
        comment.edited_at = utcnow()
        comment.mentions = notify.parse_mentions(session, body, project_id=comment.project_id)
        _notify_mentions(session, access, image, [m for m in comment.mentions if m not in previous], body)
    if resolved is not None and resolved != comment.resolved:
        if not (access.can_edit or comment.user_id == user.id):
            raise forbidden("Your role cannot resolve comments.")
        comment.resolved = resolved
    refresh_comment_counts(session, image)
    return _emit_comment(session, comment, image, "comment.updated", user)


def delete_comment(session: Session, access: ProjectAccess, comment: Comment) -> None:
    if comment.deleted:
        return
    if comment.user_id != access.user.id and not access.can_manage:
        raise forbidden("Only the author or a manager can delete a comment.")
    image = session.get(Image, comment.image_id)
    assert image is not None
    comment.deleted = True
    comment.body = ""
    comment.mentions = []
    refresh_comment_counts(session, image)
    _emit_comment(session, comment, image, "comment.updated", access.user)
