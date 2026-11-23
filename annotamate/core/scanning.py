"""Image discovery and natural sort order."""

from __future__ import annotations

import os
import re
import time
from collections.abc import Iterator
from dataclasses import dataclass, field

IMAGE_EXTENSIONS: frozenset[str] = frozenset({".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"})

_DIGITS = re.compile(r"(\d+)")


def is_image_name(name: str) -> bool:
    return not name.startswith(".") and os.path.splitext(name)[1].lower() in IMAGE_EXTENSIONS


def natural_key(text: str) -> tuple:
    """Sort key that orders ``img2`` before ``img10`` and compares path components separately.

    The original string is the final tie-breaker so the order is total and deterministic.
    """
    parts = []
    for component in text.replace("\\", "/").split("/"):
        chunks = _DIGITS.split(component.casefold())
        parts.append(tuple((0, int(c), "") if i % 2 else (1, 0, c) for i, c in enumerate(chunks)))
    return (tuple(parts), text)


def natural_sorted(items: list[str]) -> list[str]:
    return sorted(items, key=natural_key)


def _inside(root_real: str, path: str) -> bool:
    real = os.path.normcase(os.path.realpath(path))
    try:
        return os.path.commonpath([root_real, real]) == root_real
    except ValueError:
        return False


@dataclass
class ScanResult:
    paths: list[str]                                    # natural-sorted relative image paths
    unreadable: list[str] = field(default_factory=list)  # sub-folder prefixes ("a/b/") that could not be listed


def _walk(directory: str, prefix: str, recursive: bool, root_real: str, unreadable: list[str]) -> Iterator[str]:
    try:
        with os.scandir(directory) as it:
            entries = list(it)
    except OSError:
        if not prefix:
            raise  # the root itself: the caller must not mistake this for an empty folder
        unreadable.append(prefix)
        return
    for entry in entries:
        name = entry.name
        if name.startswith("."):
            continue
        try:
            is_link = entry.is_symlink()
            if entry.is_file():
                if os.path.splitext(name)[1].lower() not in IMAGE_EXTENSIONS:
                    continue
                if is_link and not _inside(root_real, entry.path):
                    continue
                yield prefix + name
            elif recursive and entry.is_dir(follow_symlinks=False):
                yield from _walk(entry.path, f"{prefix}{name}/", recursive, root_real, unreadable)
        except OSError:
            continue


def scan(directory: str, recursive: bool = False) -> ScanResult:
    """Image paths below ``directory``, relative to it with ``/`` separators, in natural order.

    Hidden files and folders (leading dot) are skipped. Symlinked folders are not followed and
    symlinked files that resolve outside ``directory`` are ignored. Raises ``OSError`` when
    ``directory`` itself cannot be listed; unreadable sub-folders are reported in ``unreadable``.
    """
    root_real = os.path.normcase(os.path.realpath(directory))
    unreadable: list[str] = []
    paths = natural_sorted(list(_walk(directory, "", recursive, root_real, unreadable)))
    return ScanResult(paths, unreadable)


def scan_images(directory: str, recursive: bool = False) -> list[str]:
    """Like ``scan`` but only the paths."""
    return scan(directory, recursive).paths


def count_images(directory: str, *, deadline: float | None = None, cap: int = 1_000_000) -> int | None:
    """Number of images directly inside ``directory``; ``None`` when unreadable or out of time."""
    count = 0
    try:
        with os.scandir(directory) as it:
            for n, entry in enumerate(it):
                if n % 2048 == 0 and deadline is not None and time.monotonic() > deadline:
                    return None
                if is_image_name(entry.name):
                    count += 1
                    if count >= cap:
                        break
    except OSError:
        return None
    return count


def list_subdirectories(directory: str) -> list[tuple[str, str]]:
    """Visible sub-folders of ``directory`` as ``(name, path)``, natural-sorted by name."""
    out: list[tuple[str, str]] = []
    with os.scandir(directory) as it:
        for entry in it:
            if entry.name.startswith("."):
                continue
            try:
                if entry.is_dir():
                    out.append((entry.name, entry.path))
            except OSError:
                continue
    out.sort(key=lambda item: natural_key(item[0]))
    return out
