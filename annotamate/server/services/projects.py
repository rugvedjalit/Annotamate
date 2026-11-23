"""Projects: creation, settings, summaries and membership."""

from __future__ import annotations

import logging
import os
from typing import Any

from sqlalchemy import and_, func, select, update
from sqlalchemy.orm import Session

from annotamate.core.classes import next_color
from annotamate.server.context import AppContext
from annotamate.server.db import emit
from annotamate.server.errors import bad_request, conflict, forbidden, not_found
from annotamate.server.models import (
    ChatMessage,
    ChatRead,
    Image,
    Project,
    ProjectClass,
    ProjectMember,
    User,
    utcnow,
)
from annotamate.server.schemas import STATUSES, ProjectCreate, ProjectPatch
from annotamate.server.services import notify, serialize
from annotamate.server.services.access import ProjectAccess
from annotamate.server.services.classes import clean_name
from annotamate.server.services.indexing import index_project
from annotamate.server.services.labels import load_class_table, sync_classes_file
from annotamate.server.services.paths import ProjectPaths, resolve_in_roots

log = logging.getLogger("annotamate.projects")

SETTING_FIELDS = ("require_review", "restrict_to_assigned", "annotators_can_add_classes", "exif_mode", "recursive")
ACTIVITY_VALUE_FIELDS = frozenset({"name", "archived", *SETTING_FIELDS})


def project_settings(project: Project) -> dict[str, Any]:
    return {name: getattr(project, name) for name in SETTING_FIELDS}


def _resolve_label_dir(ctx: AppContext, label_dir: str | None, image_dir: str) -> str | None:
    if label_dir is None or not label_dir.strip():
        return None
    real = resolve_in_roots(ctx.settings, label_dir, what="Label folder")
    if os.path.exists(real) and not os.path.isdir(real):
        raise bad_request("The label folder path points to a file.")
    try:
        os.makedirs(real, exist_ok=True)
    except OSError as exc:
        raise bad_request(f"The label folder cannot be created ({exc.strerror or exc}).") from None
    return None if os.path.normcase(real) == os.path.normcase(image_dir) else real


# ------------------------------------------------------------------------------------------- summaries


def summaries(ctx: AppContext, session: Session, projects: list[Project], user: User) -> list[dict[str, Any]]:
    ids = [p.id for p in projects]
    if not ids:
        return []
    counts: dict[int, dict[str, int]] = {pid: dict.fromkeys(STATUSES, 0) for pid in ids}
    for pid, status, n in session.execute(
        select(Image.project_id, Image.status, func.count()).where(Image.project_id.in_(ids))
        .group_by(Image.project_id, Image.status)
    ):
        counts[pid][status] = n
    members = dict(session.execute(select(ProjectMember.project_id, func.count()).where(
        ProjectMember.project_id.in_(ids)).group_by(ProjectMember.project_id)).all())
    roles = dict(session.execute(select(ProjectMember.project_id, ProjectMember.role).where(
        ProjectMember.project_id.in_(ids), ProjectMember.user_id == user.id)).all())
    assigned = dict(session.execute(select(Image.project_id, func.count()).where(
        Image.project_id.in_(ids), Image.assignee_id == user.id, Image.status != "done")
        .group_by(Image.project_id)).all())
    unread = dict(session.execute(
        select(ChatMessage.project_id, func.count())
        .outerjoin(ChatRead, and_(ChatRead.project_id == ChatMessage.project_id, ChatRead.user_id == user.id))
        .where(ChatMessage.project_id.in_(ids), ChatMessage.user_id != user.id, ChatMessage.deleted.is_(False),
               ChatMessage.id > func.coalesce(ChatRead.last_read_id, 0))
        .group_by(ChatMessage.project_id)).all())
    previews = _member_previews(session, ids)
    return [
        {
            "id": p.id,
            "name": p.name,
            "description": p.description,
            "label_format": p.label_format,
            "image_count": sum(counts[p.id].values()),
            "status_counts": counts[p.id],
            "member_count": members.get(p.id, 0),
            "my_role": roles.get(p.id),
            "my_assigned_todo": assigned.get(p.id, 0),
            "unread_chat": unread.get(p.id, 0),
            "archived": p.archived,
            "indexing": ctx.is_indexing(p.id),
            "created_at": serialize.iso(p.created_at),
            "updated_at": serialize.iso(p.updated_at),
            "members_preview": previews.get(p.id, []),
        }
        for p in projects
    ]


PREVIEW_SIZE = 5
_ROLE_ORDER = {"manager": 0, "reviewer": 1, "annotator": 2, "viewer": 3}


def _member_previews(session: Session, project_ids: list[int]) -> dict[int, list[dict[str, Any]]]:
    """Up to ``PREVIEW_SIZE`` members per project for the project cards (managers first, then by name)."""
    rows = session.execute(
        select(ProjectMember.project_id, ProjectMember.role, User)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id.in_(project_ids))
    ).all()
    grouped: dict[int, list[tuple[int, str, User]]] = {}
    for pid, role, user in rows:
        grouped.setdefault(pid, []).append((_ROLE_ORDER.get(role, 9), user.display_name.casefold(), user))
    return {
        pid: [serialize.brief(u) for _, _, u in sorted(members, key=lambda m: (m[0], m[1], m[2].id))[:PREVIEW_SIZE]]
        for pid, members in grouped.items()
    }


def members_out(session: Session, project_id: int, user_ids: list[int] | None = None) -> list[dict[str, Any]]:
    query = (select(ProjectMember, User).join(User, User.id == ProjectMember.user_id)
             .where(ProjectMember.project_id == project_id))
    if user_ids is not None:
        query = query.where(ProjectMember.user_id.in_(user_ids))
    rows = session.execute(query).all()
    ids = [m.user_id for m, _ in rows]
    assigned = dict(session.execute(select(Image.assignee_id, func.count()).where(
        Image.project_id == project_id, Image.assignee_id.in_(ids)).group_by(Image.assignee_id)).all()) \
        if ids else {}
    done = dict(session.execute(select(Image.done_by_id, func.count()).where(
        Image.project_id == project_id, Image.done_by_id.in_(ids), Image.status.in_(("done", "review")))
        .group_by(Image.done_by_id)).all()) if ids else {}
    out = [
        {"user": serialize.brief(u), "role": m.role, "joined_at": serialize.iso(m.joined_at),
         "assigned_count": assigned.get(u.id, 0), "done_count": done.get(u.id, 0),
         "last_seen_at": serialize.iso(u.last_seen_at)}
        for m, u in rows
    ]
    out.sort(key=lambda m: (m["user"]["display_name"].casefold(), m["user"]["id"]))
    return out


def detail(ctx: AppContext, session: Session, access: ProjectAccess) -> dict[str, Any]:
    project = access.project
    out = summaries(ctx, session, [project], access.user)[0]
    table = load_class_table(session, project.id, project.label_format)
    manager = access.can_manage
    out.update({
        "image_dir": project.image_dir if manager else "",
        "label_dir": (project.label_dir if manager else "") if project.label_dir else None,
        "settings": project_settings(project),
        "classes": [serialize.class_out(c) for c in table.classes],
        "members": members_out(session, project.id),
        "permissions": access.permissions(),
    })
    return out


# ------------------------------------------------------------------------------------------- lifecycle


def create_project(ctx: AppContext, session: Session, creator: User, body: ProjectCreate) -> Project:
    image_dir = resolve_in_roots(ctx.settings, body.image_dir, what="Image folder")
    if not os.path.isdir(image_dir):
        raise bad_request("The image folder does not exist.")
    label_dir = _resolve_label_dir(ctx, body.label_dir, image_dir)
    settings = {"require_review": False, "restrict_to_assigned": False, "annotators_can_add_classes": True,
                "exif_mode": "apply", "recursive": False}
    if body.settings is not None:
        settings.update(body.settings.model_dump(exclude_none=True))
    class_names: list[str] | None = None
    if body.classes is not None:
        class_names = list(dict.fromkeys(clean_name(n) for n in body.classes))
    member_roles: dict[int, str] = {}
    for m in body.members or []:
        member_roles[m.user_id] = m.role
    member_roles[creator.id] = "manager"
    users = {u.id: u for u in session.scalars(select(User).where(User.id.in_(member_roles)))}
    missing = [uid for uid in member_roles if uid not in users or not users[uid].is_active]
    if missing:
        raise bad_request(f"Unknown or inactive user id {missing[0]}.")

    now = utcnow()
    project = Project(name=body.name, description=body.description, image_dir=image_dir, label_dir=label_dir,
                      label_format=body.label_format, created_by_id=creator.id, created_at=now, updated_at=now,
                      **settings)
    session.add(project)
    session.flush()
    for uid, role in member_roles.items():
        session.add(ProjectMember(project_id=project.id, user_id=uid, role=role, joined_at=now))
    if class_names:
        colors: list[str] = []
        for position, name in enumerate(class_names):
            color = next_color(colors)
            colors.append(color)
            session.add(ProjectClass(project_id=project.id, position=position, name=name, color=color))
        session.flush()
        try:
            sync_classes_file(ProjectPaths(ctx.settings, project), load_class_table(session, project.id,
                                                                                    project.label_format))
        except OSError as exc:
            log.warning("Could not write classes.txt for project %s: %s", project.id, exc)
    notify.record(session, project.id, "project_created", user=creator, data={"name": project.name})
    for uid, role in member_roles.items():
        if uid != creator.id:
            notify.notify(session, [uid], "project_added",
                          f"{creator.display_name} added you to {project.name} as {role}", actor=creator,
                          project=project)
    session.commit()
    index_project(ctx, project.id, discover_classes=class_names is None)
    return project


def update_project(ctx: AppContext, session: Session, access: ProjectAccess, body: ProjectPatch) -> None:
    access.require_manage()
    project = access.project
    fields = body.model_fields_set
    changed: list[str] = []
    reindex = False
    if "name" in fields and body.name is not None and body.name != project.name:
        project.name = body.name
        changed.append("name")
    if "description" in fields and body.description is not None and body.description != project.description:
        project.description = body.description
        changed.append("description")
    if "archived" in fields and body.archived is not None and body.archived != project.archived:
        project.archived = body.archived
        changed.append("archived")
    if "label_dir" in fields:
        if not access.user.is_admin:  # folder paths are only accepted from administrators (architecture.md 10)
            raise forbidden("Only administrators can change the label folder.")
        label_dir = _resolve_label_dir(ctx, body.label_dir, project.image_dir)
        if label_dir != project.label_dir:
            project.label_dir = label_dir
            changed.append("label_dir")
            reindex = True
    if body.settings is not None:
        for name, value in body.settings.model_dump(exclude_none=True).items():
            if getattr(project, name) != value:
                setattr(project, name, value)
                changed.append(name)
                reindex = reindex or name == "recursive"
    if not changed:
        return
    project.updated_at = utcnow()
    # New values for display (not paths or the free-text description).
    values = {name: getattr(project, name) for name in changed if name in ACTIVITY_VALUE_FIELDS}
    notify.record(session, project.id, "project_updated", user=access.user, data={"changes": changed, "values": values})
    emit(session, ("project", project.id), {"type": "project.updated", "project_id": project.id})
    session.commit()
    if reindex:
        index_project(ctx, project.id)


def delete_project(ctx: AppContext, session: Session, access: ProjectAccess) -> None:
    if not access.can_delete:
        raise forbidden("Only administrators can delete projects.")
    project_id = access.project.id
    with ctx.label_locks(project_id):
        session.delete(access.project)
        emit(session, ("project", project_id), {"type": "project.updated", "project_id": project_id})
        session.commit()
    ctx.hub.close_project(project_id)


# ------------------------------------------------------------------------------------------- members


def _member(session: Session, project_id: int, user_id: int) -> ProjectMember:
    member = session.get(ProjectMember, (project_id, user_id))
    if member is None:
        raise not_found("Member not found.")
    return member


def _manager_count(session: Session, project_id: int) -> int:
    return session.scalar(select(func.count()).select_from(ProjectMember).where(
        ProjectMember.project_id == project_id, ProjectMember.role == "manager")) or 0


def add_member(session: Session, access: ProjectAccess, user_id: int, role: str) -> dict[str, Any]:
    access.require_manage()
    project = access.project
    user = session.get(User, user_id)
    if user is None or not user.is_active:
        raise bad_request("Unknown or inactive user.")
    if session.get(ProjectMember, (project.id, user_id)) is not None:
        raise conflict("exists", f"{user.display_name} is already a member.")
    session.add(ProjectMember(project_id=project.id, user_id=user_id, role=role, joined_at=utcnow()))
    session.flush()
    notify.record(session, project.id, "member_added", user=access.user, subject_user_id=user_id,
                  data={"member": serialize.brief(user), "role": role})
    notify.notify(session, [user_id], "project_added",
                  f"{access.user.display_name} added you to {project.name} as {role}", actor=access.user,
                  project=project)
    emit(session, ("project", project.id), {"type": "members.updated", "project_id": project.id})
    return members_out(session, project.id, [user_id])[0]


def update_member(session: Session, access: ProjectAccess, user_id: int, role: str) -> dict[str, Any]:
    access.require_manage()
    project = access.project
    member = _member(session, project.id, user_id)
    if member.role == role:
        return members_out(session, project.id, [user_id])[0]
    if member.role == "manager" and _manager_count(session, project.id) <= 1:
        raise bad_request("A project needs at least one manager.")
    previous, member.role = member.role, role
    user = session.get(User, user_id)
    assert user is not None
    notify.record(session, project.id, "member_updated", user=access.user, subject_user_id=user_id,
                  data={"member": serialize.brief(user), "role": role, "previous_role": previous})
    emit(session, ("project", project.id), {"type": "members.updated", "project_id": project.id})
    session.flush()
    return members_out(session, project.id, [user_id])[0]


def remove_member(ctx: AppContext, session: Session, access: ProjectAccess, user_id: int) -> None:
    project = access.project
    if user_id != access.user.id:
        access.require_manage()
    member = _member(session, project.id, user_id)
    if member.role == "manager" and _manager_count(session, project.id) <= 1:
        raise bad_request("A project needs at least one manager.")
    user = session.get(User, user_id)
    assert user is not None
    session.delete(member)
    session.execute(update(Image).where(Image.project_id == project.id, Image.assignee_id == user_id)
                    .values(assignee_id=None).execution_options(synchronize_session=False))
    notify.record(session, project.id, "member_removed", user=access.user, subject_user_id=user_id,
                  data={"member": serialize.brief(user), "role": member.role})
    emit(session, ("project", project.id), {"type": "members.updated", "project_id": project.id})
    emit(session, ("project", project.id), {"type": "images.bulk_updated", "project_id": project.id, "count": 0})
    session.commit()
    if not user.is_admin:
        ctx.hub.evict_member(project.id, user_id)
