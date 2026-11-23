"""The original Tkinter desktop app (legacy). Needs ``pip install "annotamate[desktop]"``."""

from __future__ import annotations

import importlib.util
import sys

REQUIRED = ("customtkinter", "tkfontawesome")


def run() -> int:
    """Start the desktop app; prints installation help and returns 1 when its extras are missing."""
    missing = [name for name in REQUIRED if importlib.util.find_spec(name) is None]
    if missing:
        print(
            f"The desktop app needs {', '.join(missing)}. Install it with:\n\n"
            '    pip install "annotamate[desktop]"\n',
            file=sys.stderr,
        )
        return 1
    try:
        from annotamate.desktop.app import main
    except ImportError as exc:  # e.g. Tk itself is not available on this Python
        print(f"The desktop app cannot start: {exc}", file=sys.stderr)
        return 1
    main()
    return 0
