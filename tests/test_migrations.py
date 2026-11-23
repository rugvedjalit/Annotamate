"""The shipped Alembic migrations create exactly the ORM schema and run idempotently."""

from __future__ import annotations

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text

from annotamate.server.db import MIGRATIONS_DIR, Database
from annotamate.server.models import Base
from annotamate.server.services.paths import CASE_INSENSITIVE_FS


def test_migrations_match_models(tmp_path):
    db = Database(f"sqlite:///{(tmp_path / 'm.db').as_posix()}")
    db.migrate()
    db.migrate()  # second run is a no-op
    with db.engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn, opts={"compare_type": True}), Base.metadata)
        assert diff == []
        assert conn.execute(text("select version_num from alembic_version")).scalar() == "0004"
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
    assert list((MIGRATIONS_DIR / "versions").glob("0002_*.py"))
    assert MIGRATIONS_DIR.parent.name == "server"


def test_0002_backfills_label_keys_and_keeps_existing_rows(tmp_path):
    """Upgrading a 0001 database keeps its images, derives label keys and starts with nothing missing."""
    from alembic import command

    from annotamate.server.db import alembic_config

    db = Database(f"sqlite:///{(tmp_path / 'old.db').as_posix()}")
    cfg = alembic_config(db.engine)
    with db.engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "0001")
        conn.execute(text("insert into projects (id, name, description, image_dir, label_format, require_review, "
                          "restrict_to_assigned, annotators_can_add_classes, exif_mode, recursive, archived, "
                          "created_at, updated_at) values (1, 'p', '', 'x', 'yolo', 0, 0, 1, 'apply', 1, 0, "
                          "'2024-01-01', '2024-01-01')"))
        for n, rel in enumerate(["A.JPG", "sub/Cat.v2.png", "sub/cat.v2.jpg"]):
            conn.execute(text("insert into images (project_id, rel_path, filename, sort_index, status, flagged, "
                              "has_label, box_count, unknown_count, comment_count, open_comment_count) values "
                              "(1, :rel, :rel, :n, 'done', 0, 1, 0, 0, 0, 0)"), {"rel": rel, "n": n})
    db.migrate()
    with db.engine.connect() as conn:
        rows = conn.execute(text("select rel_path, label_key, missing, status from images order by id")).all()
        from annotamate.server.services.paths import label_key

        expected = [(rel, label_key(rel), 0, "done") for rel in ("A.JPG", "sub/Cat.v2.png", "sub/cat.v2.jpg")]
        assert [tuple(r) for r in rows] == expected
        assert label_key("sub/Cat.v2.png") == ("sub/cat.v2" if CASE_INSENSITIVE_FS else "sub/Cat.v2")
        assert conn.execute(text("select count(*) from pending_renames")).scalar() == 0
    db.dispose()
