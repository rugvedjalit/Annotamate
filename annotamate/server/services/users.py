"""Accounts and sessions."""

from __future__ import annotations

import hashlib
from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from annotamate.core.classes import PALETTE
from annotamate.server.errors import conflict
from annotamate.server.models import User, UserSession, utcnow
from annotamate.server.security import hash_password, hash_token, new_session_token

#: Sessions are refreshed (sliding expiry) at most this often.
SESSION_REFRESH = timedelta(minutes=5)


def default_avatar_color(username: str) -> str:
    digest = hashlib.sha256(username.encode("utf-8")).digest()
    return PALETTE[digest[0] % len(PALETTE)]


def user_count(session: Session) -> int:
    return session.scalar(select(func.count()).select_from(User)) or 0


def find_by_username(session: Session, username: str) -> User | None:
    return session.scalar(select(User).where(User.username == username.strip().lower()))


def create_user(session: Session, *, username: str, display_name: str, password: str, email: str | None = None,
                is_admin: bool = False) -> User:
    if find_by_username(session, username) is not None:
        raise conflict("exists", f"The username '{username}' is already taken.")
    user = User(
        username=username,
        display_name=display_name,
        email=email,
        password_hash=hash_password(password),
        is_admin=is_admin,
        is_active=True,
        avatar_color=default_avatar_color(username),
        settings={},
    )
    session.add(user)
    session.flush()
    return user


def create_session(session: Session, user: User, *, days: int, ip: str | None, user_agent: str | None) -> str:
    """Persist a new session and return the raw token for the cookie."""
    token, token_hash = new_session_token()
    now = utcnow()
    session.add(UserSession(
        user_id=user.id, token_hash=token_hash, created_at=now, last_used_at=now,
        expires_at=now + timedelta(days=days), ip=(ip or "")[:64] or None, user_agent=(user_agent or "")[:255] or None,
    ))
    user.last_seen_at = now
    return token


def lookup_session(session: Session, token: str | None) -> tuple[UserSession, User] | None:
    """The live session and its (active) user for a cookie token."""
    if not token or len(token) > 256:
        return None
    row = session.execute(
        select(UserSession, User).join(User, User.id == UserSession.user_id)
        .where(UserSession.token_hash == hash_token(token))
    ).first()
    if row is None:
        return None
    user_session, user = row
    if user_session.expires_at <= utcnow() or not user.is_active:
        return None
    return user_session, user


def touch_session(user_session: UserSession, user: User, days: int, max_days: int | None = None) -> bool:
    """Slide the expiry forward (never past ``created_at + max_days``); True when the cookie should be re-sent."""
    now = utcnow()
    if now - user_session.last_used_at < SESSION_REFRESH:
        return False
    user_session.last_used_at = now
    expires = now + timedelta(days=days)
    if max_days is not None:
        expires = min(expires, user_session.created_at + timedelta(days=max_days))
    user_session.expires_at = expires
    user.last_seen_at = now
    return True


def revoke_sessions(session: Session, user_id: int, *, keep_session_id: int | None = None) -> set[int]:
    """Delete a user's sessions (optionally keeping one); returns the revoked session ids."""
    query = select(UserSession.id).where(UserSession.user_id == user_id)
    if keep_session_id is not None:
        query = query.where(UserSession.id != keep_session_id)
    ids = set(session.scalars(query))
    if ids:
        session.execute(delete(UserSession).where(UserSession.id.in_(ids)))
    return ids


def purge_expired_sessions(session: Session) -> None:
    session.execute(delete(UserSession).where(UserSession.expires_at <= utcnow()))
