"""Image index queries (filters, pagination, neighbours) and workflow changes (status, assignment, bulk)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import ColumnElement, DateTime, and_, bindparam, exists, func, literal, or_, select, update
from sqlalchemy.orm import Session

from annotamate.server.context import AppContext
from annotamate.server.db import emit
from annotamate.server.errors import bad_request, forbidden, not_found, validation_error
from annotamate.server.models import Image, ImageClassCount, ProjectMember, User, utcnow
from annotamate.server.schemas import STATUSES, ImageFilterIn
from annotamate.server.services import notify, serialize
from annotamate.server.services.access import EDIT_ROLES, REVIEW_ROLES, ProjectAccess
from annotamate.server.services.comments import create_comment

_EPOCH = datetime(1970, 1, 1)


@dataclass
class ImageFilter:
    q: str | None = None
    statuses: list[str] | None = None
    assignee: str | int | None = None  # "me", "none" or a user id
    flagged: bool | None = None
    class_id: int | None = None
    has_comments: str | None = None    # "open" or "any"
    sort: str = "name"

    @classmethod
    def build(cls, *, q: str | None = None, status: str | list[str] | None = None, assignee: str | int | None = None,
              flagged: bool | None = None, class_id: int | None = None, has_comments: str | None = None,
              sort: str = "name", loc: str = "query") -> ImageFilter:
        statuses: list[str] | None = None
        if status:
            raw = status.split(",") if isinstance(status, str) else status
            statuses = [s.strip() for s in raw if s.strip()]
            bad = [s for s in statuses if s not in STATUSES]
            if bad:
                raise validation_error([loc, "status"], f"Unknown status {bad[0]!r}.")
        parsed_assignee: str | int | None = None
        if assignee is not None and assignee != "":
            if isinstance(assignee, int) or (str(assignee).isascii() and str(assignee).isdigit()):
                parsed_assignee = int(assignee)
            elif assignee in ("me", "none"):
                parsed_assignee = assignee
            else:
                raise validation_error([loc, "assignee"], "assignee must be 'me', 'none' or a user id.")
        if has_comments not in (None, "", "open", "any"):
            raise validation_error([loc, "has_comments"], "has_comments must be 'open' or 'any'.")
        if sort not in ("name", "updated"):
            raise validation_error([loc, "sort"], "sort must be 'name' or 'updated'.")
        return cls(q=(q or "").strip() or None, statuses=statuses, assignee=parsed_assignee, flagged=flagged,
                   class_id=class_id, has_comments=has_comments or None, sort=sort)

    @classmethod
    def from_body(cls, body: ImageFilterIn | None) -> ImageFilter:
        if body is None:
            return cls()
        return cls.build(q=body.q, status=body.status, assignee=body.assignee, flagged=body.flagged,
                         class_id=body.class_id, has_comments=body.has_comments, sort=body.sort, loc="filter")

    def conditions(self, project_id: int, user_id: int) -> list[ColumnElement[bool]]:
        conds: list[ColumnElement[bool]] = [Image.project_id == project_id, Image.missing.is_(False)]
        if self.q:
            pattern = "%" + self.q.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            conds.append(func.lower(Image.rel_path).like(pattern, escape="\\"))
        if self.statuses:
            conds.append(Image.status.in_(self.statuses))
        if self.assignee == "me":
            conds.append(Image.assignee_id == user_id)
        elif self.assignee == "none":
            conds.append(Image.assignee_id.is_(None))
        elif isinstance(self.assignee, int):
            conds.append(Image.assignee_id == self.assignee)
        if self.flagged is not None:
            conds.append(Image.flagged.is_(self.flagged))
        if self.class_id is not None:
            conds.append(exists().where(ImageClassCount.image_id == Image.id,
                                        ImageClassCount.class_id == self.class_id))
        if self.has_comments == "open":
            conds.append(Image.open_comment_count > 0)
        elif self.has_comments == "any":
            conds.append(Image.comment_count > 0)
        return conds


def _updated_key() -> ColumnElement:
    return func.coalesce(Image.updated_at, literal(_EPOCH, DateTime()))


def order_by(sort: str) -> list[ColumnElement]:
    if sort == "updated":
        return [_updated_key().desc(), Image.sort_index.asc()]
    return [Image.sort_index.asc()]


def list_images(session: Session, access: ProjectAccess, flt: ImageFilter, offset: int, limit: int) -> dict[str, Any]:
    conds = flt.conditions(access.project.id, access.user.id)
    total = session.scalar(select(func.count()).select_from(Image).where(*conds)) or 0
    rows = list(session.scalars(select(Image).where(*conds).order_by(*order_by(flt.sort)).offset(offset).limit(limit)))
    return {"total": total, "offset": offset, "items": serialize.image_items(session, rows)}


def neighbors(session: Session, access: ProjectAccess, image: Image, flt: ImageFilter) -> dict[str, Any]:
    conds = flt.conditions(access.project.id, access.user.id)
    if flt.sort == "updated":
        key = _updated_key()
        current = image.updated_at or _EPOCH
        before = or_(key > current, and_(key == current, Image.sort_index < image.sort_index))
        after = or_(key < current, and_(key == current, Image.sort_index > image.sort_index))
        prev_order = [key.asc(), Image.sort_index.desc()]
        next_order = [key.desc(), Image.sort_index.asc()]
    else:
        before = Image.sort_index < image.sort_index
        after = Image.sort_index > image.sort_index
        prev_order = [Image.sort_index.desc()]
        next_order = [Image.sort_index.asc()]
    prev_id = session.scalar(select(Image.id).where(*conds, before).order_by(*prev_order).limit(1))
    next_id = session.scalar(select(Image.id).where(*conds, after).order_by(*next_order).limit(1))
    total = session.scalar(select(func.count()).select_from(Image).where(*conds)) or 0
    included = session.scalar(select(Image.id).where(*conds, Image.id == image.id)) is not None
    index = (session.scalar(select(func.count()).select_from(Image).where(*conds, before)) or 0) if included else -1
    return {"prev_id": prev_id, "next_id": next_id, "index": index, "total": total}


def get_image(session: Session, project_id: int, image_id: int) -> Image:
    image = session.get(Image, image_id)
    if image is None or image.project_id != project_id or image.missing:
        raise not_found("Image not found.")
    return image


def _broadcast_image(session: Session, image: Image, actor: User) -> dict[str, Any]:
    session.flush()
    item = serialize.image_item(session, image)
    emit(session, ("project", image.project_id), {"type": "image.updated", "project_id": image.project_id,
                                                  "image": item, "by": serialize.brief(actor)})
    return item


def editor_member(session: Session, project_id: int, user_id: int) -> User:
    """A project member who can annotate (target of assignments)."""
    row = session.execute(
        select(User, ProjectMember.role).join(ProjectMember, ProjectMember.user_id == User.id)
        .where(ProjectMember.project_id == project_id, User.id == user_id)
    ).first()
    if row is None or not row[0].is_active:
        raise bad_request("The assignee must be an active member of the project.")
    if row[1] not in EDIT_ROLES:
        raise bad_request("Viewers cannot be assigned images.")
    return row[0]


def patch_image(session: Session, access: ProjectAccess, image: Image, fields: dict[str, Any]) -> dict[str, Any]:
    user, project = access.user, access.project
    if "flagged" in fields and fields["flagged"] is not None and fields["flagged"] != image.flagged:
        access.require_edit()
        if access.restricted_annotator and image.assignee_id not in (None, user.id):
            raise forbidden("This image is assigned to someone else.")
        image.flagged = bool(fields["flagged"])
        notify.record(session, project.id, "flagged", user=user, image_id=image.id, data={"flagged": image.flagged})
    if "assignee_id" in fields and fields["assignee_id"] != image.assignee_id:
        target_id = fields["assignee_id"]
        if not access.can_manage:
            access.require_edit()
            claim = target_id == user.id and image.assignee_id is None
            unclaim = target_id is None and image.assignee_id == user.id
            if not (claim or unclaim):
                raise forbidden("Only managers can assign images to other people.")
        assignee = editor_member(session, project.id, target_id) if target_id is not None else None
        image.assignee_id = target_id
        notify.record(session, project.id, "assigned", user=user, image_id=image.id,
                      data={"assignee": serialize.brief(assignee) if assignee else None},
                      subject_user_id=target_id)
        if assignee is not None:
            notify.notify(session, [assignee.id], "assignment", f"{user.display_name} assigned you {image.filename}",
                          actor=user, project=project, image_id=image.id)
    return _broadcast_image(session, image, user)


def _owner_ids(image: Image) -> list[int]:
    return [uid for uid in (image.done_by_id or image.assignee_id,) if uid is not None]


def change_status(ctx: AppContext, session: Session, access: ProjectAccess, image: Image, action: str,
                  comment: str | None) -> dict[str, Any]:
    """Apply a workflow action (architecture.md section 6)."""
    user, project = access.user, access.project
    old = image.status
    subject: int | None = None
    if action == "submit":
        access.require_edit()
        if access.restricted_annotator and image.assignee_id not in (None, user.id):
            raise forbidden("This image is assigned to someone else.")
        if old not in ("todo", "in_progress", "rejected"):
            raise bad_request(f"An image in '{old}' cannot be submitted.")
        new = "review" if project.require_review else "done"
        image.done_by_id = user.id
    elif action in ("approve", "reject"):
        access.require_review()
        if old != "review":
            raise bad_request("Only images waiting for review can be approved or rejected.")
        if action == "reject" and not (comment or "").strip():
            raise bad_request("A comment explaining the rejection is required.")
        new = "done" if action == "approve" else "rejected"
        subject = (_owner_ids(image) or [None])[0]
    elif action == "reopen":
        owns = user.id in (image.assignee_id, image.done_by_id)
        if not (access.can_review or (access.can_edit and owns)):
            raise forbidden("Only the annotator who owns the image or a reviewer can reopen it.")
        if old not in ("done", "review"):
            raise bad_request(f"An image in '{old}' cannot be reopened.")
        new = "in_progress"
    else:  # pragma: no cover - validated by the schema
        raise bad_request("Unknown action.")

    image.status = new
    image.updated_at = utcnow()
    data: dict[str, Any] = {"from": old, "to": new, "action": action}
    if comment and comment.strip():
        data["comment"] = notify.preview(comment, 200)
    notify.record(session, project.id, "status_changed", user=user, image_id=image.id, data=data, action=action,
                  subject_user_id=subject)
    if action == "submit" and new == "review":
        reviewers = session.scalars(select(ProjectMember.user_id).where(
            ProjectMember.project_id == project.id, ProjectMember.role.in_(REVIEW_ROLES)))
        notify.notify(session, list(reviewers), "review_requested",
                      f"{user.display_name} submitted {image.filename} for review", actor=user, project=project,
                      image_id=image.id)
    elif action == "approve":
        notify.notify(session, _owner_ids(image), "review_approved", f"{user.display_name} approved {image.filename}",
                      actor=user, project=project, image_id=image.id)
    elif action == "reject":
        reason = (comment or "").strip()
        create_comment(ctx, session, access, image, reason, None, notify_watchers=False)
        notify.notify(session, _owner_ids(image), "review_rejected",
                      f"{user.display_name} rejected {image.filename}: {notify.preview(reason)}", actor=user,
                      project=project, image_id=image.id)
    return _broadcast_image(session, image, user)


def _target_ids(session: Session, access: ProjectAccess, image_ids: list[int] | None, flt: ImageFilter | None,
                limit: int | None) -> list[int]:
    project_id = access.project.id
    if image_ids is not None:
        wanted = list(dict.fromkeys(image_ids))
        pairs: list[tuple[int, int]] = []
        for start in range(0, len(wanted), 500):
            pairs.extend(session.execute(select(Image.id, Image.sort_index).where(
                Image.project_id == project_id, Image.missing.is_(False),
                Image.id.in_(wanted[start:start + 500]))).all())
        if len(pairs) != len(wanted):
            raise bad_request("Some images do not belong to this project.")
        ids = [image_id for image_id, _ in sorted(pairs, key=lambda p: p[1])]
    else:
        assert flt is not None
        query = select(Image.id).where(*flt.conditions(project_id, access.user.id)).order_by(*order_by(flt.sort))
        ids = list(session.scalars(query))
    return ids[:limit] if limit else ids


def _chunked_update(session: Session, ids: list[int], **values: Any) -> None:
    for start in range(0, len(ids), 500):
        session.execute(update(Image).where(Image.id.in_(ids[start:start + 500])).values(**values)
                        .execution_options(synchronize_session=False))


def bulk(session: Session, access: ProjectAccess, *, image_ids: list[int] | None, flt: ImageFilter | None,
         action: str, assignee_id: int | None, status: str | None, user_ids: list[int] | None,
         limit: int | None) -> int:
    access.require_manage()
    user, project = access.user, access.project
    if image_ids is None and flt is None:
        raise bad_request("Provide image_ids or a filter.")
    ids = _target_ids(session, access, image_ids, flt, limit)
    now = utcnow()
    if action == "assign":
        if assignee_id is None:
            raise bad_request("assignee_id is required.")
        assignee = editor_member(session, project.id, assignee_id)
        _chunked_update(session, ids, assignee_id=assignee.id)
        notify.record(session, project.id, "assigned", user=user, count=len(ids), subject_user_id=assignee.id,
                      data={"count": len(ids), "assignee": serialize.brief(assignee)})
        if ids:
            notify.notify(session, [assignee.id], "assignment",
                          f"{user.display_name} assigned you {len(ids)} images in {project.name}", actor=user,
                          project=project)
    elif action == "unassign":
        _chunked_update(session, ids, assignee_id=None)
        notify.record(session, project.id, "assigned", user=user, count=len(ids),
                      data={"count": len(ids), "assignee": None})
    elif action in ("flag", "unflag"):
        _chunked_update(session, ids, flagged=action == "flag")
        notify.record(session, project.id, "flagged", user=user, count=len(ids),
                      data={"count": len(ids), "flagged": action == "flag"})
    elif action == "set_status":
        if status is None:
            raise bad_request("status is required.")
        values: dict[str, Any] = {"status": status, "updated_at": now}
        if status in ("done", "review"):
            values["done_by_id"] = user.id
        _chunked_update(session, ids, **values)
        notify.record(session, project.id, "status_changed", user=user, count=len(ids), action="set_status",
                      data={"to": status, "count": len(ids), "action": "set_status"})
    elif action == "distribute":
        members = [editor_member(session, project.id, uid) for uid in dict.fromkeys(user_ids or [])]
        if not members:
            raise bad_request("user_ids must list at least one member.")
        share, extra = divmod(len(ids), len(members))
        start = 0
        summary = []
        rows = []
        for n, member in enumerate(members):
            size = share + (1 if n < extra else 0)
            chunk = ids[start:start + size]
            start += size
            rows.extend({"_id": i, "_uid": member.id} for i in chunk)
            summary.append({"user": serialize.brief(member), "count": len(chunk)})
            if chunk:
                notify.notify(session, [member.id], "assignment",
                              f"{user.display_name} assigned you {len(chunk)} images in {project.name}", actor=user,
                              project=project)
        stmt = update(Image).where(Image.id == bindparam("_id")).values(assignee_id=bindparam("_uid"))
        for offset in range(0, len(rows), 1000):
            session.connection().execute(stmt, rows[offset:offset + 1000])
        notify.record(session, project.id, "assigned", user=user, count=len(ids),
                      data={"count": len(ids), "distribution": summary})
    else:  # pragma: no cover - validated by the schema
        raise bad_request("Unknown action.")
    emit(session, ("project", project.id), {"type": "images.bulk_updated", "project_id": project.id, "count": len(ids)})
    return len(ids)
