"""Atomic writes, safe path resolution and file-name sanitising."""

from __future__ import annotations

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
