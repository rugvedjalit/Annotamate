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
import unicodedata
from collections.abc import Callable

_WINDOWS = os.name == "nt"
log = logging.getLogger("annotamate.fsutil")
_RESERVED_WINDOWS_NAMES = {
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
    *(f"{device}{digit}" for device in ("COM", "LPT") for digit in map(chr, (0xB9, 0xB2, 0xB3))),  # superscript 1-3
}
_UNSAFE_CHARS = re.compile(r'[\x00-\x1f\x7f-\x9f<>:"/\\|?*]')


def _is_invisible(char: str) -> bool:
    """Format characters (bidi overrides, zero-width marks...) except the joiners emoji and scripts need."""
    return unicodedata.category(char) == "Cf" and ord(char) not in (0x200C, 0x200D)  # ZWNJ, ZWJ


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


COMMITTED_SUFFIX = ".committed"


def _journal_run(name: str) -> str:
    """The run a journal file belongs to (``label-rewrite-<run>-<batch>.json``; older journals are their own run)."""
    return name[len(JOURNAL_PREFIX):-len(".json")].rsplit("-", 1)[0]


def _swap_in(entry: dict[str, str | None]) -> None:
    """Put one staged file in place, keeping the original as its backup.

    The backup is a hard link to the original, so nothing is copied and the target never disappears; where
    hard links are not available (FAT, some network shares) the original is moved aside instead.
    """
    path, tmp, bak = str(entry["path"]), str(entry["tmp"]), entry["bak"]
    moved = False
    if bak:
        try:
            os.link(path, bak)
        except FileNotFoundError:
            raise
        except OSError:
            _replace(path, bak)
            moved = True
    try:
        _replace(tmp, path)
    except BaseException:
        if moved:
            with contextlib.suppress(OSError):
                _replace(str(bak), path)
        raise


class StagedRewrite:
    """Replace many files all-or-nothing (as far as the file system allows), staged in batches.

    1. :meth:`stage` (once per batch): every target and its folder must be writable (including the Windows
       read-only attribute); a journal naming the batch's temporaries and backups, with the SHA-256 of the old
       and the new content, is written to ``journal_dir``; then every new content is written and ``fsync``-ed
       to a temporary file in the target's own folder. Nothing is replaced yet, so readers still see the
       originals, and only the journal file names are kept in memory.
    2. :meth:`commit`: targets are replaced one by one; each original stays next to it as a backup (a hard
       link, so it is neither copied nor ``fsync``-ed again).
    3. :meth:`finalize` after the caller has stored what depends on the new files: a ``.committed`` marker is
       written (from then on a crash no longer rolls the run back), then backups, journals and the marker go.
    4. :meth:`discard` instead, at any point before :meth:`finalize`: files already replaced are restored from
       their backups and everything the run created is removed. Paths that could not be restored are returned;
       their backups and journals stay in place, so the next start finishes the rollback
       (:func:`recover_journals`).

    Without ``journal_dir`` the batches are kept in memory and a crash is not recoverable.

    ``meta`` is stored in every journal of the run. When the caller's own commit point is elsewhere (a database
    transaction), :func:`recover_journals` hands it to a ``decide`` callback that says whether the interrupted
    run had in fact been committed, so files and database can never disagree after a crash.
    """

    def __init__(self, journal_dir: str | None = None, meta: dict[str, object] | None = None) -> None:
        self.journal_dir = journal_dir
        self.meta = meta
        self.run = secrets.token_hex(8)
        self.staged = 0
        #: One item per batch: the journal path, or the entries themselves when there is no journal folder.
        self._batches: list[str | list[dict[str, str | None]]] = []
        self._dirs: set[str] = set()
        self._full = 0  # batches whose files have all been replaced
        self._partial: list[dict[str, str | None]] = []  # replaced entries of the batch in flight
        self._closed = False

    @staticmethod
    def _entries(batch: str | list[dict[str, str | None]]) -> list[dict[str, str | None]]:
        if isinstance(batch, list):
            return batch
        with open(batch, encoding="utf-8") as fh:
            return json.load(fh)["files"]

    def stage(self, items: list[tuple[str, bytes]]) -> None:
        """Write the new contents of one batch next to their targets (see the class description)."""
        if not items:
            return
        for path, _data in items:
            _check_writable(path)
        entries: list[dict[str, str | None]] = []
        for path, data in items:
            old = _file_digest(path)
            entries.append({"path": path, "tmp": _sibling(path, "tmp"),
                            "bak": _sibling(path, "bak") if old is not None else None, "old": old,
                            "new": _digest(data)})
        if self.journal_dir is not None:
            os.makedirs(self.journal_dir, exist_ok=True)
            journal = os.path.join(self.journal_dir, f"{JOURNAL_PREFIX}{self.run}-{len(self._batches):06d}.json")
            atomic_write(journal, json.dumps({"files": entries, "meta": self.meta}))
            self._batches.append(journal)
        else:
            self._batches.append(entries)
        directories: set[str] = set()
        for entry, (path, data) in zip(entries, items, strict=True):
            tmp = str(entry["tmp"])
            _write_new(tmp, data)
            if entry["bak"]:
                with contextlib.suppress(OSError):
                    os.chmod(tmp, os.stat(path).st_mode & 0o7777)
            directories.add(os.path.dirname(os.path.abspath(path)))
        self._dirs |= directories
        for directory in directories:
            _fsync_dir(directory)  # the temporaries are on disk before anything is replaced
        self.staged += len(entries)

    def commit(self, progress: Callable[[int], None] | None = None) -> None:
        """Replace every staged target. On an error call :meth:`discard` to restore what was replaced."""
        done = 0
        for batch in self._batches[self._full:]:
            for entry in self._entries(batch):
                _swap_in(entry)
                self._partial.append(entry)
                done += 1
            self._full += 1
            self._partial = []
            if progress is not None:
                progress(done)
        for directory in self._dirs:
            _fsync_dir(directory)

    def finalize(self) -> None:
        """The run is complete: drop backups and journals (a crash from here on keeps the new files)."""
        if self._closed:
            return
        self._closed = True
        marker: str | None = None
        if self.journal_dir is not None and self._batches:
            marker = os.path.join(self.journal_dir, f"{JOURNAL_PREFIX}{self.run}{COMMITTED_SUFFIX}")
            try:
                atomic_write(marker, b"")
            except OSError as exc:  # the journals are removed below all the same
                log.warning("Could not mark a label rewrite as finished: %s", exc)
                marker = None
        for batch in self._batches:
            for entry in self._entries(batch):
                _unlink(entry["bak"])
            if isinstance(batch, str):
                _unlink(batch)
        _unlink(marker)
        self._batches = []

    def discard(self) -> list[str]:
        """Undo the run; returns the paths that could not be restored (empty when everything is as before)."""
        if self._closed:
            return []
        self._closed = True
        failed: set[str] = set()

        def restore(entries: list[dict[str, str | None]]) -> None:
            for entry in reversed(entries):
                try:
                    if entry["bak"]:
                        _replace(str(entry["bak"]), str(entry["path"]))
                    else:  # the file did not exist before
                        os.unlink(str(entry["path"]))
                except OSError:
                    failed.add(str(entry["path"]))

        restore(self._partial)
        for index in range(len(self._batches) - 1, -1, -1):
            batch = self._batches[index]
            try:
                entries = self._entries(batch)
            except (OSError, ValueError, KeyError):  # the journal is unreadable: leave it for the next start
                log.error("Could not read %s while undoing a label rewrite", batch)
                continue
            if index < self._full:
                restore(entries)
            keep = False
            for entry in entries:
                _unlink(entry["tmp"])
                if entry["path"] in failed:
                    keep = True  # its backup must survive a failed rollback
                else:
                    _unlink(entry["bak"])
            if isinstance(batch, str) and not keep:
                _unlink(batch)
        for directory in self._dirs:
            _fsync_dir(directory)
        self._batches = []
        return sorted(failed)


def atomic_write_many(items: list[tuple[str, bytes]], *, journal_dir: str | None = None) -> None:
    """Replace several files all-or-nothing (one :class:`StagedRewrite` batch).

    If one replace fails, the ones already done are restored from their backups; if that fails too,
    :class:`MigrationIncompleteError` lists the affected files and their backups plus the journal stay in
    place (the next start finishes the rollback). Temporaries and backups are removed otherwise.
    """
    rewrite = StagedRewrite(journal_dir)
    try:
        rewrite.stage(items)
        rewrite.commit()
    except BaseException as exc:
        failed = rewrite.discard()
        if failed:
            raise MigrationIncompleteError(failed, exc) from exc
        raise
    rewrite.finalize()


def recover_journals(journal_dir: str,
                     decide: Callable[[dict[str, object] | None], bool] | None = None) -> list[str]:
    """Undo rewrites that were interrupted by a crash or a failed rollback; returns the restored files.

    A target is restored only when it still holds exactly the content that run wrote and its backup is
    intact (checked against the SHA-256 in the journal). A target that was never replaced keeps its
    content; one changed since (a later save) is left alone and its backup kept for inspection. A run that
    had finished (its ``.committed`` marker exists) is only cleaned up, and so is a run for which ``decide``
    (called with the run's ``meta``) answers True: its commit point was reached elsewhere, so the new files
    stay. A journal is removed once every file it names has been dealt with; after an I/O error it stays for
    the next start.
    """
    restored: list[str] = []
    try:
        listing = sorted(n for n in os.listdir(journal_dir) if n.startswith(JOURNAL_PREFIX))
    except OSError:
        return restored
    markers = [n for n in listing if n.endswith(COMMITTED_SUFFIX)]
    committed = {n[len(JOURNAL_PREFIX):-len(COMMITTED_SUFFIX)] for n in markers}
    for name in (n for n in listing if n.endswith(".json")):
        journal = os.path.join(journal_dir, name)
        try:
            with open(journal, encoding="utf-8") as fh:
                document = json.load(fh)
            entries = document["files"]
        except (OSError, ValueError, KeyError, TypeError):
            _unlink(journal)
            continue
        run = _journal_run(name)
        if run not in committed and decide is not None:
            try:
                if decide(document.get("meta")):
                    committed.add(run)
            except Exception:  # undecidable: roll back, the safe default for files the database never saw
                log.warning("Could not decide the outcome of an interrupted label rewrite", exc_info=True)
        if run in committed:  # the run completed: only its leftovers are removed
            for entry in entries:
                _unlink(entry.get("tmp"))
                _unlink(entry.get("bak"))
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
    for name in markers:
        _unlink(os.path.join(journal_dir, name))
    return restored


def _recover_entry(entry: dict[str, str | None]) -> bool:
    """Roll one journal entry back; True when the target was restored (or removed, if the run created it)."""
    path, bak = str(entry["path"]), entry.get("bak")
    _unlink(entry.get("tmp"))
    current = _file_digest(path)
    if current is None and bak and entry.get("old") and _file_digest(bak) == entry.get("old"):
        # Stopped between moving the original aside and putting the new file in place (no hard links there).
        _replace(bak, path)
        _fsync_dir(os.path.dirname(os.path.abspath(path)))
        return True
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
    name = "".join(c for c in name if not _is_invisible(c))
    name = _UNSAFE_CHARS.sub("_", name).strip().strip(".").strip()
    if not name:
        return None
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    if stem.split(".")[0].rstrip(" .").upper() in _RESERVED_WINDOWS_NAMES:
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
