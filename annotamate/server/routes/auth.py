"""Setup, sign-in/out and the current user's profile and settings."""

import json
from typing import Any

from fastapi import APIRouter, Body, Request, Response

from annotamate.server.config import Settings
from annotamate.server.deps import DB, Ctx, CurrentUser, optional_user
from annotamate.server.errors import ApiError, bad_request
from annotamate.server.models import UserSession
from annotamate.server.schemas import AuthState, LoginIn, MePatch, PasswordChange, SetupIn, User
from annotamate.server.security import SESSION_COOKIE, hash_password, verify_password
from annotamate.server.services import serialize
from annotamate.server.services.users import (
    create_session,
    create_user,
    find_by_username,
    purge_expired_sessions,
    revoke_sessions,
    user_count,
)

router = APIRouter(tags=["auth"])

MAX_SETTINGS_BYTES = 64 * 1024


def set_session_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE, token, max_age=settings.session_days * 86400, path=settings.base_url, httponly=True,
        samesite="lax", secure=settings.secure_cookies,
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(SESSION_COOKIE, path=settings.base_url, httponly=True, samesite="lax",
                           secure=settings.secure_cookies)


def _client(request: Request) -> tuple[str, str | None]:
    return (request.client.host if request.client else "unknown"), request.headers.get("user-agent")


@router.get("/auth/state", response_model=AuthState)
def auth_state(request: Request, ctx: Ctx, db: DB) -> dict:
    user = optional_user(request, ctx, db)
    return {"setup_required": user_count(db) == 0, "user": serialize.user_out(user) if user else None}


@router.post("/auth/setup", response_model=User)
def setup(body: SetupIn, request: Request, response: Response, ctx: Ctx, db: DB) -> dict:
    if user_count(db) > 0:
        raise ApiError(409, "setup_done", "Setup has already been completed.")
    user = create_user(db, username=body.username, display_name=body.display_name, password=body.password,
                       is_admin=True)
    ip, agent = _client(request)
    token = create_session(db, user, days=ctx.settings.session_days, ip=ip, user_agent=agent)
    db.commit()
    set_session_cookie(response, ctx.settings, token)
    return serialize.user_out(user)


@router.post("/auth/login", response_model=User)
def login(body: LoginIn, request: Request, response: Response, ctx: Ctx, db: DB) -> dict:
    ip, agent = _client(request)
    username = body.username.strip().lower()
    wait = ctx.limiter.retry_after(ip, username)
    if wait:
        raise ApiError(429, "rate_limited", "Too many failed sign-in attempts. Try again later.",
                       headers={"Retry-After": str(wait)}, retry_after=wait)
    user = find_by_username(db, username)
    valid, rehash = verify_password(user.password_hash if user else None, body.password)
    if user is None or not valid:
        ctx.limiter.failure(ip, username)
        raise ApiError(401, "invalid_credentials", "Wrong username or password.")
    if not user.is_active:
        raise ApiError(403, "forbidden", "This account has been deactivated.")
    ctx.limiter.success(ip, username)
    if rehash:
        user.password_hash = hash_password(body.password)
    purge_expired_sessions(db)
    token = create_session(db, user, days=ctx.settings.session_days, ip=ip, user_agent=agent)
    db.commit()
    set_session_cookie(response, ctx.settings, token)
    return serialize.user_out(user)


@router.post("/auth/logout", status_code=204)
def logout(request: Request, ctx: Ctx, db: DB, _user: CurrentUser) -> Response:
    session_id = getattr(request.state, "session_id", None)
    if session_id is not None:
        row = db.get(UserSession, session_id)
        if row is not None:
            db.delete(row)
        db.commit()
        ctx.hub.close_sessions({session_id})
    request.state.refresh_session = None
    response = Response(status_code=204)
    clear_session_cookie(response, ctx.settings)
    return response


@router.get("/me", response_model=User)
def get_me(user: CurrentUser) -> dict:
    return serialize.user_out(user)


@router.patch("/me", response_model=User)
def patch_me(body: MePatch, user: CurrentUser, ctx: Ctx, db: DB) -> dict:
    fields = body.model_fields_set
    if "display_name" in fields and body.display_name is not None:
        user.display_name = body.display_name
    if "email" in fields:
        user.email = body.email
    if "avatar_color" in fields and body.avatar_color is not None:
        user.avatar_color = body.avatar_color.lower()
    db.commit()
    ctx.hub.update_brief(user.id, serialize.brief(user))
    return serialize.user_out(user)


@router.post("/me/password", status_code=204)
def change_password(body: PasswordChange, request: Request, user: CurrentUser, ctx: Ctx, db: DB) -> Response:
    valid, _ = verify_password(user.password_hash, body.current_password)
    if not valid:
        raise bad_request("The current password is wrong.")
    user.password_hash = hash_password(body.new_password)
    revoked = revoke_sessions(db, user.id, keep_session_id=getattr(request.state, "session_id", None))
    db.commit()
    ctx.hub.close_sessions(revoked)
    return Response(status_code=204)


@router.get("/me/settings")
def get_settings(user: CurrentUser) -> dict[str, Any]:
    return dict(user.settings or {})


@router.put("/me/settings")
def put_settings(user: CurrentUser, db: DB, body: dict[str, Any] = Body(...)) -> dict[str, Any]:
    if len(json.dumps(body, separators=(",", ":"))) > MAX_SETTINGS_BYTES:
        raise ApiError(413, "too_large", "Settings are limited to 64 KB.")
    user.settings = body
    db.commit()
    return body
