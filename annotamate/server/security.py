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


LOCAL_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1"})


def _hostname(netloc: str) -> str:
    """Host part of a ``Host`` header or URL authority, lower-case, without port or IPv6 brackets."""
    netloc = netloc.strip().lower().rsplit("@", 1)[-1]
    if netloc.startswith("["):
        return netloc[1:].split("]", 1)[0]
    return netloc.split(":", 1)[0] if netloc.count(":") <= 1 else netloc


def is_local_request(peer: str | None, headers: Mapping[str, str]) -> bool:
    """A request made on this machine directly, not relayed by a proxy or tunnel and not a DNS-rebinding page.

    The TCP peer must be loopback, no proxy header may be present, the ``Host`` header must name this machine
    (``localhost``, ``127.0.0.1`` or ``[::1]``; a rebinding page sends its own domain), and an ``Origin``, if
    sent, must name the same host.
    """
    if not is_loopback_address(peer) or any(h in headers for h in FORWARDING_HEADERS):
        return False
    host = _hostname(headers.get("host", ""))
    if host not in LOCAL_HOSTNAMES:
        return False
    origin = headers.get("origin")
    if origin is not None:
        authority = origin.split("://", 1)[1] if "://" in origin else ""
        if _hostname(authority.split("/", 1)[0]) != host:
            return False
    return True


def new_setup_token() -> str:
    """The one-time token that proves access to the server's log/console during first-run setup."""
    return secrets.token_urlsafe(18)


def new_session_token() -> tuple[str, str]:
    """A random 32-byte token for the cookie and its SHA-256 (the only thing stored)."""
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def address_key(ip: str) -> str:
    """The unit the address-wide limit counts: the IPv6 /64 a host gets (rotating inside it gains nothing),
    otherwise the address itself (non-IP strings are used as they are)."""
    address = _ip(ip)
    if isinstance(address, ipaddress.IPv6Address):
        return str(ipaddress.IPv6Network((address, 64), strict=False))
    return str(address) if address is not None else ip


class LoginRateLimiter:
    """Failed sign-ins in a sliding ``window`` (seconds), counted three ways:

    * ``max_failures`` per (address, username): one client guessing one account;
    * ``max_ip_failures`` per address (IPv6: per /64) across usernames, so one client cannot walk through many
      accounts. Loopback and private addresses get ``PRIVATE_FACTOR`` times as many, because a proxy whose
      forwarding headers are not trusted, Docker's gateway or an office network can make every user share one;
    * ``max_account_failures`` per username across all addresses, so rotating addresses does not give unlimited
      guesses against one account.

    ``attempt`` checks and records in one step (concurrent guesses cannot slip past the limit while a hash is
    being verified); a good password then ``release``-s the recorded attempt. ``0`` turns a limit off.
    """

    PRIVATE_FACTOR = 10
    MAX_KEYS = 50_000

    def __init__(self, max_failures: int = 10, window: float = 600.0, max_ip_failures: int = 30,
                 max_account_failures: int = 100) -> None:
        self.max_failures = max_failures
        self.max_ip_failures = max_ip_failures
        self.max_account_failures = max_account_failures
        self.window = window
        self._failures: dict[tuple[str, ...], deque[float]] = {}
        self._lock = threading.Lock()

    def _limits(self, ip: str, username: str) -> list[tuple[tuple[str, ...], int]]:
        name = username.lower()
        addr = address_key(ip)
        limits: list[tuple[tuple[str, ...], int]] = [(("pair", addr, name), self.max_failures)]
        if self.max_ip_failures > 0:
            factor = 1 if is_public_address(ip) else self.PRIVATE_FACTOR
            limits.append((("addr", addr), self.max_ip_failures * factor))
        if self.max_account_failures > 0:
            limits.append((("user", name), self.max_account_failures))
        return [(key, limit) for key, limit in limits if limit > 0]

    def _recent(self, key: tuple[str, ...], now: float) -> deque[float]:
        attempts = self._failures.get(key)
        if attempts is None:
            return deque()
        while attempts and now - attempts[0] > self.window:
            attempts.popleft()
        if not attempts:
            self._failures.pop(key, None)
        return attempts

    def _wait(self, key: tuple[str, ...], limit: int, now: float) -> int:
        attempts = self._recent(key, now)
        if len(attempts) < limit:
            return 0
        return max(1, int(self.window - (now - attempts[0])) + 1)

    def _record(self, limits: list[tuple[tuple[str, ...], int]], now: float) -> None:
        for key, _limit in limits:
            self._failures.setdefault(key, deque()).append(now)
        if len(self._failures) > self.MAX_KEYS:
            self._evict(now)

    def _evict(self, now: float) -> None:
        """Bound memory under a flood: drop expired entries, then the oldest per-account buckets.

        Address-wide buckets are never evicted early, so filling the table cannot lift an attacker's own limit.
        """
        for key in list(self._failures):
            self._recent(key, now)
        excess = len(self._failures) - int(self.MAX_KEYS * 0.9)
        if excess > 0:
            evictable = sorted((k for k in self._failures if k[0] != "addr"), key=lambda k: self._failures[k][-1])
            for key in evictable[:excess]:
                del self._failures[key]

    def retry_after(self, ip: str, username: str) -> int:
        """Seconds until another attempt is allowed (0 when allowed now)."""
        now = time.monotonic()
        with self._lock:
            return max((self._wait(key, limit, now) for key, limit in self._limits(ip, username)), default=0)

    def attempt(self, ip: str, username: str) -> int:
        """Check and record a sign-in attempt atomically; returns the seconds to wait (0 = go ahead)."""
        now = time.monotonic()
        with self._lock:
            limits = self._limits(ip, username)
            wait = max((self._wait(key, limit, now) for key, limit in limits), default=0)
            if not wait:
                self._record(limits, now)
            return wait

    def failure(self, ip: str, username: str) -> None:
        now = time.monotonic()
        with self._lock:
            limits = self._limits(ip, username)
            for key, _limit in limits:
                self._recent(key, now)
            self._record(limits, now)

    def release(self, ip: str, username: str) -> None:
        """Take back the attempt ``attempt`` recorded (the password was right)."""
        with self._lock:
            for key, _limit in self._limits(ip, username):
                attempts = self._failures.get(key)
                if attempts:
                    attempts.pop()
                    if not attempts:
                        del self._failures[key]

    def success(self, ip: str, username: str) -> None:
        """A good login clears that account's counter for this address (not the address-wide one)."""
        with self._lock:
            self._failures.pop(("pair", address_key(ip), username.lower()), None)
