"""Password hashing (argon2id), session tokens and login rate limiting."""

from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import secrets
import threading
import time
from collections import deque
from collections.abc import Mapping

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

SESSION_COOKIE = "annotamate_session"
CSRF_HEADER = "x-annotamate-client"
MIN_PASSWORD_LENGTH = 8

#: argon2id with the library's recommended parameters. Tests may swap in a cheaper instance.
hasher = PasswordHasher()
_dummy_hash: str | None = None


#: argon2id uses ~64 MB per call: only a few hashes or verifications at a time, so a burst of logins cannot
#: exhaust memory or starve the thread pool.
HASH_SLOTS = 4
_hash_slots = threading.BoundedSemaphore(HASH_SLOTS)


def hash_password(password: str) -> str:
    with _hash_slots:
        return hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> tuple[bool, bool]:
    """Return ``(valid, needs_rehash)``. Unknown users are checked against a dummy hash to keep timing flat."""
    global _dummy_hash
    with _hash_slots:
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


def _ip(host: str | None) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    if not host:
        return None
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return address


def is_loopback_address(host: str | None) -> bool:
    """True for 127.0.0.0/8, ::1 and their IPv4-mapped forms; anything that is not an IP address is not loopback."""
    address = _ip(host)
    return address is not None and address.is_loopback


def is_public_address(host: str | None) -> bool:
    """True for globally routable addresses (not loopback, private, link-local, ...)."""
    address = _ip(host)
    return address is not None and address.is_global


#: Headers a reverse proxy or tunnel adds; their presence means the TCP peer is not the real client.
FORWARDING_HEADERS = ("forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
                      "cf-connecting-ip", "true-client-ip", "via")


def is_local_request(peer: str | None, headers: Mapping[str, str]) -> bool:
    """A request made on this machine directly, not relayed by a proxy or tunnel running here."""
    return is_loopback_address(peer) and not any(h in headers for h in FORWARDING_HEADERS)


def new_setup_token() -> str:
    """The one-time token that proves access to the server's log/console during first-run setup."""
    return secrets.token_urlsafe(18)


def new_session_token() -> tuple[str, str]:
    """A random 32-byte token for the cookie and its SHA-256 (the only thing stored)."""
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class LoginRateLimiter:
    """Failed-login limits in a sliding ``window`` (seconds): ``max_failures`` per (IP, username) and, so that
    one address cannot walk through many usernames, ``max_ip_failures`` per IP in total (0 = off).

    The address-wide limit applies to public addresses only. Loopback and private addresses are often shared
    by every user (a proxy whose client addresses are not trusted, Docker's gateway, office networks), and an
    address-wide lock-out there would let one person keep everyone else from signing in.
    """

    def __init__(self, max_failures: int = 10, window: float = 600.0, max_ip_failures: int = 30) -> None:
        self.max_failures = max_failures
        self.max_ip_failures = max_ip_failures
        self.window = window
        self._failures: dict[tuple[str, str | None], deque[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, key: tuple[str, str | None], now: float) -> deque[float]:
        attempts = self._failures.get(key)
        if attempts is None:
            return deque()
        while attempts and now - attempts[0] > self.window:
            attempts.popleft()
        if not attempts:
            self._failures.pop(key, None)
        return attempts

    def _wait(self, key: tuple[str, str | None], limit: int, now: float) -> int:
        attempts = self._recent(key, now)
        if len(attempts) < limit:
            return 0
        return max(1, int(self.window - (now - attempts[0])) + 1)

    def retry_after(self, ip: str, username: str) -> int:
        """Seconds until another attempt is allowed (0 when allowed now)."""
        now = time.monotonic()
        with self._lock:
            wait = self._wait((ip, username.lower()), self.max_failures, now)
            if self._per_address(ip):
                wait = max(wait, self._wait((ip, None), self.max_ip_failures, now))
            return wait

    def _per_address(self, ip: str) -> bool:
        return self.max_ip_failures > 0 and is_public_address(ip)

    def failure(self, ip: str, username: str) -> None:
        now = time.monotonic()
        with self._lock:
            keys: list[tuple[str, str | None]] = [(ip, username.lower())]
            if self._per_address(ip):
                keys.append((ip, None))
            for key in keys:
                self._recent(key, now)
                self._failures.setdefault(key, deque()).append(now)
            if len(self._failures) > 10_000:  # bound memory under a credential-stuffing flood
                oldest = min(self._failures, key=lambda k: self._failures[k][-1])
                self._failures.pop(oldest, None)

    def success(self, ip: str, username: str) -> None:
        """A good login clears that account's counter (not the address-wide one)."""
        with self._lock:
            self._failures.pop((ip, username.lower()), None)
