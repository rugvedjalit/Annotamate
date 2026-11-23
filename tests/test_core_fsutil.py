"""Atomic writes, safe path resolution and file-name sanitising."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from annotamate.core import fsutil
from annotamate.core.fsutil import (
    OutsideRootError,
    atomic_write,
    atomic_write_many,
    create_unique,
    is_inside,
    resolve_inside,
    sanitize_filename,
)


def leftovers(folder: Path) -> list[str]:
    return sorted(p.name for p in folder.iterdir() if p.name.endswith(".tmp"))


def symlink_or_skip(target: Path, link: Path, *, directory: bool = False) -> None:
    try:
        os.symlink(target, link, target_is_directory=directory)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symlinks are not available here: {exc}")


# ------------------------------------------------------------------------------------------- atomic_write


def test_atomic_write_bytes_and_str(tmp_path: Path):
    target = tmp_path / "a.txt"
    atomic_write(str(target), b"\x00\x01binary")
    assert target.read_bytes() == b"\x00\x01binary"
    atomic_write(str(target), "caf\u00e9\n")
    assert target.read_bytes() == "caf\u00e9\n".encode()
    assert leftovers(tmp_path) == []


def test_atomic_write_replaces_existing(tmp_path: Path):
    target = tmp_path / "labels.txt"
    target.write_text("old content that is longer than the new one\n")
    atomic_write(str(target), "new\n")
    assert target.read_text() == "new\n"
    assert leftovers(tmp_path) == []


def test_atomic_write_failure_keeps_old_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    target = tmp_path / "labels.txt"
    target.write_text("original\n")

    def broken_fsync(_fd: int) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(os, "fsync", broken_fsync)
    with pytest.raises(OSError, match="disk full"):
        atomic_write(str(target), "replacement\n")
    assert target.read_text() == "original\n"
    assert leftovers(tmp_path) == []


def test_atomic_write_failed_rename_keeps_old_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    target = tmp_path / "labels.txt"
    target.write_text("original\n")

    def broken_replace(_src: str, _dst: str) -> None:
        raise OSError("rename failed")

    monkeypatch.setattr(fsutil.os, "replace", broken_replace)
    with pytest.raises(OSError, match="rename failed"):
        atomic_write(str(target), "replacement\n")
    assert target.read_text() == "original\n"
    assert leftovers(tmp_path) == []


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
def test_atomic_write_preserves_permissions(tmp_path: Path):
    target = tmp_path / "labels.txt"
    target.write_text("x")
    os.chmod(target, 0o640)
    atomic_write(str(target), "y")
    assert stat.S_IMODE(os.stat(target).st_mode) == 0o640


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
def test_atomic_write_new_file_is_not_private(tmp_path: Path):
    target = tmp_path / "new.txt"
    old = os.umask(0o022)
    try:
        atomic_write(str(target), "y")
    finally:
        os.umask(old)
    assert stat.S_IMODE(os.stat(target).st_mode) == 0o644


# ------------------------------------------------------------------------------------------- atomic_write_many


def test_atomic_write_many_success(tmp_path: Path):
    paths = [tmp_path / f"{n}.txt" for n in range(3)]
    for p in paths:
        p.write_text("old")
    atomic_write_many([(str(p), f"new {n}".encode()) for n, p in enumerate(paths)])
    assert [p.read_text() for p in paths] == ["new 0", "new 1", "new 2"]
    assert leftovers(tmp_path) == []


def test_atomic_write_many_is_all_or_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    paths = [tmp_path / f"{n}.txt" for n in range(4)]
    for p in paths:
        p.write_text("old")
    real_fsync = os.fsync
    calls = {"n": 0}

    def flaky_fsync(fd: int) -> None:
        calls["n"] += 1
        if calls["n"] == 3:
            raise OSError("no space left")
        real_fsync(fd)

    monkeypatch.setattr(os, "fsync", flaky_fsync)
    with pytest.raises(OSError, match="no space left"):
        atomic_write_many([(str(p), b"new") for p in paths])
    assert [p.read_text() for p in paths] == ["old"] * 4
    assert leftovers(tmp_path) == []


def test_atomic_write_many_missing_folder_changes_nothing(tmp_path: Path):
    good = tmp_path / "good.txt"
    good.write_text("old")
    with pytest.raises(FileNotFoundError):
        atomic_write_many([(str(good), b"new"), (str(tmp_path / "missing" / "x.txt"), b"new")])
    assert good.read_text() == "old"
    assert leftovers(tmp_path) == []


def test_atomic_write_many_empty():
    atomic_write_many([])


# ------------------------------------------------------------------------------------------- resolve_inside


@pytest.fixture
def tree(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "root"
    (root / "sub").mkdir(parents=True)
    (root / "sub" / "a.jpg").write_bytes(b"x")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    return root, outside


def test_resolve_relative(tree):
    root, _ = tree
    assert resolve_inside(str(root), "sub/a.jpg") == os.path.realpath(root / "sub" / "a.jpg")
    assert resolve_inside(str(root), "sub/../sub/a.jpg") == os.path.realpath(root / "sub" / "a.jpg")
    assert resolve_inside(str(root), ".") == os.path.realpath(root)


def test_resolve_nonexistent_inside_is_allowed(tree):
    root, _ = tree
    assert resolve_inside(str(root), "new/label.txt") == os.path.realpath(root / "new" / "label.txt")


@pytest.mark.parametrize("path", ["../outside/secret.txt", "sub/../../outside/secret.txt", "..", "../root2/x"])
def test_resolve_rejects_dotdot(tree, path):
    root, _ = tree
    with pytest.raises(OutsideRootError):
        resolve_inside(str(root), path)


def test_resolve_absolute(tree):
    root, outside = tree
    inside = str(root / "sub" / "a.jpg")
    assert resolve_inside(str(root), inside) == os.path.realpath(inside)
    with pytest.raises(OutsideRootError):
        resolve_inside(str(root), str(outside / "secret.txt"))


def test_resolve_rejects_nul(tree):
    root, _ = tree
    with pytest.raises(OutsideRootError):
        resolve_inside(str(root), "sub/a.jpg\x00.txt")


def test_resolve_rejects_sibling_with_same_prefix(tmp_path: Path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data-private").mkdir()
    with pytest.raises(OutsideRootError):
        resolve_inside(str(tmp_path / "data"), str(tmp_path / "data-private"))
    assert not is_inside(str(tmp_path / "data"), str(tmp_path / "data-private"))


def test_resolve_rejects_symlink_escape(tree):
    root, outside = tree
    symlink_or_skip(outside, root / "escape", directory=True)
    with pytest.raises(OutsideRootError):
        resolve_inside(str(root), "escape/secret.txt")
    symlink_or_skip(outside / "secret.txt", root / "secret-link.txt")
    with pytest.raises(OutsideRootError):
        resolve_inside(str(root), "secret-link.txt")
    assert not is_inside(str(root), str(root / "secret-link.txt"))


@pytest.mark.skipif(os.name != "nt", reason="NTFS directory junctions")
def test_resolve_rejects_junction_escape(tree):
    _winapi = pytest.importorskip("_winapi")
    root, outside = tree
    try:
        _winapi.CreateJunction(str(outside), str(root / "junction"))
    except OSError as exc:
        pytest.skip(f"junctions are not available here: {exc}")
    with pytest.raises(OutsideRootError):
        resolve_inside(str(root), "junction/secret.txt")
    assert not is_inside(str(root), str(root / "junction"))


def test_resolve_allows_symlink_inside(tree):
    root, _ = tree
    symlink_or_skip(root / "sub", root / "alias", directory=True)
    assert resolve_inside(str(root), "alias/a.jpg") == os.path.realpath(root / "sub" / "a.jpg")


def test_is_inside(tree):
    root, outside = tree
    assert is_inside(str(root), str(root))
    assert is_inside(str(root), str(root / "sub" / "a.jpg"))
    assert not is_inside(str(root), str(outside))
    assert not is_inside(str(root / "sub"), str(root))


@pytest.mark.skipif(os.name != "nt", reason="Windows drive letters")
def test_resolve_other_drive_is_outside(tree):
    root, _ = tree
    other = "Z:\\data" if not str(root).upper().startswith("Z:") else "Y:\\data"
    with pytest.raises(OutsideRootError):
        resolve_inside(str(root), other)


# ------------------------------------------------------------------------------------------- file names


@pytest.mark.parametrize(("name", "expected"), [
    ("photo.jpg", "photo.jpg"),
    ("../../etc/passwd", "passwd"),
    ("C:\\Users\\x\\img.png", "img.png"),
    ("dir/sub/img.png", "img.png"),
    ("a\x00b\x1fc.jpg", "a_b_c.jpg"),
    ('we<ird>:"|?*.jpg', "we_ird______.jpg"),
    ("  spaced name.jpg  ", "spaced name.jpg"),
    (".hidden.jpg", "hidden.jpg"),
    ("trailing.jpg...", "trailing.jpg"),
    ("con.jpg", "_con.jpg"),
    ("NUL", "_NUL"),
    ("lpt1.tar.gz", "_lpt1.tar.gz"),
    ("..", None),
    ("", None),
    ("   ", None),
    ("/", None),
])
def test_sanitize_filename(name, expected):
    assert sanitize_filename(name) == expected


def test_sanitize_filename_truncates_but_keeps_extension():
    clean = sanitize_filename("x" * 500 + ".jpeg")
    assert clean is not None
    assert len(clean) <= 200
    assert clean.endswith(".jpeg")


def test_create_unique_never_overwrites(tmp_path: Path):
    (tmp_path / "a.jpg").write_bytes(b"original")
    paths = []
    for _ in range(3):
        path, fd = create_unique(str(tmp_path), "a.jpg")
        with os.fdopen(fd, "wb") as fh:
            fh.write(b"new")
        paths.append(os.path.basename(path))
    assert paths == ["a-1.jpg", "a-2.jpg", "a-3.jpg"]
    assert (tmp_path / "a.jpg").read_bytes() == b"original"


def test_create_unique_free_name(tmp_path: Path):
    path, fd = create_unique(str(tmp_path), "b.png")
    os.close(fd)
    assert os.path.basename(path) == "b.png"
    assert os.path.exists(path)


def test_create_unique_without_extension(tmp_path: Path):
    (tmp_path / "README").write_text("x")
    path, fd = create_unique(str(tmp_path), "README")
    os.close(fd)
    assert os.path.basename(path) == "README-1"


def hidden_leftovers(folder: Path) -> list[str]:
    return sorted(p.name for p in folder.iterdir() if p.name.endswith((".tmp", ".bak")))


def fail_replace_on(monkeypatch: pytest.MonkeyPatch, bad_name: str, *, also_restore: bool = False) -> None:
    """Make ``fsutil._replace`` fail when it would put new content on ``bad_name`` (or restore it)."""
    real = fsutil._replace

    def flaky(src: str, dst: str) -> None:
        if os.path.basename(dst) == bad_name and (also_restore or src.endswith(".tmp")):
            raise PermissionError(13, "file is in use", dst)
        real(src, dst)

    monkeypatch.setattr(fsutil, "_replace", flaky)


def test_atomic_write_many_rolls_back_when_a_replace_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    paths = [tmp_path / f"{n}.txt" for n in range(4)]
    for p in paths:
        p.write_text("old")
    fail_replace_on(monkeypatch, "2.txt")
    journals = tmp_path / "journal"
    with pytest.raises(PermissionError):
        atomic_write_many([(str(p), b"new") for p in paths], journal_dir=str(journals))
    assert [p.read_text() for p in paths] == ["old"] * 4
    assert hidden_leftovers(tmp_path) == []
    assert not list(journals.iterdir())


def test_atomic_write_many_reports_files_that_cannot_be_restored(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    paths = [tmp_path / f"{n}.txt" for n in range(3)]
    for p in paths:
        p.write_text("old")
    real = fsutil._replace

    def flaky(src: str, dst: str) -> None:
        name = os.path.basename(dst)
        if name == "2.txt" and src.endswith(".tmp"):
            raise PermissionError(13, "in use", dst)
        if name == "0.txt" and src.endswith(".bak"):
            raise PermissionError(13, "in use", dst)
        real(src, dst)

    monkeypatch.setattr(fsutil, "_replace", flaky)
    journals = tmp_path / "journal"
    with pytest.raises(fsutil.MigrationIncompleteError) as info:
        atomic_write_many([(str(p), b"new") for p in paths], journal_dir=str(journals))
    assert [os.path.basename(f) for f in info.value.files] == ["0.txt"]
    assert paths[0].read_text() == "new"  # still holds the new content ...
    assert paths[1].read_text() == "old"  # ... while the restorable files are back
    assert any(p.name.endswith(".bak") for p in tmp_path.iterdir())  # ... and its backup is kept
    assert list(journals.iterdir())
    monkeypatch.undo()
    assert len(fsutil.recover_journals(str(journals))) == 1  # a later start-up can still restore it
    assert paths[0].read_text() == "old"
    assert hidden_leftovers(tmp_path) == []


def test_atomic_write_many_preflight_rejects_read_only_files(tmp_path: Path):
    paths = [tmp_path / "a.txt", tmp_path / "b.txt"]
    for p in paths:
        p.write_text("old")
    os.chmod(paths[1], stat.S_IREAD)
    try:
        with pytest.raises(PermissionError):
            atomic_write_many([(str(p), b"new") for p in paths])
        assert [p.read_text() for p in paths] == ["old", "old"]
        assert hidden_leftovers(tmp_path) == []
    finally:
        os.chmod(paths[1], stat.S_IWRITE | stat.S_IREAD)


def test_recover_journals_restores_after_a_crash(tmp_path: Path):
    paths = [tmp_path / f"{n}.txt" for n in range(3)]
    for p in paths:
        p.write_text("old")
    # State after a crash in phase 2: two files already replaced, the journal and all leftovers on disk.
    for p in paths[:2]:
        p.write_text("new")
    journals = _crash_journal(tmp_path, paths)
    restored = fsutil.recover_journals(str(journals))
    assert sorted(restored) == sorted(str(p) for p in paths[:2])  # the third was never replaced
    assert [p.read_text() for p in paths] == ["old"] * 3
    assert hidden_leftovers(tmp_path) == []
    assert not list(journals.iterdir())
    assert fsutil.recover_journals(str(journals)) == []


def _crash_journal(tmp_path: Path, paths: list[Path], *, old: bytes = b"old", new: bytes = b"new") -> Path:
    """Leftovers of a run that wrote ``new`` over ``old`` and crashed: backups, temporaries and the journal."""
    import hashlib

    entries = []
    for p in paths:
        bak = tmp_path / f".{p.name}.deadbeef.bak"
        bak.write_bytes(old)
        tmp = tmp_path / f".{p.name}.deadbeef.tmp"
        tmp.write_bytes(new)
        entries.append({"path": str(p), "tmp": str(tmp), "bak": str(bak),
                        "old": hashlib.sha256(old).hexdigest(), "new": hashlib.sha256(new).hexdigest()})
    journals = tmp_path / "journal"
    journals.mkdir()
    (journals / "label-rewrite-crash.json").write_text(json.dumps({"files": entries}))
    return journals


def test_recovery_leaves_files_saved_after_the_crash_alone(tmp_path: Path):
    target = tmp_path / "a.txt"
    journals = _crash_journal(tmp_path, [target])
    target.write_text("saved later")  # neither the old nor the rewritten content
    assert fsutil.recover_journals(str(journals)) == []
    assert target.read_text() == "saved later"
    assert [p.name for p in tmp_path.glob(".a.txt.*.bak")]  # the old content is kept for inspection
    assert not list(journals.iterdir())


def test_recovery_does_not_restore_a_damaged_backup(tmp_path: Path):
    target = tmp_path / "a.txt"
    journals = _crash_journal(tmp_path, [target])
    target.write_text("new")
    next(tmp_path.glob(".a.txt.*.bak")).write_text("")  # truncated by a power loss
    assert fsutil.recover_journals(str(journals)) == []
    assert target.read_text() == "new"


def test_backups_and_journal_record_content_hashes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import hashlib

    target = tmp_path / "a.txt"
    target.write_bytes(b"old")
    journals = tmp_path / "journal"
    seen: list[dict] = []
    real_replace = fsutil._replace

    def spy(src: str, dst: str) -> None:
        if src.endswith(".tmp") and not seen:
            journal = next(journals.iterdir())
            seen.extend(json.loads(journal.read_text())["files"])
            bak = seen[0]["bak"]
            assert Path(bak).read_bytes() == b"old"
        real_replace(src, dst)

    monkeypatch.setattr(fsutil, "_replace", spy)
    fsutil.atomic_write_many([(str(target), b"new")], journal_dir=str(journals))
    assert seen[0]["old"] == hashlib.sha256(b"old").hexdigest()
    assert seen[0]["new"] == hashlib.sha256(b"new").hexdigest()
    assert target.read_bytes() == b"new" and not list(journals.iterdir())
