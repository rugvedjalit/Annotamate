"""Image metadata (EXIF-aware), browser-safe re-encoding and WebP thumbnails with a disk cache."""

from __future__ import annotations

import contextlib
import hashlib
import os
import threading
import time
import warnings
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

from annotamate.core.fsutil import atomic_write

ORIENTATION_TAG = 0x0112
EXIF_MODES = ("apply", "ignore")

#: Formats every current browser decodes natively.
BROWSER_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "GIF": "image/gif", "WEBP": "image/webp",
                   "BMP": "image/bmp"}
_DEPTHS = {"1": 1, "L": 1, "P": 3, "I": 1, "I;16": 1, "I;16B": 1, "I;16L": 1, "F": 1, "LA": 2, "PA": 4,
           "RGB": 3, "YCbCr": 3, "LAB": 3, "HSV": 3, "RGBA": 4, "RGBa": 4, "CMYK": 4}
_SIXTEEN_BIT = {"I", "I;16", "I;16B", "I;16L", "F"}


class ImageError(Exception):
    """The file is missing or cannot be decoded. ``str(exc)`` is safe to show to users."""


@dataclass(frozen=True)
class ImageInfo:
    width: int          # after EXIF handling for the requested mode
    height: int
    format: str | None  # Pillow format name, e.g. "JPEG"
    mode: str
    orientation: int    # EXIF orientation tag, 1 when absent
    depth: int          # channel count, as written to Pascal VOC

    @property
    def needs_reencode(self) -> bool:
        """Browsers could render the file differently from what the server reports (or not at all)."""
        return self.orientation != 1 or self.format not in BROWSER_FORMATS

    @property
    def media_type(self) -> str:
        return BROWSER_FORMATS.get(self.format or "", "application/octet-stream")


def _orientation(img: Image.Image) -> int:
    try:
        value = img.getexif().get(ORIENTATION_TAG, 1)
    except Exception:  # malformed EXIF blocks must not make the image unusable
        return 1
    return value if isinstance(value, int) and 1 <= value <= 8 else 1


def _open(path: str) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            return Image.open(path)
    except FileNotFoundError:
        raise ImageError("File not found") from None
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError, SyntaxError):
        raise ImageError("Cannot decode image") from None


def probe(path: str, exif_mode: str = "apply") -> ImageInfo:
    """Read size, format and orientation from the file header (no full decode)."""
    with _open(path) as img:
        width, height = img.size
        orientation = _orientation(img)
        if exif_mode == "apply" and orientation in (5, 6, 7, 8):
            width, height = height, width
        return ImageInfo(width, height, img.format, img.mode, orientation, _DEPTHS.get(img.mode, 3))


def _to_8bit(img: Image.Image) -> Image.Image:
    if img.mode in _SIXTEEN_BIT:
        if img.mode != "I":
            img = img.convert("I")
        return img.point(lambda v: v * (1 / 256)).convert("L")
    return img


def _flatten_for(img: Image.Image, target: str) -> Image.Image:
    """Convert to a mode the target format can store."""
    has_alpha = img.mode in ("RGBA", "LA", "PA", "RGBa") or (img.mode == "P" and "transparency" in img.info)
    if target == "JPEG":
        if img.mode in ("L", "RGB"):
            return img
        return _to_8bit(img).convert("RGB")
    if target == "PNG":
        if img.mode in ("1", "L", "LA", "P", "RGB", "RGBA", "I;16", "I"):
            return img
        return _to_8bit(img).convert("RGBA" if has_alpha else "RGB")
    # WEBP
    img = _to_8bit(img)
    return img.convert("RGBA" if has_alpha else "RGB") if img.mode not in ("RGB", "RGBA") else img


def _load(path: str, exif_mode: str, draft: tuple[int, int] | None = None) -> Image.Image:
    img = _open(path)
    try:
        if draft and img.format == "JPEG":
            img.draft("RGB", draft)
        img.load()
        if exif_mode == "apply":
            ImageOps.exif_transpose(img, in_place=True)  # keeps img.format and img.info
        return img
    except ImageError:
        raise
    except Exception:
        img.close()
        raise ImageError("Cannot decode image") from None


def reencode(path: str, exif_mode: str) -> tuple[bytes, str]:
    """Decode and re-encode so the pixels match the reported orientation; returns ``(bytes, media type)``.

    With ``apply`` the EXIF rotation is baked in; with ``ignore`` the raw pixels are kept. Either way
    no orientation tag is written, so browsers cannot rotate the image on their own.
    """
    img = _load(path, exif_mode)
    try:
        icc = img.info.get("icc_profile")
        target = "JPEG" if img.format in ("JPEG", "MPO") else "PNG"
        out = _flatten_for(img, target)
        buf = BytesIO()
        options: dict = {"icc_profile": icc} if icc else {}
        if target == "JPEG":
            out.save(buf, "JPEG", quality=95, subsampling=0, **options)
            return buf.getvalue(), "image/jpeg"
        out.save(buf, "PNG", compress_level=3, **options)
        return buf.getvalue(), "image/png"
    except ImageError:
        raise
    except Exception:
        raise ImageError("Cannot decode image") from None
    finally:
        img.close()


def make_thumbnail(path: str, size: int, exif_mode: str) -> bytes:
    """A WebP thumbnail that fits in ``size`` x ``size``."""
    img = _load(path, exif_mode, draft=(size * 2, size * 2))
    try:
        out = _flatten_for(img, "WEBP")
        out.thumbnail((size, size), Image.Resampling.LANCZOS, reducing_gap=3.0)
        buf = BytesIO()
        out.save(buf, "WEBP", quality=80, method=4)
        return buf.getvalue()
    except ImageError:
        raise
    except Exception:
        raise ImageError("Cannot decode image") from None
    finally:
        img.close()


class DiskCache:
    """Content cache keyed by the source file's identity; old entries are pruned to stay under ``max_bytes``."""

    PRUNE_EVERY = 256        # writes between prune checks
    PRUNE_INTERVAL = 300.0   # minimum seconds between prunes

    def __init__(self, directory: str, max_bytes: int) -> None:
        self.directory = directory
        self.max_bytes = max_bytes
        self._writes = 0
        self._last_prune = 0.0
        self._lock = threading.Lock()

    @staticmethod
    def source_key(path: str, *parts: object) -> str:
        """Key that changes whenever the source file is modified."""
        st = os.stat(path)
        raw = "|".join([os.path.realpath(path), str(st.st_mtime_ns), str(st.st_size), *map(str, parts)])
        return hashlib.sha256(raw.encode("utf-8", "surrogatepass")).hexdigest()

    def path_for(self, key: str, ext: str) -> str:
        return os.path.join(self.directory, key[:2], f"{key}{ext}")

    def get_or_create(self, key: str, ext: str, produce: Callable[[], bytes]) -> str:
        """Path of the cached entry, producing and storing it first when missing."""
        target = self.path_for(key, ext)
        if os.path.exists(target):
            return target
        data = produce()
        os.makedirs(os.path.dirname(target), exist_ok=True)
        atomic_write(target, data)
        self._maybe_prune()
        return target

    def _maybe_prune(self) -> None:
        with self._lock:
            self._writes += 1
            now = time.monotonic()
            if self._writes < self.PRUNE_EVERY or now - self._last_prune < self.PRUNE_INTERVAL:
                return
            self._writes = 0
            self._last_prune = now
        self.prune()

    def prune(self) -> None:
        """Delete the oldest entries until the cache is at most 90 % of ``max_bytes``."""
        entries: list[tuple[float, int, str]] = []
        total = 0
        for root, _dirs, files in os.walk(self.directory):
            for name in files:
                path = os.path.join(root, name)
                with contextlib.suppress(OSError):
                    st = os.stat(path)
                    entries.append((st.st_mtime, st.st_size, path))
                    total += st.st_size
        if total <= self.max_bytes:
            return
        entries.sort()
        limit = self.max_bytes * 0.9
        for _mtime, size, path in entries:
            if total <= limit:
                break
            with contextlib.suppress(OSError):
                os.unlink(path)
                total -= size
