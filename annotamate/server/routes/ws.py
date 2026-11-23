"""``/api/ws``: one realtime connection per browser tab (protocol in docs/api.md)."""

import asyncio
import contextlib
import json
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from annotamate.server.context import AppContext
from annotamate.server.errors import ApiError
from annotamate.server.models import Image, User, UserSession, utcnow
from annotamate.server.realtime import MAX_DROPPED_FRAMES, Connection
from annotamate.server.security import SESSION_COOKIE
from annotamate.server.services import serialize
from annotamate.server.services.access import ProjectAccess, load_access
from annotamate.server.services.users import lookup_session, touch_session

log = logging.getLogger("annotamate.realtime")
router = APIRouter()

MAX_FRAME = 64 * 1024


def origin_allowed(ws: WebSocket, secure: bool = False) -> bool:
    """Browsers always send ``Origin``; it must name the host the request was sent to.

    Only the ``Host`` header counts (proxies are configured to pass it on unchanged): ``X-Forwarded-Host`` could
    be supplied by the client itself. With ``secure`` (HTTPS deployment) the page must be an https page too.
    """
    origin = ws.headers.get("origin")
    if origin is None:
        return True  # non-browser client: the session cookie still authenticates it
    parts = urlsplit(origin)
    if parts.scheme not in ("http", "https") or (secure and parts.scheme != "https"):
        return False
    host = ws.headers.get("host", "").strip().lower()
    return bool(parts.netloc) and parts.netloc.lower() == host


def _authenticate(ctx: AppContext, token: str | None) -> tuple[int, int, dict[str, Any], bool] | None:
    with ctx.db.session() as session:
        found = lookup_session(session, token)
        if found is None:
            return None
        user_session, user = found
        if touch_session(user_session, user, ctx.settings.session_days, ctx.settings.session_max_days):
            session.commit()
        return user.id, user_session.id, serialize.brief(user), user.is_admin


def _session_alive(ctx: AppContext, session_id: int, days: int, max_days: int | None = None) -> bool:
    """The connection's session still exists, has not expired and belongs to an active user (and slides on)."""
    with ctx.db.session() as session:
        user_session = session.get(UserSession, session_id)
        user = session.get(User, user_session.user_id) if user_session is not None else None
        if user_session is None or user is None or not user.is_active or user_session.expires_at <= utcnow():
            return False
        if touch_session(user_session, user, days, max_days):
            session.commit()
        return True


def _access(session: Session, user_id: int, project_id: int) -> ProjectAccess | None:
    user = session.get(User, user_id)
    if user is None or not user.is_active:
        return None
    try:
        return load_access(session, user, project_id)
    except ApiError:
        return None


def _can_view(ctx: AppContext, user_id: int, project_id: int) -> bool:
    with ctx.db.session() as session:
        return _access(session, user_id, project_id) is not None


@dataclass
class LockRights:
    project_id: int
    can_edit: bool
    can_force: bool
    assigned_elsewhere: bool


def _lock_rights(ctx: AppContext, user_id: int, image_id: int) -> LockRights | None:
    """Current rights of the user on the image (checked on every request, roles can change)."""
    with ctx.db.session() as session:
        image = session.get(Image, image_id)
        if image is None or image.missing:
            return None
        access = _access(session, user_id, image.project_id)
        if access is None:
            return None
        elsewhere = access.restricted_annotator and image.assignee_id not in (None, user_id)
        return LockRights(image.project_id, access.can_edit, access.can_manage, elsewhere)


def _image_filename(ctx: AppContext, project_id: int, image_id: int) -> str | None:
    with ctx.db.session() as session:
        image = session.get(Image, image_id)
        if image is None or image.project_id != project_id or image.missing:
            return None
        return image.filename


def _int(value: Any) -> int | None:
    """A database id: a positive integer that fits a 64-bit column (anything else is ignored)."""
    if isinstance(value, int) and not isinstance(value, bool) and 0 < value < 2**63:
        return value
    return None


def _lock_still_allowed(ctx: AppContext, user_id: int, image_id: int) -> str | None:
    """``None`` while the user may still edit the image, otherwise why the lock must go."""
    rights = _lock_rights(ctx, user_id, image_id)
    if rights is None or not rights.can_edit:
        return "You can no longer edit this image."
    if rights.assigned_elsewhere:
        return "This image has been assigned to someone else."
    return None


async def _handle(ctx: AppContext, conn: Connection, message: dict[str, Any]) -> None:
    hub = ctx.hub
    kind = message.get("type")
    if kind == "ping":
        if not await run_in_threadpool(_session_alive, ctx, conn.session_id, ctx.settings.session_days,
                                     ctx.settings.session_max_days):
            hub.send(conn, {"type": "error", "code": "unauthenticated", "detail": "Your session has expired."})
            hub.close_sessions({conn.session_id})
            return
        for image_id in hub.locked_images(conn):  # rights can change while a lock is held (reassignment)
            reason = await run_in_threadpool(_lock_still_allowed, ctx, conn.user_id, image_id)
            if reason:
                hub.revoke(conn, image_id, reason)
        hub.renew(conn)
        hub.send(conn, {"type": "pong"})
    elif kind == "subscribe":
        project_id = _int(message.get("project_id"))
        if project_id is not None and project_id == conn.project_id:
            return  # already in that room
        if project_id is None or not await run_in_threadpool(_can_view, ctx, conn.user_id, project_id):
            hub.send(conn, {"type": "error", "code": "not_found", "detail": "Project not found."})
            return
        hub.join_room(conn, project_id)
    elif kind == "unsubscribe":
        hub.leave_room(conn)
    elif kind == "presence":
        image_id = _int(message.get("image_id"))
        project_id = conn.project_id
        if project_id is None:
            return
        filename = None
        if image_id is not None:
            filename = await run_in_threadpool(_image_filename, ctx, project_id, image_id)
            if filename is None:  # not an image of this project: show the user in the project only
                image_id = None
        if conn.project_id == project_id:  # still subscribed after the database round trip
            hub.set_presence(conn, image_id, filename)
    elif kind in ("lock.acquire", "lock.release"):
        image_id = _int(message.get("image_id"))
        if image_id is None:
            hub.send(conn, {"type": "error", "code": "bad_request", "detail": "image_id is required."})
            return
        if kind == "lock.release":
            hub.release(conn, image_id)
            return
        if conn.project_id is None:
            hub.send(conn, {"type": "error", "code": "forbidden", "detail": "Subscribe to the project first."})
            return
        rights = await run_in_threadpool(_lock_rights, ctx, conn.user_id, image_id)
        if rights is None or rights.project_id != conn.project_id:
            hub.send(conn, {"type": "error", "code": "not_found", "detail": "Image not found in this project."})
        elif not rights.can_edit:
            hub.send(conn, {"type": "error", "code": "forbidden", "detail": "Your role cannot edit annotations."})
        elif rights.assigned_elsewhere:
            hub.send(conn, {"type": "error", "code": "forbidden", "detail": "This image is assigned to someone else."})
        elif conn.project_id == rights.project_id:  # still subscribed after the database round trip
            hub.acquire(conn, image_id, bool(message.get("force")), rights.can_force)
    elif kind == "typing":
        hub.typing(conn, str(message.get("scope")), _int(message.get("user_id")))


@router.websocket("/ws")
async def websocket(ws: WebSocket) -> None:
    ctx: AppContext = ws.app.state.ctx
    if not origin_allowed(ws, ctx.settings.secure_cookies):
        await ws.close(code=1008)
        return
    auth = await run_in_threadpool(_authenticate, ctx, ws.cookies.get(SESSION_COOKIE))
    await ws.accept()
    if auth is None:
        await ws.send_json({"type": "error", "code": "unauthenticated", "detail": "Please sign in."})
        await ws.close(code=4401)
        return
    user_id, session_id, brief, is_admin = auth
    hub = ctx.hub
    if not hub.admits(user_id):
        await ws.send_json({"type": "error", "code": "rate_limited", "detail": "Too many open connections."})
        await ws.close(code=4429)
        return
    if hub.loop is None:
        hub.loop = asyncio.get_running_loop()
    conn = Connection(ws=ws, user_id=user_id, session_id=session_id, brief=brief, is_admin=is_admin)
    writer = asyncio.create_task(hub.writer(conn))
    hub.register(conn)
    try:
        while not writer.done():
            frame = await ws.receive()
            if frame["type"] == "websocket.disconnect":
                break
            raw = frame.get("text")
            if raw is None and frame.get("bytes") is not None:
                raw = frame["bytes"].decode("utf-8", "replace")
            if not raw:
                continue
            if not conn.take_frame():  # flooding: drop the frame, and close a client that keeps at it
                if conn.dropped == 1:
                    hub.send(conn, {"type": "error", "code": "rate_limited", "detail": "Too many messages."})
                if conn.dropped > MAX_DROPPED_FRAMES:
                    hub.send(conn, {"type": "error", "code": "rate_limited", "detail": "Closing: too many messages."})
                    with contextlib.suppress(Exception):
                        await ws.close(code=1008)
                    break
                continue
            if len(raw) > MAX_FRAME:
                hub.send(conn, {"type": "error", "code": "bad_request", "detail": "Frame too large."})
                continue
            try:
                message = json.loads(raw)
            except (ValueError, RecursionError):
                hub.send(conn, {"type": "error", "code": "bad_request", "detail": "Frames must be JSON."})
                continue
            if isinstance(message, dict):
                try:
                    await _handle(ctx, conn, message)
                except Exception:
                    log.exception("WebSocket handler failed")
                    hub.send(conn, {"type": "error", "code": "internal_error", "detail": "Internal error."})
            await asyncio.sleep(0)  # let the writers (this and other sockets) run between frames
    except Exception as exc:  # disconnects surface as various exceptions depending on the server
        log.debug("WebSocket closed: %r", exc)
    finally:
        hub.unregister(conn)
        writer.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await writer
