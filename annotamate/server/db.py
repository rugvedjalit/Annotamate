"""Engine, sessions, migrations and the post-commit outbox used for realtime events."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

log = logging.getLogger("annotamate.db")

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

#: ``(target, message)`` where target is ``("project", id)``, ``("user", id)`` or ``("all", None)``.
OutboxItem = tuple[tuple[str, Any], dict[str, Any]]


def _sqlite_pragmas(dbapi_connection: Any, _record: Any) -> None:
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA synchronous=NORMAL")
    finally:
        cursor.close()


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        engine = create_engine(
            url,
            connect_args={"check_same_thread": False, "timeout": 30},
            pool_size=20,
            max_overflow=20,
            pool_pre_ping=False,
        )
        event.listen(engine, "connect", _sqlite_pragmas)
        return engine
    return create_engine(url, pool_size=10, max_overflow=20, pool_pre_ping=True)


def alembic_config(engine: Engine) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    cfg.set_main_option("sqlalchemy.url", engine.url.render_as_string(hide_password=False).replace("%", "%%"))
    return cfg


def run_migrations(engine: Engine) -> None:
    """Upgrade the database to the latest revision (idempotent)."""
    cfg = alembic_config(engine)
    with engine.begin() as connection:
        cfg.attributes["connection"] = connection
        command.upgrade(cfg, "head")


class Database:
    """Owns the engine and the session factory; routes post-commit outbox items to ``publish``."""

    def __init__(self, url: str) -> None:
        self.engine = make_engine(url)
        self.session_factory = sessionmaker(self.engine, expire_on_commit=False)
        self.publish: Callable[[list[OutboxItem]], None] | None = None
        event.listen(self.session_factory, "after_commit", self._after_commit)
        event.listen(self.session_factory, "after_soft_rollback", self._after_rollback)

    def migrate(self) -> None:
        run_migrations(self.engine)

    def _after_commit(self, session: Session) -> None:
        items: list[OutboxItem] = session.info.pop("outbox", [])
        if items and self.publish is not None:
            try:
                self.publish(items)
            except Exception:  # realtime delivery must never break a committed request
                log.exception("Failed to publish realtime events")

    @staticmethod
    def _after_rollback(session: Session, _previous: Any) -> None:
        session.info.pop("outbox", None)

    @contextmanager
    def session(self) -> Iterator[Session]:
        session = self.session_factory()
        try:
            yield session
        except BaseException:
            session.rollback()
            raise
        finally:
            session.close()

    def dispose(self) -> None:
        self.engine.dispose()


def emit(session: Session, target: tuple[str, Any], message: dict[str, Any]) -> None:
    """Queue a realtime message that is delivered only if (and when) the session commits."""
    session.info.setdefault("outbox", []).append((target, message))
