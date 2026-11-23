"""FastAPI dependencies: application context, DB session, current user, project access."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Path, Request
from sqlalchemy.orm import Session

from annotamate.server.context import AppContext
from annotamate.server.errors import ApiError, forbidden
from annotamate.server.models import User
from annotamate.server.security import SESSION_COOKIE
from annotamate.server.services.access import ProjectAccess, load_access
from annotamate.server.services.users import lookup_session, touch_session


def get_ctx(request: Request) -> AppContext:
    return request.app.state.ctx


Ctx = Annotated[AppContext, Depends(get_ctx)]


def get_db(ctx: Ctx) -> Iterator[Session]:
    with ctx.db.session() as session:
        yield session


DB = Annotated[Session, Depends(get_db)]


def optional_user(request: Request, ctx: Ctx, db: DB) -> User | None:
    token = request.cookies.get(SESSION_COOKIE)
    found = lookup_session(db, token)
    if found is None:
        return None
    user_session, user = found
    request.state.session_id = user_session.id
    if touch_session(user_session, user, ctx.settings.session_days):
        db.commit()
        request.state.refresh_session = token
    return user


def current_user(user: Annotated[User | None, Depends(optional_user)]) -> User:
    if user is None:
        raise ApiError(401, "unauthenticated", "Please sign in.")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def admin_user(user: CurrentUser) -> User:
    if not user.is_admin:
        raise forbidden("Administrator access is required.")
    return user


AdminUser = Annotated[User, Depends(admin_user)]


def project_access(pid: Annotated[int, Path()], user: CurrentUser, db: DB) -> ProjectAccess:
    return load_access(db, user, pid)


Access = Annotated[ProjectAccess, Depends(project_access)]
