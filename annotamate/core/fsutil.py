"""File-system helpers: atomic writes, safe path resolution and file-name sanitising."""

from __future__ import annotations

import contextlib
import os
import re
import secrets
import time

_WINDOWS = os.name == "nt"
_RESERVED_WINDOWS_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
_UNSAFE_CHARS = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]')


class OutsideRootError(ValueError):
    """Raised when a path resolves outside the folder it must stay in."""


def _norm(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


def is_inside(root: str, path: str) -> bool:
    """True when the real path of ``path`` is ``root`` itself or below it (both are resolved)."""
    root_real = _norm(os.path.realpath(root))
    real = _norm(os.path.realpath(path))
    try:
        return os.path.commonpath([root_real, real]) == root_real
    except ValueError:  # different drives on Windows
        return False


def resolve_inside(root: str, path: str) -> str:
    """Resolve ``path`` (absolute, or relative to ``root``) and make sure it stays inside ``root``.

    Symbolic links are followed (``os.path.realpath``), so a link that points outside the root is
    rejected just like ``..`` components or an unrelated absolute path. Returns the real path.
    """
    if "\x00" in path:
        raise OutsideRootError("Path contains a NUL byte")
    root_real = os.path.realpath(root)
    candidate = path if os.path.isabs(path) else os.path.join(root_real, path)
    real = os.path.realpath(candidate)
    try:
        inside = os.path.commonpath([_norm(root_real), _norm(real)]) == _norm(root_real)
    except ValueError:
        inside = False
    if not inside:
        raise OutsideRootError(f"{path!r} is outside {root!r}")
    return real


def _replace(src: str, dst: str) -> None:
    # On Windows a reader (antivirus, image viewer, another request) can briefly hold the target open.
    attempts = 10 if _WINDOWS else 1
    for attempt in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.05 * (attempt + 1))


def atomic_write(path: str, data: bytes | str, *, encoding: str = "utf-8") -> None:
    """Write ``data`` to ``path`` so that readers only ever see the old or the new content.

    The bytes go to a temporary file in the same folder, which is flushed, ``fsync``-ed and then
    moved over the target with ``os.replace``. The permissions of an existing target are kept.
    """
    if isinstance(data, str):
        data = data.encode(encoding)
    directory = os.path.dirname(os.path.abspath(path))
    base = os.path.basename(path)
    tmp = os.path.join(directory, f".{base}.{secrets.token_hex(6)}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    fd = os.open(tmp, flags, 0o666)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        with contextlib.suppress(OSError):
            os.chmod(tmp, os.stat(path).st_mode & 0o7777)
        _replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    if not _WINDOWS:
        with contextlib.suppress(OSError):
            dir_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)


def atomic_write_many(items: list[tuple[str, bytes]]) -> None:
    """Replace several files as close to all-or-nothing as the file system allows.

    Phase 1 writes and ``fsync``-s every temporary file; if any of that fails, all temporaries are
    removed and no target has changed. Phase 2 only renames, which practically never fails.
    """
    staged: list[tuple[str, str]] = []
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    try:
        for path, data in items:
            directory = os.path.dirname(os.path.abspath(path))
            tmp = os.path.join(directory, f".{os.path.basename(path)}.{secrets.token_hex(6)}.tmp")
            fd = os.open(tmp, flags, 0o666)
            staged.append((tmp, path))
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            with contextlib.suppress(OSError):
                os.chmod(tmp, os.stat(path).st_mode & 0o7777)
    except BaseException:
        for tmp, _path in staged:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
        raise
    for tmp, path in staged:
        _replace(tmp, path)


def sanitize_filename(name: str, max_length: int = 200) -> str | None:
    """Make an uploaded file name safe to create on any OS. Returns ``None`` when nothing usable is left."""
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    name = _UNSAFE_CHARS.sub("_", name).strip().strip(".").strip()
    if not name:
        return None
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    if stem.split(".")[0].upper() in _RESERVED_WINDOWS_NAMES:
        stem = f"_{stem}"
    if len(stem) + len(ext) + 1 > max_length:
        stem = stem[: max(1, max_length - len(ext) - 1)]
    return f"{stem}.{ext}" if ext else stem


def create_unique(directory: str, filename: str) -> tuple[str, int]:
    """Create ``filename`` in ``directory`` without overwriting anything.

    Existing names get a ``-1``, ``-2``... suffix before the extension. Returns the path of the new,
    empty file and an open binary file descriptor for it (created with ``O_EXCL`` so it is race-free).
    """
    stem, ext = os.path.splitext(filename)
    counter = 0
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    while True:
        candidate = filename if counter == 0 else f"{stem}-{counter}{ext}"
        path = os.path.join(directory, candidate)
        try:
            fd = os.open(path, flags, 0o666)
        except FileExistsError:
            counter += 1
            continue
        return path, fd
