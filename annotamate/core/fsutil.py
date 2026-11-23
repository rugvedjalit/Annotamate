"""File-system helpers: atomic writes, safe path resolution and file-name sanitising."""

from __future__ import annotations

import contextlib
import errno
import hashlib
import json
import logging
import os
import re
import secrets
import time

_WINDOWS = os.name == "nt"
log = logging.getLogger("annotamate.fsutil")
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


class MigrationIncompleteError(OSError):
    """A multi-file rewrite failed and rolling back did not fully restore the originals.

    ``files`` lists the paths whose content may be wrong; their backups are kept next to them.
    """

    def __init__(self, files: list[str], cause: BaseException | None = None) -> None:
        super().__init__(f"{len(files)} file(s) could not be restored: {', '.join(files)}")
        self.files = files
        self.cause = cause


JOURNAL_PREFIX = "label-rewrite-"
_FILE_ATTRIBUTE_READONLY = 0x1


def _check_writable(path: str) -> None:
    """Raise ``PermissionError`` when ``path`` (or its folder) cannot be replaced, before anything is touched."""
    directory = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(directory):
        raise FileNotFoundError(errno.ENOENT, "The folder does not exist", path)
    if not os.access(directory, os.W_OK | os.X_OK):
        raise PermissionError(errno.EACCES, "The folder is not writable", path)
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return
    if not os.access(path, os.W_OK) or getattr(st, "st_file_attributes", 0) & _FILE_ATTRIBUTE_READONLY:
        raise PermissionError(errno.EACCES, "The file is read-only", path)


def _sibling(path: str, suffix: str) -> str:
    directory, base = os.path.split(os.path.abspath(path))
    return os.path.join(directory, f".{base}.{secrets.token_hex(6)}.{suffix}")


def _unlink(path: str | None) -> None:
    if path:
        with contextlib.suppress(OSError):
            os.unlink(path)


def _fsync_dir(directory: str) -> None:
    """Make renames and new files in ``directory`` durable (POSIX; Windows has no directory handles)."""
    if _WINDOWS:
        return
    with contextlib.suppress(OSError):
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)


def _write_new(path: str, data: bytes) -> None:
    """Create ``path`` (which must not exist yet) with ``data``, flushed to disk."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o666)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _file_digest(path: str) -> str | None:
    """SHA-256 of the file's content, ``None`` when it does not exist (other errors propagate)."""
    try:
        with open(path, "rb") as fh:
            return _digest(fh.read())
    except FileNotFoundError:
        return None


def _write_journal(journal_dir: str, entries: list[dict[str, str | None]]) -> str:
    os.makedirs(journal_dir, exist_ok=True)
    path = os.path.join(journal_dir, f"{JOURNAL_PREFIX}{secrets.token_hex(8)}.json")
    atomic_write(path, json.dumps({"files": entries}))
    return path


def atomic_write_many(items: list[tuple[str, bytes]], *, journal_dir: str | None = None) -> None:
    """Replace several files all-or-nothing (as far as the file system allows).

    1. Pre-flight: every target (and its folder) must be writable, including the Windows read-only attribute.
    2. Every new content is written and ``fsync``-ed to a temporary file, and every original to a backup
       file, all in the target's own folder; the folders are ``fsync``-ed too.
    3. When ``journal_dir`` is given, a journal naming the temporaries and backups, with the SHA-256 of the
       old and the new content, is written next, so :func:`recover_journals` can undo a half-finished run
       after a crash.
    4. Targets are replaced one by one. If one replace fails, the ones already done are restored from
       their backups; if that fails too, :class:`MigrationIncompleteError` lists the affected files and the
       backups plus the journal stay in place (the next start finishes the rollback).

    Temporaries and backups are always removed unless a rollback failed.
    """
    for path, _data in items:
        _check_writable(path)
    entries: list[dict[str, str | None]] = []
    journal: str | None = None
    keep: set[str] = set()  # paths whose backup must survive a failed rollback
    try:
        for path, data in items:
            tmp = _sibling(path, "tmp")
            entries.append({"path": path, "tmp": tmp, "bak": None, "old": None, "new": _digest(data)})
            _write_new(tmp, data)
            try:
                with open(path, "rb") as fh:
                    original: bytes | None = fh.read()
            except FileNotFoundError:
                original = None
            if original is not None:
                with contextlib.suppress(OSError):
                    os.chmod(tmp, os.stat(path).st_mode & 0o7777)
                bak = _sibling(path, "bak")
                entries[-1]["bak"] = bak
                _write_new(bak, original)
                entries[-1]["old"] = _digest(original)
        for directory in {os.path.dirname(os.path.abspath(path)) for path, _data in items}:
            _fsync_dir(directory)  # temporaries and backups are on disk before the journal names them
        if journal_dir is not None:
            journal = _write_journal(journal_dir, entries)
        replaced: list[dict[str, str | None]] = []
        try:
            for entry in entries:
                _replace(str(entry["tmp"]), str(entry["path"]))
                replaced.append(entry)
        except BaseException as exc:
            failed: list[str] = []
            for entry in reversed(replaced):
                try:
                    if entry["bak"]:
                        _replace(str(entry["bak"]), str(entry["path"]))
                        entry["bak"] = None
                    else:  # the file did not exist before
                        os.unlink(str(entry["path"]))
                except OSError:
                    failed.append(str(entry["path"]))
            if failed:
                keep.update(failed)
                raise MigrationIncompleteError(failed, exc) from exc
            raise
        if journal is not None:
            _unlink(journal)
            journal = None
    finally:
        for entry in entries:
            _unlink(entry["tmp"])
            if entry["path"] not in keep:
                _unlink(entry["bak"])
        if journal is not None and not keep:
            _unlink(journal)


def recover_journals(journal_dir: str) -> list[str]:
    """Undo rewrites that were interrupted by a crash or a failed rollback; returns the restored files.

    A target is restored only when it still holds exactly the content that run wrote and its backup is
    intact (checked against the SHA-256 in the journal). A target that was never replaced keeps its
    content; one changed since (a later save) is left alone and its backup kept for inspection. A journal
    is removed once every file it names has been dealt with; after an I/O error it stays for the next start.
    """
    restored: list[str] = []
    try:
        names = sorted(n for n in os.listdir(journal_dir) if n.startswith(JOURNAL_PREFIX) and n.endswith(".json"))
    except OSError:
        return restored
    for name in names:
        journal = os.path.join(journal_dir, name)
        try:
            with open(journal, encoding="utf-8") as fh:
                entries = json.load(fh)["files"]
        except (OSError, ValueError, KeyError):
            _unlink(journal)
            continue
        clean = True
        for entry in entries:
            try:
                if _recover_entry(entry):
                    restored.append(str(entry["path"]))
            except OSError as exc:
                log.warning("Could not recover %s from an interrupted label rewrite: %s", entry.get("path"), exc)
                clean = False
        if clean:
            _unlink(journal)
    return restored


def _recover_entry(entry: dict[str, str | None]) -> bool:
    """Roll one journal entry back; True when the target was restored (or removed, if the run created it)."""
    path, bak = str(entry["path"]), entry.get("bak")
    _unlink(entry.get("tmp"))
    current = _file_digest(path)
    if current is None or current != entry.get("new"):
        # Never replaced (still the original) or changed since by a later save: leave the target alone.
        if current is not None and current == entry.get("old"):
            _unlink(bak)
        elif bak and os.path.exists(bak):
            log.warning("%s changed after an interrupted label rewrite; its old content is kept in %s", path, bak)
        return False
    if not bak:  # the run created this file
        os.unlink(path)
        return True
    if _file_digest(bak) != entry.get("old"):
        log.warning("The backup %s of %s is damaged; the file is left as it is", bak, path)
        return False
    _replace(bak, path)
    _fsync_dir(os.path.dirname(os.path.abspath(path)))
    return True


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
