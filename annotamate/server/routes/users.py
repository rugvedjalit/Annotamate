"""User directory and administration."""

from fastapi import APIRouter, Response
from sqlalchemy import func, select

from annotamate.server.deps import DB, AdminUser, Ctx, CurrentUser
from annotamate.server.errors import bad_request, forbidden, not_found
from annotamate.server.models import ProjectMember, User
from annotamate.server.schemas import AdminPassword, UserBriefWithOnline, UserCreate, UserPatch, UserWithOnline
from annotamate.server.schemas import User as UserOut
from annotamate.server.security import hash_password
from annotamate.server.services import serialize
from annotamate.server.services.users import create_user, revoke_sessions

router = APIRouter(tags=["users"])


@router.get("/users", response_model=list[UserWithOnline] | list[UserBriefWithOnline])
def list_users(user: CurrentUser, ctx: Ctx, db: DB, include_inactive: bool = False) -> list[dict]:
    """Administrators get every field; everyone else gets ``id, username, display_name, avatar_color, online``."""
    if include_inactive and not user.is_admin:
        raise forbidden("Only administrators can list deactivated accounts.")
    query = select(User)
    if not include_inactive:
        query = query.where(User.is_active.is_(True))
    online = set(ctx.hub.online_user_ids())
    rows = db.scalars(query.order_by(func.lower(User.display_name), User.id))
    if user.is_admin:
        return [serialize.user_out(u, online=u.id in online) for u in rows]
    return [serialize.user_brief_out(u, u.id in online) for u in rows]


@router.post("/users", response_model=UserOut)
def add_user(body: UserCreate, _admin: AdminUser, db: DB) -> dict:
    user = create_user(db, username=body.username, display_name=body.display_name, password=body.password,
                       email=body.email, is_admin=body.is_admin)
    db.commit()
    return serialize.user_out(user)


def _get_user(db: DB, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise not_found("User not found.")
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
def edit_user(user_id: int, body: UserPatch, admin: AdminUser, ctx: Ctx, db: DB) -> dict:
    user = _get_user(db, user_id)
    fields = body.model_fields_set
    if user.id == admin.id and ((body.is_active is False) or (body.is_admin is False)):
        raise bad_request("You cannot deactivate or demote your own account.")
    if "display_name" in fields and body.display_name is not None:
        user.display_name = body.display_name
    if "email" in fields:
        user.email = body.email
    demoted = body.is_admin is False and user.is_admin
    if body.is_admin is not None:
        user.is_admin = body.is_admin
    deactivated = body.is_active is False and user.is_active
    if body.is_active is not None:
        user.is_active = body.is_active
    if deactivated:
        revoke_sessions(db, user.id)
    db.commit()
    if deactivated:
        ctx.hub.close_user(user.id)
        return serialize.user_out(user)
    ctx.hub.update_brief(user.id, serialize.brief(user))
    if demoted:  # no longer acts as manager everywhere: keep only real memberships and their rights
        roles = dict(db.execute(select(ProjectMember.project_id, ProjectMember.role)
                                .where(ProjectMember.user_id == user.id)).all())
        ctx.hub.evict_user_except(user.id, set(roles))
        ctx.hub.revoke_locks(user.id, {pid for pid, role in roles.items() if role == "viewer"}, serialize.brief(admin))
    return serialize.user_out(user)


@router.post("/users/{user_id}/password", status_code=204)
def reset_password(user_id: int, body: AdminPassword, _admin: AdminUser, ctx: Ctx, db: DB) -> Response:
    user = _get_user(db, user_id)
    user.password_hash = hash_password(body.new_password)
    revoked = revoke_sessions(db, user.id)
    db.commit()
    ctx.hub.close_sessions(revoked)
    return Response(status_code=204)
