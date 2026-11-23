"""Per-application runtime state shared by routes, the WebSocket hub and background jobs."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
import time
from collections import deque
from collections.abc import Callable, Hashable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, TypeVar

from annotamate.core.images import DEFAULT_DECODE_SLOTS, DiskCache
from annotamate.server.config import Settings
from annotamate.server.db import Database, OutboxItem
from annotamate.server.errors import ApiError, conflict
from annotamate.server.realtime import Hub
from annotamate.server.security import LoginRateLimiter

log = logging.getLogger("annotamate.jobs")

T = TypeVar("T")

#: Simultaneous upload requests that are checked and written to disk (further ones wait their turn).
UPLOAD_SLOTS = 2
#: Seconds a project's cached aggregates (status counts, statistics) are reused without a write in between.
AGGREGATE_TTL = 2.0
#: Realtime events after which a project's cached aggregates are computed again.
_COUNT_EVENTS = frozenset({"image.updated", "images.bulk_updated", "project.updated", "members.updated",
                           "classes.updated"})


class JobRunner:
    """Background jobs (indexing, label rewrites) on a small thread pool.

    Jobs sharing a key run one after another, in submission order. With ``coalesce`` a new job is
    dropped when one with the same key is already waiting (used for re-indexing).
    """

    def __init__(self, workers: int = 2) -> None:
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="annotamate-job")
        self._lock = threading.Lock()
        self._queues: dict[tuple[str, int], deque[Callable[[], None]]] = {}
        self.stopping = threading.Event()

    def submit(self, key: tuple[str, int], fn: Callable[[], None], *, coalesce: bool = False) -> bool:
        """Schedule ``fn``; returns False when it was dropped (shutting down, or coalesced)."""
        with self._lock:
            if self.stopping.is_set():
                return False
            queue = self._queues.get(key)
            if queue is None:
                self._queues[key] = deque()
                self._executor.submit(self._run, key, fn)
                return True
            if coalesce and queue:
                return False
            queue.append(fn)
            return True

    def _run(self, key: tuple[str, int], fn: Callable[[], None]) -> None:
        while True:
            try:
                fn()
            except Exception:
                log.exception("Background job %s failed", key)
            with self._lock:
                queue = self._queues[key]
                if not queue or self.stopping.is_set():
                    del self._queues[key]
                    return
                fn = queue.popleft()

    def is_running(self, key: tuple[str, int]) -> bool:
        with self._lock:
            return key in self._queues

    def wait_idle(self, timeout: float = 30.0) -> bool:
        """Block until no job is queued or running (used by tests and the CLI)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if not self._queues:
                    return True
            time.sleep(0.02)
        return False

    def shutdown(self) -> None:
        self.stopping.set()
        self._executor.shutdown(wait=True, cancel_futures=True)
        with self._lock:
            self._queues.clear()


class LabelLocks:
    """One re-entrant lock per project serialises every write to its label files."""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[int, threading.RLock] = {}

    def __call__(self, project_id: int) -> threading.RLock:
        with self._guard:
            lock = self._locks.get(project_id)
            if lock is None:
                lock = self._locks[project_id] = threading.RLock()
            return lock


@dataclass
class IndexProgress:
    done: int = 0
    total: int = 0


@dataclass
class ClassMigration:
    """A class delete/merge whose label-file rewrite is running: the project's labels are read-only meanwhile."""

    kind: str  # "delete" or "merge"
    class_name: str
    done: int = 0
    total: int = 0

    def out(self) -> dict[str, Any]:
        return {"kind": self.kind, "class_name": self.class_name, "done": self.done, "total": self.total}


class _Entry:
    __slots__ = ("computing", "gen", "has_value", "stored_at", "value", "value_gen")

    def __init__(self, gen: int) -> None:
        self.gen = gen               # bumped by every write to the project
        self.has_value = False
        self.value: Any = None
        self.value_gen = -1          # ``gen`` when the stored value started to be computed
        self.stored_at = 0.0
        self.computing: threading.Event | None = None


class AggregateCache:
    """Short-lived results of a project's expensive aggregate queries (status counts, statistics).

    Many clients ask for the same numbers at the same moment (every open page refetches after a save), so:

    * a value is reused for ``ttl`` seconds, and one request computes while the others wait for it
      (or keep the previous value when only its age is the problem): single flight;
    * a write to the project (:meth:`invalidate`, driven by the realtime events) makes the next read compute
      again, and a reader never gets a value that was computed before the last write.
    """

    def __init__(self, ttl: float = AGGREGATE_TTL) -> None:
        self.ttl = ttl
        self._lock = threading.Lock()
        self._projects: dict[int, dict[Hashable, _Entry]] = {}
        self._gens: dict[int, int] = {}
        self.computed = 0  # computations so far (tests and diagnostics)

    def get(self, project_id: int, key: Hashable, compute: Callable[[], T]) -> T:
        while True:
            with self._lock:
                entries = self._projects.setdefault(project_id, {})
                entry = entries.get(key)
                if entry is None:
                    entry = entries[key] = _Entry(self._gens.get(project_id, 0))
                current = entry.has_value and entry.value_gen == entry.gen
                if current and (time.monotonic() - entry.stored_at < self.ttl or entry.computing is not None):
                    return entry.value  # fresh, or merely old while someone is already refreshing it
                waiting = entry.computing
                if waiting is None:
                    entry.computing = mine = threading.Event()
                    started = entry.gen
            if waiting is not None:
                waiting.wait(60)
                continue  # use its result if no write happened since it started, else compute after it
            try:
                value = compute()
            except BaseException:
                with self._lock:
                    entry.computing = None
                mine.set()
                raise
            with self._lock:
                entry.value, entry.value_gen, entry.has_value = value, started, True
                entry.stored_at = time.monotonic()
                entry.computing = None
                self.computed += 1
            mine.set()
            return value

    def invalidate(self, project_id: int) -> None:
        """Something that the aggregates count has changed in the project."""
        with self._lock:
            self._bump(project_id)

    def _bump(self, project_id: int) -> None:
        self._gens[project_id] = gen = self._gens.get(project_id, 0) + 1
        for entry in self._projects.get(project_id, {}).values():
            entry.gen = gen

    def clear(self) -> None:
        with self._lock:
            for project_id in list(self._projects):
                self._bump(project_id)

    def forget(self, project_id: int) -> None:
        """The project is gone (its generation is kept so a computation in flight is not stored as current)."""
        with self._lock:
            self._bump(project_id)
            self._projects.pop(project_id, None)

    def on_events(self, items: list[OutboxItem]) -> None:
        """Post-commit hook: invalidate the projects whose counts the committed change may have altered."""
        for (kind, target), message in items:
            if kind == "project" and message.get("type") in _COUNT_EVENTS:
                self.invalidate(target)
            elif kind == "all":  # e.g. a renamed user: names are part of the cached statistics
                self.clear()


class ReadGuard:
    """The project's label lock for one file of a long read that must see one consistent set of label files.

    Entering raises ``409 migrating`` when a class migration is running or has run since the guard was made
    (the files read before and after it would not belong together).
    """

    def __init__(self, ctx: AppContext, project_id: int) -> None:
        self.ctx = ctx
        self.project_id = project_id
        self._lock = ctx.label_locks(project_id)
        self._runs = ctx.migration_runs.get(project_id, 0)

    def __enter__(self) -> None:
        self._lock.acquire()
        ctx, project_id = self.ctx, self.project_id
        if project_id in ctx.migrations or ctx.migration_runs.get(project_id, 0) != self._runs:
            self._lock.release()
            raise conflict("migrating", "The classes of the project changed while its files were being read. "
                                        "Try again.")

    def __exit__(self, *_exc: object) -> None:
        self._lock.release()


@dataclass
class AppContext:
    settings: Settings
    db: Database
    hub: Hub = field(default_factory=Hub)
    jobs: JobRunner = field(default_factory=JobRunner)
    limiter: LoginRateLimiter = field(default_factory=LoginRateLimiter)
    label_locks: LabelLocks = field(default_factory=LabelLocks)
    progress: dict[int, IndexProgress] = field(default_factory=dict)
    class_epochs: dict[int, int] = field(default_factory=dict)
    #: Failed attempts of a project's pending VOC/COCO rename job (drives the retry back-off).
    rename_retries: dict[int, int] = field(default_factory=dict)
    #: One-time token required for the first-run setup from non-loopback clients (``None`` once accounts exist).
    setup_token: str | None = None
    #: Serialises the first-run setup so two concurrent requests cannot both create an administrator.
    setup_lock: threading.Lock = field(default_factory=threading.Lock)
    #: Projects whose labels are being rewritten by a class delete/merge (set and cleared under the label lock).
    migrations: dict[int, ClassMigration] = field(default_factory=dict)
    #: Class migrations started so far per project (lets a long read notice that one ran in between).
    migration_runs: dict[int, int] = field(default_factory=dict)
    aggregates: AggregateCache = field(default_factory=AggregateCache)
    thumbs: DiskCache = field(init=False)
    renders: DiskCache = field(init=False)
    _image_pool: ThreadPoolExecutor | None = field(init=False, default=None, repr=False)
    _upload_pool: ThreadPoolExecutor | None = field(init=False, default=None, repr=False)
    _pool_guard: threading.Lock = field(init=False, default_factory=threading.Lock, repr=False)

    def __post_init__(self) -> None:
        self.limiter.max_ip_failures = self.settings.login_ip_limit
        cache = self.settings.cache_dir
        limit = self.settings.cache_max_mb * 1024 * 1024
        self.thumbs = DiskCache(str(cache / "thumbs"), limit)
        self.renders = DiskCache(str(cache / "images"), limit)

    # ------------------------------------------------------------------ slow work off the request threads

    def _pool(self, name: str) -> ThreadPoolExecutor:
        with self._pool_guard:
            if name == "image":
                if self._image_pool is None:
                    self._image_pool = ThreadPoolExecutor(DEFAULT_DECODE_SLOTS, thread_name_prefix="annotamate-image")
                return self._image_pool
            if self._upload_pool is None:
                self._upload_pool = ThreadPoolExecutor(UPLOAD_SLOTS, thread_name_prefix="annotamate-upload")
            return self._upload_pool

    async def run_decode(self, fn: Callable[..., T], *args: Any) -> T:
        """Run a full image decode (thumbnail, re-encode) on the image pool, off the request threads.

        The pool is as large as the number of decodes allowed at once, so a burst of big images queues here
        instead of occupying the few threads that serve every other request.
        """
        return await asyncio.get_running_loop().run_in_executor(self._pool("image"), fn, *args)

    async def run_upload(self, fn: Callable[..., T], *args: Any) -> T:
        """Run an upload (verify and write up to a thousand files) on its own small pool."""
        return await asyncio.get_running_loop().run_in_executor(self._pool("upload"), fn, *args)

    def close_pools(self) -> None:
        with self._pool_guard:
            pools, self._image_pool, self._upload_pool = (self._image_pool, self._upload_pool), None, None
        for pool in pools:
            if pool is not None:
                pool.shutdown(wait=True, cancel_futures=True)

    # ------------------------------------------------------------------ project state

    def is_indexing(self, project_id: int) -> bool:
        return self.jobs.is_running(("index", project_id))

    def migration_error(self, project_id: int) -> ApiError | None:
        if project_id in self.migrations:
            return conflict("migrating", "A class change is being applied to the label files. Editing is paused "
                                         "until it has finished.")
        return None

    def refuse_while_migrating(self, project_id: int) -> None:
        """``409 migrating`` while a class delete/merge is rewriting the project's label files."""
        error = self.migration_error(project_id)
        if error is not None:
            raise error

    def begin_migration(self, project_id: int, migration: ClassMigration) -> None:
        """Mark the project as migrating; the caller holds its label lock."""
        self.migrations[project_id] = migration
        self.migration_runs[project_id] = self.migration_runs.get(project_id, 0) + 1
        self.bump_class_epoch(project_id)  # an index pass that is reading the files must read them again

    def read_guard(self, project_id: int) -> ReadGuard:
        """Lock for a long, multi-file read (export): see :class:`ReadGuard`."""
        return ReadGuard(self, project_id)

    @contextlib.contextmanager
    def quiet_label_lock(self, project_id: int) -> Iterator[None]:
        """The project's label lock for background jobs, taken only once no class migration is running.

        A migration does not hold the lock while it works (requests must get a quick ``409``, not wait), so
        jobs that read or rewrite label files wait here instead. When the server is stopping the lock is
        handed out at once (a queued migration may never run): jobs check ``jobs.stopping`` and give up.
        """
        lock = self.label_locks(project_id)
        while True:
            lock.acquire()
            if project_id not in self.migrations or self.jobs.stopping.is_set():
                break
            lock.release()
            time.sleep(0.1)
        try:
            yield
        finally:
            lock.release()

    def publish(self, items: list[OutboxItem]) -> None:
        """Post-commit: drop the cached aggregates the change touched, then deliver the realtime events."""
        self.aggregates.on_events(items)
        self.hub.publish(items)

    def send_project(self, project_id: int, message: dict[str, Any]) -> None:
        """A realtime event from a background job (which commits without the request outbox)."""
        self.aggregates.on_events([(("project", project_id), message)])
        self.hub.send_project(project_id, message)

    def class_epoch(self, project_id: int) -> int:
        """Bumped (under the project's label lock) whenever a class migration rewrites label files."""
        return self.class_epochs.get(project_id, 0)

    def bump_class_epoch(self, project_id: int) -> None:
        self.class_epochs[project_id] = self.class_epochs.get(project_id, 0) + 1
