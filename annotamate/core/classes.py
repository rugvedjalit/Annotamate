"""``classes.txt`` handling and the default class colour palette."""

from __future__ import annotations

import os

from annotamate.core.fsutil import atomic_write

CLASSES_FILENAME = "classes.txt"

#: 20 colours that stay distinguishable on photos (same order as the web UI).
PALETTE: tuple[str, ...] = (
    "#3b82f6", "#f97316", "#22c55e", "#eab308", "#a855f7", "#ec4899", "#14b8a6", "#ef4444", "#84cc16", "#06b6d4",
    "#f59e0b", "#8b5cf6", "#10b981", "#e11d48", "#0ea5e9", "#d946ef", "#65a30d", "#fb7185", "#6366f1", "#facc15",
)


def palette_color(index: int) -> str:
    return PALETTE[index % len(PALETTE)]


def next_color(used: list[str] | set[str]) -> str:
    """First palette colour not in ``used`` (case-insensitive), cycling when all are taken."""
    taken = {c.lower() for c in used}
    for color in PALETTE:
        if color not in taken:
            return color
    return palette_color(len(taken))


def parse_classes(text: str) -> list[str]:
    """One class name per line; surrounding whitespace and blank lines are ignored."""
    return [line.strip() for line in text.splitlines() if line.strip()]


def read_classes(path: str) -> list[str] | None:
    """Read a ``classes.txt``; ``None`` when it does not exist or cannot be decoded."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    try:
        return parse_classes(raw.decode("utf-8-sig"))
    except UnicodeDecodeError:
        return None


def write_classes(path: str, names: list[str]) -> None:
    """Atomically write ``classes.txt`` (one name per line, trailing newline)."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    atomic_write(path, "".join(f"{name}\n" for name in names))
