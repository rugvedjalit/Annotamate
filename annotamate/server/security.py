"""Password hashing (argon2id), session tokens and login rate limiting."""

from __future__ import annotations

import contextlib
import hashlib
import secrets
import threading
import time
from collections import deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

SESSION_COOKIE = "annotamate_session"
CSRF_HEADER = "x-annotamate-client"
MIN_PASSWORD_LENGTH = 8

#: argon2id with the library's recommended parameters. Tests may swap in a cheaper instance.
hasher = PasswordHasher()
_dummy_hash: str | None = None


def hash_password(password: str) -> str:
    return hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> tuple[bool, bool]:
    """Return ``(valid, needs_rehash)``. Unknown users are checked against a dummy hash to keep timing flat."""
    global _dummy_hash
    if password_hash is None:
        if _dummy_hash is None:
            _dummy_hash = hasher.hash(secrets.token_hex(16))
        with contextlib.suppress(VerificationError, InvalidHashError):
            hasher.verify(_dummy_hash, password)
        return False, False
    try:
        hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):  # VerifyMismatchError is a VerificationError
        return False, False
    return True, hasher.check_needs_rehash(password_hash)


def new_session_token() -> tuple[str, str]:
    """A random 32-byte token for the cookie and its SHA-256 (the only thing stored)."""
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class LoginRateLimiter:
    """At most ``max_failures`` failed logins per (IP, username) in a sliding ``window`` (seconds)."""

    def __init__(self, max_failures: int = 10, window: float = 600.0) -> None:
        self.max_failures = max_failures
        self.window = window
        self._failures: dict[tuple[str, str], deque[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, key: tuple[str, str], now: float) -> deque[float]:
        attempts = self._failures.get(key)
        if attempts is None:
            return deque()
        while attempts and now - attempts[0] > self.window:
            attempts.popleft()
        if not attempts:
            self._failures.pop(key, None)
        return attempts

    def retry_after(self, ip: str, username: str) -> int:
        """Seconds until another attempt is allowed (0 when allowed now)."""
        key = (ip, username.lower())
        now = time.monotonic()
        with self._lock:
            attempts = self._recent(key, now)
            if len(attempts) < self.max_failures:
                return 0
            return max(1, int(self.window - (now - attempts[0])) + 1)

    def failure(self, ip: str, username: str) -> None:
        key = (ip, username.lower())
        now = time.monotonic()
        with self._lock:
            self._recent(key, now)
            self._failures.setdefault(key, deque()).append(now)
            if len(self._failures) > 10_000:  # bound memory under a credential-stuffing flood
                oldest = min(self._failures, key=lambda k: self._failures[k][-1])
                self._failures.pop(oldest, None)

    def success(self, ip: str, username: str) -> None:
        with self._lock:
            self._failures.pop((ip, username.lower()), None)
