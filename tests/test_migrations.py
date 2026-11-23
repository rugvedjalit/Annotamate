"""The shipped Alembic migrations create exactly the ORM schema and run idempotently."""

from __future__ import annotations

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text

from annotamate.server.db import MIGRATIONS_DIR, Database
from annotamate.server.models import Base


def test_migrations_match_models(tmp_path):
    db = Database(f"sqlite:///{(tmp_path / 'm.db').as_posix()}")
    db.migrate()
    db.migrate()  # second run is a no-op
    with db.engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn, opts={"compare_type": True}), Base.metadata)
        assert diff == []
        assert conn.execute(text("select version_num from alembic_version")).scalar() == "0001"
    assert set(inspect(db.engine).get_table_names()) >= {"users", "projects", "images", "alembic_version"}
    db.dispose()


def test_sqlite_pragmas(tmp_path):
    db = Database(f"sqlite:///{(tmp_path / 'p.db').as_posix()}")
    with db.engine.connect() as conn:
        assert conn.execute(text("pragma journal_mode")).scalar() == "wal"
        assert conn.execute(text("pragma foreign_keys")).scalar() == 1
        assert conn.execute(text("pragma busy_timeout")).scalar() == 30000
    db.dispose()


def test_migrations_live_inside_the_package():
    assert (MIGRATIONS_DIR / "env.py").is_file()
    assert list((MIGRATIONS_DIR / "versions").glob("0001_*.py"))
    assert MIGRATIONS_DIR.parent.name == "server"
