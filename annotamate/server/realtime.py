"""WebSocket hub: connections, project rooms, presence, edit locks and broadcasting.

All connection state is mutated on the event loop. Request threads and background jobs talk to
the hub through the thread-safe methods (``publish``, ``send_*``, ``lock_holder``, ``close_*``), which
hand work to the loop with ``call_soon_threadsafe``. The lock table is also guarded by a mutex
because annotation saves read it from worker threads.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from starlette.websockets import WebSocket

log = logging.getLogger("annotamate.realtime")

LOCK_TTL = 60.0
SWEEP_INTERVAL = 5.0
QUEUE_SIZE = 2000
#: Open sockets allowed per user (tabs, devices) and in total; more are refused with close code 4429.
MAX_CONNECTIONS_PER_USER = 10
MAX_CONNECTIONS = 5000
#: Edit locks one user may hold at once over all their connections (each connection holds at most one).
MAX_LOCKS_PER_USER = 3
#: A connection's typing notices to one target are passed on at most this often (seconds).
TYPING_INTERVAL = 2.0
#: Incoming frames: sustained rate per connection and burst; a client that keeps exceeding it is closed.
FRAME_RATE = 20.0
FRAME_BURST = 40.0
MAX_DROPPED_FRAMES = 200

Message = dict[str, Any]
Target = tuple[str, Any]


@dataclass(eq=False)
class Connection:
    ws: WebSocket
    user_id: int
    session_id: int
    brief: dict[str, Any]
    is_admin: bool
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(QUEUE_SIZE))
    project_id: int | None = None
    image_id: int | None = None
    image_filename: str | None = None
    presence_at: float = 0.0
    closing: bool = False
    typing_at: dict[tuple[str, int | None], float] = field(default_factory=dict)
    tokens: float = FRAME_BURST
    tokens_at: float = field(default_factory=time.monotonic)
    dropped: int = 0

    def take_frame(self) -> bool:
        """Token bucket for incoming frames: False when the client is sending faster than ``FRAME_RATE``."""
        now = time.monotonic()
        self.tokens = min(FRAME_BURST, self.tokens + (now - self.tokens_at) * FRAME_RATE)
        self.tokens_at = now
        if self.tokens >= 1:
            self.tokens -= 1
            self.dropped = max(0, self.dropped - 1)
            return True
        self.dropped += 1
        return False


@dataclass
class EditLock:
    image_id: int
    project_id: int
    conn: Connection
    expires_at: float
    acquired_at: float = field(default_factory=time.monotonic)


class _Close:
    def __init__(self, code: int) -> None:
        self.code = code


class Hub:
    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self._mutex = threading.Lock()
        self._connections: set[Connection] = set()
        self._by_user: dict[int, set[Connection]] = {}
        self._rooms: dict[int, set[Connection]] = {}
        self._locks: dict[int, EditLock] = {}
        self._sweeper: asyncio.Task | None = None

    # ------------------------------------------------------------------ lifecycle

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self._sweeper = loop.create_task(self._sweep_forever())

    async def stop(self) -> None:
        if self._sweeper is not None:
            self._sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._sweeper
            self._sweeper = None
        for conn in list(self._connections):
            self._enqueue(conn, _Close(1001))

    # ------------------------------------------------------------------ thread-safe API

    def _call(self, fn: Callable[..., Any], *args: Any) -> None:
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            fn(*args)
        else:
            with contextlib.suppress(RuntimeError):  # loop shutting down
                loop.call_soon_threadsafe(fn, *args)

    def publish(self, items: list[tuple[Target, Message]]) -> None:
        """Deliver outbox items (see ``db.emit``); safe to call from any thread."""
        for target, message in items:
            self._call(self._deliver, target, message)

    def send_project(self, project_id: int, message: Message) -> None:
        self._call(self._deliver, ("project", project_id), message)

    def send_user(self, user_id: int, message: Message) -> None:
        self._call(self._deliver, ("user", user_id), message)

    def send_all(self, message: Message) -> None:
        self._call(self._deliver, ("all", None), message)

    def online_user_ids(self) -> list[int]:
        with self._mutex:
            return sorted(self._by_user)

    def is_online(self, user_id: int) -> bool:
        with self._mutex:
            return user_id in self._by_user

    def lock_holder(self, image_id: int) -> tuple[int, dict[str, Any]] | None:
        """``(user_id, UserBrief)`` of the live lock on an image, if any."""
        with self._mutex:
            lock = self._locks.get(image_id)
            if lock is None or lock.expires_at <= time.monotonic():
                return None
            return lock.conn.user_id, dict(lock.conn.brief)

    def close_user(self, user_id: int, code: int = 4401) -> None:
        self._call(self._close_where, lambda c: c.user_id == user_id, code)

    def close_sessions(self, session_ids: set[int], code: int = 4401) -> None:
        self._call(self._close_where, lambda c: c.session_id in session_ids, code)

    def close_project(self, project_id: int) -> None:
        """Drop every socket out of a project's room (the project was deleted or access changed)."""
        self._call(self._evict_project, project_id, None)

    def evict_member(self, project_id: int, user_id: int) -> None:
        self._call(self._evict_project, project_id, user_id)

    def update_brief(self, user_id: int, brief: dict[str, Any]) -> None:
        self._call(self._set_brief, user_id, brief)

    def evict_user_except(self, user_id: int, keep: set[int]) -> None:
        """Drop a user's sockets out of every project room not in ``keep`` (lost admin rights)."""
        self._call(self._evict_user_except, user_id, set(keep))

    def revoke_locks(self, user_id: int, project_ids: set[int] | None, by: dict[str, Any]) -> None:
        """Release the edit locks a user holds (in some projects, or all) because they lost edit rights."""
        self._call(self._revoke_locks, user_id, None if project_ids is None else set(project_ids), dict(by))

    # ------------------------------------------------------------------ loop-only internals

    def _set_brief(self, user_id: int, brief: dict[str, Any]) -> None:
        for conn in self._by_user.get(user_id, ()):
            conn.brief = dict(brief)

    def _close_where(self, predicate: Callable[[Connection], bool], code: int) -> None:
        for conn in list(self._connections):
            if predicate(conn):
                self._enqueue(conn, _Close(code))

    def _evict_user_except(self, user_id: int, keep: set[int]) -> None:
        for conn in list(self._by_user.get(user_id, ())):
            if conn.project_id is not None and conn.project_id not in keep:
                self._leave_room(conn)
                self._enqueue(conn, {"type": "error", "code": "not_found", "detail": "Project not available."})

    def _revoke_locks(self, user_id: int, project_ids: set[int] | None, by: dict[str, Any]) -> None:
        with self._mutex:
            mine = [lk for lk in self._locks.values() if lk.conn.user_id == user_id
                    and (project_ids is None or lk.project_id in project_ids)]
            for lock in mine:
                del self._locks[lock.image_id]
        for lock in mine:
            self._enqueue(lock.conn, {"type": "lock.revoked", "image_id": lock.image_id, "by": by})
            self._lock_state(lock.project_id, lock.image_id, None)

    def _evict_project(self, project_id: int, user_id: int | None) -> None:
        for conn in list(self._rooms.get(project_id, ())):
            if user_id is None or conn.user_id == user_id:
                self._leave_room(conn)
                self._enqueue(conn, {"type": "error", "code": "not_found", "detail": "Project not available."})

    def _enqueue(self, conn: Connection, message: Message | _Close, *, droppable: bool = False) -> None:
        """Queue for one connection. ``droppable`` messages (typing, presence) are skipped while its queue is
        half full, so chatter from other users can never push a slow reader into being disconnected."""
        if conn.closing:
            return
        if droppable and conn.queue.qsize() > QUEUE_SIZE // 2:
            return
        if isinstance(message, _Close):
            conn.closing = True
        try:
            conn.queue.put_nowait(message)
        except asyncio.QueueFull:
            log.warning("Dropping slow WebSocket client (user %s)", conn.user_id)
            conn.closing = True
            with contextlib.suppress(asyncio.QueueEmpty):
                while True:
                    conn.queue.get_nowait()
            conn.queue.put_nowait(_Close(1013))

    def _deliver(self, target: Target, message: Message) -> None:
        kind, key = target
        if kind == "project":
            recipients = self._rooms.get(key, set())
        elif kind == "user":
            recipients = self._by_user.get(key, set())
        else:
            recipients = self._connections
        for conn in list(recipients):
            self._enqueue(conn, message)

    def send(self, conn: Connection, message: Message) -> None:
        """Queue a message for one connection (event-loop thread only)."""
        self._enqueue(conn, message)

    def _room_send(self, project_id: int, message: Message, exclude: Connection | None = None, *,
                   droppable: bool = False) -> None:
        for conn in list(self._rooms.get(project_id, ())):
            if conn is not exclude:
                self._enqueue(conn, message, droppable=droppable)

    async def writer(self, conn: Connection) -> None:
        """Single writer per socket: drains the queue in order."""
        try:
            while True:
                message = await conn.queue.get()
                if isinstance(message, _Close):
                    with contextlib.suppress(Exception):
                        await conn.ws.close(code=message.code)
                    return
                await conn.ws.send_json(message)
        except asyncio.CancelledError:
            raise
        except Exception:  # client went away mid-send
            conn.closing = True

    # connection registry

    def admits(self, user_id: int) -> bool:
        """Whether another socket of ``user_id`` may connect (per-user and global caps)."""
        with self._mutex:
            return (len(self._connections) < MAX_CONNECTIONS
                    and len(self._by_user.get(user_id, ())) < MAX_CONNECTIONS_PER_USER)

    def register(self, conn: Connection) -> None:
        with self._mutex:
            first = conn.user_id not in self._by_user
            self._connections.add(conn)
            self._by_user.setdefault(conn.user_id, set()).add(conn)
        self._enqueue(conn, {"type": "hello", "user_id": conn.user_id, "online_user_ids": self.online_user_ids()})
        if first:
            for other in list(self._connections):
                if other is not conn:
                    self._enqueue(other, {"type": "user.online", "user_id": conn.user_id})

    def unregister(self, conn: Connection) -> None:
        self._leave_room(conn)
        with self._mutex:
            self._connections.discard(conn)
            conns = self._by_user.get(conn.user_id)
            last = False
            if conns is not None:
                conns.discard(conn)
                if not conns:
                    del self._by_user[conn.user_id]
                    last = True
        if last:
            self._deliver(("all", None), {"type": "user.offline", "user_id": conn.user_id})

    # rooms and presence

    def _user_presence(self, project_id: int, user_id: int) -> Connection | None:
        """The user's most recently active connection in the room (their presence), if any."""
        best: Connection | None = None
        for conn in self._rooms.get(project_id, ()):
            if conn.user_id == user_id and (best is None or conn.presence_at >= best.presence_at):
                best = conn
        return best

    def _broadcast_presence(self, project_id: int, conn: Connection, exclude: Connection | None) -> None:
        best = self._user_presence(project_id, conn.user_id)
        message: Message = {"type": "presence.update", "project_id": project_id, "user": dict(conn.brief),
                            "image_id": best.image_id if best else None,
                            "image_filename": best.image_filename if best else None}
        if best is None:
            message["left"] = True
        self._room_send(project_id, message, exclude=exclude, droppable=best is not None)  # "left" always arrives

    def join_room(self, conn: Connection, project_id: int) -> None:
        if conn.project_id is not None:
            self._leave_room(conn)
        conn.project_id = project_id
        conn.image_id = None
        conn.image_filename = None
        conn.presence_at = time.monotonic()
        self._rooms.setdefault(project_id, set()).add(conn)
        users: dict[int, Message] = {}
        for other in sorted(self._rooms[project_id], key=lambda c: c.presence_at):
            users[other.user_id] = {"user": dict(other.brief), "image_id": other.image_id,
                                    "image_filename": other.image_filename}
        self._enqueue(conn, {"type": "presence.snapshot", "project_id": project_id, "users": list(users.values())})
        now = time.monotonic()
        with self._mutex:
            locks = [lk for lk in self._locks.values() if lk.project_id == project_id and lk.expires_at > now]
        for lock in locks:
            self._enqueue(conn, {"type": "lock.state", "project_id": project_id, "image_id": lock.image_id,
                              "holder": dict(lock.conn.brief)})
        self._broadcast_presence(project_id, conn, exclude=conn)

    def _leave_room(self, conn: Connection) -> None:
        project_id = conn.project_id
        if project_id is None:
            return
        self._release_all(conn)
        room = self._rooms.get(project_id)
        if room is not None:
            room.discard(conn)
            if not room:
                del self._rooms[project_id]
        conn.project_id = None
        conn.image_id = None
        conn.image_filename = None
        self._broadcast_presence(project_id, conn, exclude=conn)

    def leave_room(self, conn: Connection) -> None:
        self._leave_room(conn)

    def set_presence(self, conn: Connection, image_id: int | None, image_filename: str | None = None) -> None:
        if conn.project_id is None:
            return
        conn.image_id = image_id
        conn.image_filename = image_filename if image_id is not None else None
        conn.presence_at = time.monotonic()
        self._broadcast_presence(conn.project_id, conn, exclude=conn)

    def typing(self, conn: Connection, scope: str, user_id: int | None) -> None:
        target = (scope, conn.project_id if scope == "chat" else user_id)
        now = time.monotonic()
        if now - conn.typing_at.get(target, -TYPING_INTERVAL) < TYPING_INTERVAL:
            return  # clients re-send while the user types; one notice per interval is enough
        if len(conn.typing_at) > 64:
            conn.typing_at.clear()
        conn.typing_at[target] = now
        if scope == "chat" and conn.project_id is not None:
            self._room_send(conn.project_id, {"type": "typing", "scope": "chat", "project_id": conn.project_id,
                                              "user": dict(conn.brief)}, exclude=conn, droppable=True)
        elif scope == "dm" and isinstance(user_id, int) and user_id != conn.user_id:
            message = {"type": "typing", "scope": "dm", "user": dict(conn.brief)}
            for other in list(self._by_user.get(user_id, ())):
                self._enqueue(other, message, droppable=True)

    # edit locks

    def _lock_state(self, project_id: int, image_id: int, holder: dict[str, Any] | None) -> None:
        self._room_send(project_id, {"type": "lock.state", "project_id": project_id, "image_id": image_id,
                                     "holder": holder})

    def acquire(self, conn: Connection, image_id: int, force: bool, can_force: bool) -> None:
        """Grant, deny or take over the edit lock of an image in the connection's project.

        The caller has checked (freshly, from the database) that the user may edit this image;
        ``can_force`` says whether they may take a lock over from someone else.
        """
        project_id = conn.project_id
        assert project_id is not None
        now = time.monotonic()
        revoked: Connection | None = None
        dropped: list[EditLock] = []
        with self._mutex:
            lock = self._locks.get(image_id)
            if lock is not None and lock.expires_at <= now:
                lock = None
            if lock is None or lock.conn is conn:
                self._locks[image_id] = EditLock(image_id, project_id, conn, now + LOCK_TTL)
                changed = lock is None
            elif lock.conn.user_id == conn.user_id or (force and can_force):
                revoked = lock.conn
                self._locks[image_id] = EditLock(image_id, project_id, conn, now + LOCK_TTL)
                changed = True
            else:
                holder = dict(lock.conn.brief)
                self._enqueue(conn, {"type": "lock.denied", "image_id": image_id, "holder": holder})
                return
            # One edit lock per connection: taking a new one lets go of any other, so a script cannot
            # lock a whole project. Over all of the user's connections at most MAX_LOCKS_PER_USER stay:
            # the oldest others are let go too (their tabs get lock.revoked).
            dropped = [lk for lk in self._locks.values() if lk.conn is conn and lk.image_id != image_id]
            for other in dropped:
                del self._locks[other.image_id]
            others = sorted((lk for lk in self._locks.values()
                             if lk.conn.user_id == conn.user_id and lk.image_id != image_id),
                            key=lambda lk: lk.acquired_at)
            excess = others[:max(0, len(others) - (MAX_LOCKS_PER_USER - 1))]
            for other in excess:
                del self._locks[other.image_id]
        for other in dropped:
            self._lock_state(other.project_id, other.image_id, None)
        for other in excess:
            self._enqueue(other.conn, {"type": "lock.revoked", "image_id": other.image_id, "by": dict(conn.brief)})
            self._lock_state(other.project_id, other.image_id, None)
        if revoked is not None:
            self._enqueue(revoked, {"type": "lock.revoked", "image_id": image_id, "by": dict(conn.brief)})
        self._enqueue(conn, {"type": "lock.granted", "image_id": image_id})
        if changed:
            self._lock_state(project_id, image_id, dict(conn.brief))

    def release(self, conn: Connection, image_id: int) -> None:
        with self._mutex:
            lock = self._locks.get(image_id)
            if lock is None or lock.conn is not conn:
                return
            del self._locks[image_id]
        self._lock_state(lock.project_id, image_id, None)

    def _release_all(self, conn: Connection) -> None:
        with self._mutex:
            mine = [lk for lk in self._locks.values() if lk.conn is conn]
            for lock in mine:
                del self._locks[lock.image_id]
        for lock in mine:
            self._lock_state(lock.project_id, lock.image_id, None)

    def renew(self, conn: Connection) -> None:
        deadline = time.monotonic() + LOCK_TTL
        with self._mutex:
            for lock in self._locks.values():
                if lock.conn is conn:
                    lock.expires_at = deadline

    def locked_images(self, conn: Connection) -> list[int]:
        with self._mutex:
            return [lk.image_id for lk in self._locks.values() if lk.conn is conn]

    def revoke(self, conn: Connection, image_id: int, reason: str) -> None:
        """Take a lock away from its holder because they lost the right to edit the image."""
        with self._mutex:
            lock = self._locks.get(image_id)
            if lock is None or lock.conn is not conn:
                return
            del self._locks[image_id]
        self._enqueue(conn, {"type": "lock.revoked", "image_id": image_id, "by": None, "reason": reason})
        self._lock_state(lock.project_id, image_id, None)

    def sweep(self) -> None:
        now = time.monotonic()
        with self._mutex:
            expired = [lk for lk in self._locks.values() if lk.expires_at <= now]
            for lock in expired:
                del self._locks[lock.image_id]
        for lock in expired:
            self._enqueue(lock.conn, {"type": "lock.expired", "image_id": lock.image_id})
            self._lock_state(lock.project_id, lock.image_id, None)

    async def _sweep_forever(self) -> None:
        while True:
            await asyncio.sleep(SWEEP_INTERVAL)
            try:
                self.sweep()
            except Exception:
                log.exception("Lock sweep failed")
