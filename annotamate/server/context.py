"""Per-application runtime state shared by routes, the WebSocket hub and background jobs."""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from annotamate.core.images import DiskCache
from annotamate.server.config import Settings
from annotamate.server.db import Database
from annotamate.server.realtime import Hub
from annotamate.server.security import LoginRateLimiter

log = logging.getLogger("annotamate.jobs")


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
class AppContext:
    settings: Settings
    db: Database
    hub: Hub = field(default_factory=Hub)
    jobs: JobRunner = field(default_factory=JobRunner)
    limiter: LoginRateLimiter = field(default_factory=LoginRateLimiter)
    label_locks: LabelLocks = field(default_factory=LabelLocks)
    progress: dict[int, IndexProgress] = field(default_factory=dict)
    class_epochs: dict[int, int] = field(default_factory=dict)
    thumbs: DiskCache = field(init=False)
    renders: DiskCache = field(init=False)

    def __post_init__(self) -> None:
        cache = self.settings.cache_dir
        limit = self.settings.cache_max_mb * 1024 * 1024
        self.thumbs = DiskCache(str(cache / "thumbs"), limit)
        self.renders = DiskCache(str(cache / "images"), limit)

    def is_indexing(self, project_id: int) -> bool:
        return self.jobs.is_running(("index", project_id))

    def class_epoch(self, project_id: int) -> int:
        """Bumped (under the project's label lock) whenever a class migration rewrites label files."""
        return self.class_epochs.get(project_id, 0)

    def bump_class_epoch(self, project_id: int) -> None:
        self.class_epochs[project_id] = self.class_epochs.get(project_id, 0) + 1
