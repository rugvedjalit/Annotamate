"""Image discovery, natural sort, EXIF-aware metadata, re-encoding, thumbnails and the disk cache."""

from __future__ import annotations

import io
import os
import time
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from annotamate.core.images import ORIENTATION_TAG, DiskCache, ImageError, make_thumbnail, probe, reencode
from annotamate.core.scanning import (
    count_images,
    is_image_name,
    list_subdirectories,
    natural_key,
    natural_sorted,
    scan_images,
)


def write_image(path: Path, size: tuple[int, int] = (40, 20), *, fmt: str | None = None, mode: str = "RGB",
                orientation: int | None = None, color: Any = "red") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new(mode, size, color)
    kwargs: dict[str, Any] = {}
    if orientation is not None:
        exif = img.getexif()
        exif[ORIENTATION_TAG] = orientation
        kwargs["exif"] = exif.tobytes()
    img.save(path, fmt, **kwargs)
    return path


def touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")


def decode(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


# ------------------------------------------------------------------------------------------- natural sort


def test_natural_sort_numbers():
    assert natural_sorted(["img10.jpg", "img2.jpg", "img1.jpg"]) == ["img1.jpg", "img2.jpg", "img10.jpg"]
    assert natural_sorted(["frame_100.png", "frame_9.png", "frame_10.png"]) == [
        "frame_9.png", "frame_10.png", "frame_100.png"]


def test_natural_sort_is_case_insensitive():
    assert natural_sorted(["b.jpg", "A.jpg", "d.jpg", "C.jpg"]) == ["A.jpg", "b.jpg", "C.jpg", "d.jpg"]


def test_natural_sort_compares_path_components():
    items = ["img3.jpg", "b/img1.jpg", "a/img10.jpg", "a/img2.jpg"]
    assert natural_sorted(items) == ["a/img2.jpg", "a/img10.jpg", "b/img1.jpg", "img3.jpg"]
    assert natural_key("a\\b.jpg")[0] == natural_key("a/b.jpg")[0]


def test_natural_sort_is_total():
    items = ["a.jpg", "a.JPG", "A.jpg"]
    assert natural_sorted(items) == natural_sorted(list(reversed(items)))
    assert len({natural_key(i) for i in items}) == 3


def test_is_image_name():
    assert is_image_name("x.JPG")
    assert is_image_name("x.tiff")
    assert not is_image_name(".x.jpg")
    assert not is_image_name("x.txt")
    assert not is_image_name("x.gif")


# ------------------------------------------------------------------------------------------- scanning


def test_scan_images(tmp_path: Path):
    for name in ("a.jpg", "B.JPG", "c.webp", "d.tif", "e.tiff", "f.png", "g.bmp", "h.jpeg", "img10.jpg", "img2.jpg",
                 "notes.txt", "labels.xml", ".hidden.jpg", ".cache/x.jpg", "sub/y.jpg", "sub/deeper/z.png"):
        touch(tmp_path / name)
    (tmp_path / "folder.jpg").mkdir()  # a directory with an image-like name is not an image
    flat = scan_images(str(tmp_path))
    assert flat == ["a.jpg", "B.JPG", "c.webp", "d.tif", "e.tiff", "f.png", "g.bmp", "h.jpeg", "img2.jpg",
                    "img10.jpg"]
    deep = scan_images(str(tmp_path), recursive=True)
    assert "sub/y.jpg" in deep
    assert "sub/deeper/z.png" in deep
    assert not any(p.startswith(".") or "/." in p for p in deep)
    assert len(deep) == len(flat) + 2


def test_scan_missing_folder(tmp_path: Path):
    with pytest.raises(FileNotFoundError):  # an unreadable root must not look like an empty folder
        scan_images(str(tmp_path / "missing"))


def test_scan_ignores_symlinks_escaping_the_folder(tmp_path: Path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    touch(root / "inside.jpg")
    touch(outside / "secret.jpg")
    try:
        os.symlink(outside / "secret.jpg", root / "link-out.jpg")
        os.symlink(root / "inside.jpg", root / "link-in.jpg")
        os.symlink(outside, root / "linked-dir", target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"symlinks are not available here: {exc}")
    assert scan_images(str(root), recursive=True) == ["inside.jpg", "link-in.jpg"]


def test_count_images(tmp_path: Path):
    for name in ("a.jpg", "b.png", "c.txt", ".d.jpg"):
        touch(tmp_path / name)
    assert count_images(str(tmp_path)) == 2
    assert count_images(str(tmp_path / "missing")) is None
    assert count_images(str(tmp_path), deadline=time.monotonic() - 1) is None
    assert count_images(str(tmp_path), cap=1) == 1


def test_list_subdirectories(tmp_path: Path):
    for name in ("set10", "set2", "Set1", ".git"):
        (tmp_path / name).mkdir()
    touch(tmp_path / "file.jpg")
    assert [name for name, _ in list_subdirectories(str(tmp_path))] == ["Set1", "set2", "set10"]
    assert all(os.path.isdir(path) for _, path in list_subdirectories(str(tmp_path)))


# ------------------------------------------------------------------------------------------- probe


def test_probe_plain_formats(tmp_path: Path):
    jpg = probe(str(write_image(tmp_path / "a.jpg")))
    assert (jpg.width, jpg.height, jpg.format, jpg.orientation, jpg.depth) == (40, 20, "JPEG", 1, 3)
    assert not jpg.needs_reencode
    assert jpg.media_type == "image/jpeg"
    png = probe(str(write_image(tmp_path / "a.png", mode="RGBA", color=(0, 0, 0, 0))))
    assert (png.format, png.depth, png.needs_reencode, png.media_type) == ("PNG", 4, False, "image/png")
    gray = probe(str(write_image(tmp_path / "g.png", mode="L", color=10)))
    assert gray.depth == 1
    webp = probe(str(write_image(tmp_path / "a.webp")))
    assert (webp.needs_reencode, webp.media_type) == (False, "image/webp")
    bmp = probe(str(write_image(tmp_path / "a.bmp")))
    assert (bmp.needs_reencode, bmp.media_type) == (False, "image/bmp")


def test_probe_exif_orientation(tmp_path: Path):
    path = str(write_image(tmp_path / "rotated.jpg", (40, 20), orientation=6))
    applied = probe(path, "apply")
    ignored = probe(path, "ignore")
    assert (applied.width, applied.height, applied.orientation) == (20, 40, 6)
    assert (ignored.width, ignored.height, ignored.orientation) == (40, 20, 6)
    assert applied.needs_reencode
    assert ignored.needs_reencode


def test_probe_orientation_without_swap(tmp_path: Path):
    flipped = probe(str(write_image(tmp_path / "flip.jpg", (40, 20), orientation=3)), "apply")
    assert (flipped.width, flipped.height) == (40, 20)
    assert flipped.needs_reencode


def test_probe_tiff_needs_reencode(tmp_path: Path):
    info = probe(str(write_image(tmp_path / "a.tif")))
    assert info.format == "TIFF"
    assert info.needs_reencode
    assert info.media_type == "application/octet-stream"


def test_probe_errors(tmp_path: Path):
    with pytest.raises(ImageError, match="File not found"):
        probe(str(tmp_path / "missing.jpg"))
    garbage = tmp_path / "garbage.jpg"
    garbage.write_bytes(b"this is not an image")
    with pytest.raises(ImageError, match="Cannot decode image"):
        probe(str(garbage))


# ------------------------------------------------------------------------------------------- re-encoding


def test_reencode_apply_transposes_and_strips_tag(tmp_path: Path):
    path = str(write_image(tmp_path / "rotated.jpg", (40, 20), orientation=6))
    data, media = reencode(path, "apply")
    out = decode(data)
    assert media == "image/jpeg"
    assert out.format == "JPEG"
    assert out.size == (20, 40)
    assert out.getexif().get(ORIENTATION_TAG, 1) == 1


def test_reencode_ignore_keeps_raw_pixels_and_strips_tag(tmp_path: Path):
    path = str(write_image(tmp_path / "rotated.jpg", (40, 20), orientation=6))
    data, _media = reencode(path, "ignore")
    out = decode(data)
    assert out.size == (40, 20)
    assert out.getexif().get(ORIENTATION_TAG, 1) == 1


def test_reencode_tiff_to_png(tmp_path: Path):
    data, media = reencode(str(write_image(tmp_path / "scan.tiff", (30, 10))), "apply")
    out = decode(data)
    assert media == "image/png"
    assert out.format == "PNG"
    assert out.size == (30, 10)


def test_reencode_cmyk_tiff(tmp_path: Path):
    data, media = reencode(str(write_image(tmp_path / "cmyk.tif", (8, 8), mode="CMYK", color=(0, 0, 0, 0))), "apply")
    assert media == "image/png"
    assert decode(data).mode in ("RGB", "RGBA")


@pytest.mark.filterwarnings("ignore:Corrupt EXIF data")
def test_reencode_garbage(tmp_path: Path):
    garbage = tmp_path / "bad.tif"
    garbage.write_bytes(b"II*\x00garbage")
    with pytest.raises(ImageError):
        reencode(str(garbage), "apply")


# ------------------------------------------------------------------------------------------- thumbnails


def test_thumbnail_is_webp_within_size(tmp_path: Path):
    out = decode(make_thumbnail(str(write_image(tmp_path / "big.jpg", (600, 300))), 128, "apply"))
    assert out.format == "WEBP"
    assert out.size == (128, 64)


def test_thumbnail_follows_exif_mode(tmp_path: Path):
    path = str(write_image(tmp_path / "rotated.jpg", (400, 200), orientation=6))
    assert decode(make_thumbnail(path, 100, "apply")).size == (50, 100)
    assert decode(make_thumbnail(path, 100, "ignore")).size == (100, 50)


def test_thumbnail_of_16bit_png(tmp_path: Path):
    path = tmp_path / "depth.png"
    Image.new("I;16", (300, 100), 40000).save(path)
    out = decode(make_thumbnail(str(path), 64, "apply"))
    assert out.format == "WEBP"
    assert out.size == (64, 21) or out.size == (64, 22)
    assert out.convert("L").getpixel((10, 10)) > 100  # scaled to 8 bit, not clipped to black


def test_thumbnail_keeps_alpha(tmp_path: Path):
    path = write_image(tmp_path / "alpha.png", (64, 64), mode="RGBA", color=(255, 0, 0, 0))
    out = decode(make_thumbnail(str(path), 64, "apply"))
    assert out.mode == "RGBA"


def test_thumbnail_of_garbage(tmp_path: Path):
    garbage = tmp_path / "bad.png"
    garbage.write_bytes(b"\x89PNG\r\n\x1a\nnope")
    with pytest.raises(ImageError):
        make_thumbnail(str(garbage), 64, "apply")


# ------------------------------------------------------------------------------------------- disk cache


def test_disk_cache_produces_once(tmp_path: Path):
    cache = DiskCache(str(tmp_path / "cache"), 1024 * 1024)
    calls: list[int] = []

    def produce() -> bytes:
        calls.append(1)
        return b"payload"

    first = cache.get_or_create("ab" * 32, ".webp", produce)
    second = cache.get_or_create("ab" * 32, ".webp", produce)
    assert first == second
    assert Path(first).read_bytes() == b"payload"
    assert Path(first).name == "ab" * 32 + ".webp"
    assert Path(first).parent.name == "ab"
    assert len(calls) == 1


def test_disk_cache_producer_error_stores_nothing(tmp_path: Path):
    cache = DiskCache(str(tmp_path / "cache"), 1024)

    def fail() -> bytes:
        raise ImageError("Cannot decode image")

    with pytest.raises(ImageError):
        cache.get_or_create("cd" * 32, ".png", fail)
    assert not os.path.exists(cache.path_for("cd" * 32, ".png"))


def test_source_key_changes_with_file(tmp_path: Path):
    path = tmp_path / "a.jpg"
    path.write_bytes(b"one")
    key = DiskCache.source_key(str(path), "thumb", 256)
    assert DiskCache.source_key(str(path), "thumb", 256) == key
    assert DiskCache.source_key(str(path), "thumb", 128) != key
    path.write_bytes(b"two!")
    assert DiskCache.source_key(str(path), "thumb", 256) != key


def test_disk_cache_prune_removes_oldest(tmp_path: Path):
    cache = DiskCache(str(tmp_path / "cache"), 100)
    paths = []
    for n in range(3):
        key = f"{n:02d}" * 32
        path = cache.get_or_create(key, ".bin", lambda: b"x" * 60)
        os.utime(path, (1_000_000 + n, 1_000_000 + n))
        paths.append(path)
    cache.prune()
    assert [os.path.exists(p) for p in paths] == [False, False, True]


def test_disk_cache_prune_under_limit_keeps_everything(tmp_path: Path):
    cache = DiskCache(str(tmp_path / "cache"), 10_000)
    path = cache.get_or_create("ef" * 32, ".bin", lambda: b"x" * 10)
    cache.prune()
    assert os.path.exists(path)
