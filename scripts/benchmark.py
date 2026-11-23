#!/usr/bin/env python3
"""Measure how Annotamate behaves with a large project, over real HTTP requests.

    python scripts/benchmark.py --images 10000            # print a JSON report
    python scripts/benchmark.py --images 10000 --check    # ... and exit 1 when a number is past its threshold

The script generates a YOLO dataset of tiny images (half of them labelled) in a temporary folder, starts
``python -m annotamate serve`` on a free port with a temporary data folder, creates the administrator and
times the operations whose cost grows with the number of images: indexing, rescanning, list pages,
navigation, the project page, statistics, a save, many clients at once and the exports.

It needs only the standard library and ``httpx`` (a development dependency). The server's memory is read with
``psutil`` when it can be imported, otherwise from ``/proc`` (Linux) or the Win32 API. To measure another
checkout, put it first on ``PYTHONPATH``.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import secrets
import shutil
import socket
import statistics
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

try:  # optional: the memory numbers have a fallback without it
    import psutil
except ImportError:  # pragma: no cover - depends on the environment
    psutil = None

PASSWORD = secrets.token_urlsafe(18)  # the account only lives in the temporary data folder
HEADERS = {"X-Annotamate-Client": "web"}
CLASSES = ["person", "car", "dog"]
LABEL = "0 0.25 0.25 0.2 0.2\n1 0.5 0.5 0.3 0.3\n2 0.75 0.75 0.2 0.2\n"

#: Limits for ``--check`` at 10,000 images: about three times what a Linux machine measured (Python 3.11,
#: 2026-11), so that only a real regression fails on a busy shared runner, such as an operation that reads
#: the whole project again. Seconds for ``*_s``, milliseconds for ``*_ms``, megabytes for ``*_mb``.
THRESHOLDS_10K: dict[str, float] = {
    "first_index_s": 10.0,        # measured 1.4-1.9
    "rescan_unchanged_s": 2.0,    # 0.4 (1.1 when every label file is read again)
    "list_first_page_ms": 40.0,   # 8-13
    "list_last_page_ms": 40.0,    # 8-9
    "neighbors_ms": 25.0,         # 6
    "project_detail_ms": 25.0,    # 6-7
    "stats_ms": 20.0,             # 4-5
    "save_ms": 150.0,             # 20-50 (two fsyncs: depends on the disk)
    "parallel_p95_ms": 2000.0,    # 420-610
    "export_yolo_s": 8.0,         # 1.3-2.2
    "export_coco_s": 7.0,         # 1.2-1.8
    "peak_rss_mb": 400.0,         # 167
}
#: Throughput of 20 clients must stay above this (measured 41-58 requests per second).
MINIMUMS_10K: dict[str, float] = {"parallel_rps": 15.0}
#: Limits that do not depend on how fast the machine is: ``measure <= factor * other measure``.
#: A rescan of an unchanged project must be much cheaper than the first index (measured 0.3; 0.65 when every
#: label file is read again).
RATIOS: dict[str, tuple[str, float]] = {"rescan_unchanged_s": ("first_index_s", 0.5)}


def tiny_png() -> bytes:
    """A valid 16 x 16 grey PNG, built without an imaging library."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + b"\x80" * 16 for _ in range(16))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 16, 16, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def make_dataset(folder: Path, count: int) -> None:
    """``count`` images named for natural sorting; every second one has a label file with three boxes.

    The label files are dated an hour back, like a dataset that was copied onto the server earlier: the index
    does not trust the timestamp of a file written in the last two seconds and would read it again.
    """
    folder.mkdir(parents=True, exist_ok=True)
    png = tiny_png()
    earlier = time.time() - 3600
    for n in range(count):
        (folder / f"img_{n:07d}.png").write_bytes(png)
        if n % 2 == 0:
            label = folder / f"img_{n:07d}.txt"
            label.write_text(LABEL, encoding="utf-8", newline="\n")
            os.utime(label, (earlier, earlier))
    (folder / "classes.txt").write_text("".join(f"{name}\n" for name in CLASSES), encoding="utf-8", newline="\n")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _win32_rss_reader(pid: int) -> Callable[[], int]:
    """Resident memory of a process and its children through the Win32 API.

    In a virtual environment ``python.exe`` is a small launcher: the interpreter that serves is its child.
    """
    import ctypes
    from ctypes import wintypes

    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                    *((name, ctypes.c_size_t) for name in (
                        "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
                        "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage",
                        "PeakPagefileUsage"))]

    class Entry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", wintypes.LONG), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_char * 260)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.Process32First.argtypes = kernel.Process32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    handles: dict[int, int] = {}
    started: dict[int, int] = {}

    def open_process(process_id: int) -> bool:
        handle = kernel.OpenProcess(0x1000, False, process_id)  # PROCESS_QUERY_LIMITED_INFORMATION
        times = [wintypes.FILETIME() for _ in range(4)]
        if not handle or not kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
            return False
        handles[process_id] = handle
        started[process_id] = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
        return True

    def look_for_children() -> None:
        snapshot = kernel.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
        children: list[tuple[int, int]] = []
        entry = Entry()
        entry.dwSize = ctypes.sizeof(Entry)
        more = kernel.Process32First(snapshot, ctypes.byref(entry))
        while more:
            children.append((entry.th32ProcessID, entry.th32ParentProcessID))
            more = kernel.Process32Next(snapshot, ctypes.byref(entry))
        kernel.CloseHandle(snapshot)
        for child, parent in children:
            # Process ids are reused: a real child was started after its parent.
            if parent in handles and child not in handles and open_process(child) \
                    and started[child] < started[parent]:
                kernel.CloseHandle(handles.pop(child))

    open_process(pid)

    def read() -> int:
        if len(handles) < 2:  # look for the interpreter until the launcher has started it
            look_for_children()
        total = 0
        for handle in handles.values():
            counters = Counters()
            counters.cb = ctypes.sizeof(counters)
            if kernel.K32GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                total += int(counters.WorkingSetSize)
        return total

    return read


def _rss_reader(pid: int) -> Callable[[], int] | None:
    """A function returning the resident memory of the server in bytes: psutil, else ``/proc`` or the Win32 API."""
    if psutil is not None:
        process = psutil.Process(pid)

        def read_psutil() -> int:
            total = process.memory_info().rss
            for child in process.children(recursive=True):
                with contextlib.suppress(psutil.Error):
                    total += child.memory_info().rss
            return total

        return read_psutil
    status = f"/proc/{pid}/status"
    if os.path.exists(status):
        def read_proc() -> int:
            with open(status, encoding="ascii", errors="replace") as fh:
                for line in fh:
                    if line.startswith("VmRSS:"):
                        return int(line.split()[1]) * 1024
            return 0

        return read_proc
    if sys.platform == "win32":
        return _win32_rss_reader(pid)
    return None


class MemoryWatch:
    """Idle and peak resident memory of the server process, sampled in the background."""

    def __init__(self, pid: int) -> None:
        self.peak = 0
        self.idle = 0
        self._phase = 0
        self._stop = threading.Event()
        self._read = _rss_reader(pid)
        self.available = self._read is not None
        self._thread = threading.Thread(target=self._run, daemon=True)
        if self.available:
            self._thread.start()

    def _rss(self) -> int:
        try:
            return self._read() if self._read is not None else 0
        except Exception:
            return 0

    def _run(self) -> None:
        while not self._stop.wait(0.05):
            rss = self._rss()
            self.peak = max(self.peak, rss)
            self._phase = max(self._phase, rss)

    def mark_idle(self) -> None:
        self.idle = self._rss()

    def phase_peak(self) -> float:
        """Highest memory since the last call, in MB (the phases of the run are reported separately)."""
        peak, self._phase = self._phase, 0
        return round(peak / 1e6, 1)

    def stop(self) -> None:
        self._stop.set()


class Bench:
    def __init__(self, base: str) -> None:
        self.base = base
        self.client = httpx.Client(base_url=base, headers=HEADERS, timeout=600)

    def login(self) -> None:
        response = self.client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
        response.raise_for_status()

    def get(self, url: str, **params: Any) -> Any:
        response = self.client.get(url, params=params or None)
        response.raise_for_status()
        return response.json()

    def timed(self, fn: Callable[[], Any], repeat: int = 15) -> float:
        """Median duration of ``fn`` in milliseconds (after one warm-up call)."""
        fn()
        samples = []
        for _ in range(repeat):
            started = time.perf_counter()
            fn()
            samples.append((time.perf_counter() - started) * 1000)
        return round(statistics.median(samples), 2)

    def wait_indexed(self, project_id: int, timeout: float = 7200) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.get(f"/api/projects/{project_id}")["indexing"]:
                return
            time.sleep(0.05)
        raise TimeoutError("indexing did not finish")

    def export(self, project_id: int, fmt: str) -> tuple[float, int]:
        """``(seconds, bytes)`` of a streamed export (labels only)."""
        started = time.perf_counter()
        size = 0
        with self.client.stream("GET", f"/api/projects/{project_id}/export", params={"format": fmt}) as response:
            response.raise_for_status()
            for piece in response.iter_bytes():
                size += len(piece)
        return round(time.perf_counter() - started, 2), size

    def parallel(self, url: str, clients: int, requests_each: int) -> dict[str, float]:
        """Many clients, each with its own persistent connection, asking for the same page."""
        cookies = dict(self.client.cookies)
        durations: list[float] = []
        guard = threading.Lock()
        start = threading.Barrier(clients + 1)

        def work() -> None:
            with httpx.Client(base_url=self.base, headers=HEADERS, cookies=cookies, timeout=600) as client:
                client.get("/api/health")  # open the connection before the clock starts
                start.wait()
                mine = []
                for _ in range(requests_each):
                    began = time.perf_counter()
                    client.get(url).raise_for_status()
                    mine.append((time.perf_counter() - began) * 1000)
            with guard:
                durations.extend(mine)

        threads = [threading.Thread(target=work) for _ in range(clients)]
        for thread in threads:
            thread.start()
        start.wait()
        began = time.perf_counter()
        for thread in threads:
            thread.join()
        elapsed = time.perf_counter() - began
        durations.sort()
        return {
            "parallel_rps": round(len(durations) / elapsed, 1),
            "parallel_p50_ms": round(durations[len(durations) // 2], 1),
            "parallel_p95_ms": round(durations[min(len(durations) - 1, int(len(durations) * 0.95))], 1),
        }


def run(images: int, keep: bool, verbose: bool) -> dict[str, Any]:
    work = Path(tempfile.mkdtemp(prefix="annotamate-bench-"))
    root, data = work / "root", work / "data"
    dataset = root / "dataset"
    server: subprocess.Popen[bytes] | None = None
    log = (work / "server.log").open("wb")
    report: dict[str, Any] = {"images": images, "python": sys.version.split()[0], "platform": sys.platform}
    try:
        started = time.perf_counter()
        make_dataset(dataset, images)
        data.mkdir()
        report["generate_s"] = round(time.perf_counter() - started, 2)

        subprocess.run([sys.executable, "-m", "annotamate", "user", "create", "admin", "--admin", "--password-stdin",
                        "--data-dir", str(data)], input=(PASSWORD + "\n").encode(), check=True, stdout=log,
                       stderr=log)
        port = free_port()
        server = subprocess.Popen([sys.executable, "-m", "annotamate", "serve", "--port", str(port), "--root",
                                   str(root), "--data-dir", str(data), "--log-level", "warning"],
                                  stdout=log, stderr=log)
        base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 60
        while True:
            try:
                if httpx.get(f"{base}/api/health", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            if server.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("the server did not start; see " + str(work / "server.log"))
            time.sleep(0.1)

        memory = MemoryWatch(server.pid)
        bench = Bench(base)
        bench.login()
        memory.mark_idle()

        def note(name: str, value: Any) -> None:
            report[name] = value
            if verbose:
                print(f"{name}: {value}", file=sys.stderr, flush=True)

        def note_memory(phase: str) -> None:
            if memory.available:
                note(f"{phase}_peak_rss_mb", memory.phase_peak())

        began = time.perf_counter()
        response = bench.client.post("/api/projects", json={"name": "Benchmark", "image_dir": str(dataset),
                                                            "label_format": "yolo"})
        response.raise_for_status()
        pid = response.json()["id"]
        bench.wait_indexed(pid)
        note("first_index_s", round(time.perf_counter() - began, 2))
        note_memory("index")
        project = bench.get(f"/api/projects/{pid}")
        if project["image_count"] != images:
            raise RuntimeError(f"indexed {project['image_count']} images, expected {images}")

        began = time.perf_counter()
        bench.client.post(f"/api/projects/{pid}/rescan").raise_for_status()
        bench.wait_indexed(pid)
        note("rescan_unchanged_s", round(time.perf_counter() - began, 2))
        note_memory("rescan")

        images_url = f"/api/projects/{pid}/images"
        first = bench.get(images_url, limit=100)
        if first["total"] != images:
            raise RuntimeError(f"the list reports {first['total']} images, expected {images}")
        last_offset = max(0, images - 100)
        note("list_first_page_ms", bench.timed(lambda: bench.get(images_url, limit=100)))
        note("list_last_page_ms", bench.timed(lambda: bench.get(images_url, limit=100, offset=last_offset)))
        middle = bench.get(images_url, limit=1, offset=images // 2)["items"][0]["id"]
        note("neighbors_ms", bench.timed(lambda: bench.get(f"{images_url}/{middle}/neighbors")))
        note("project_detail_ms", bench.timed(lambda: bench.get(f"/api/projects/{pid}")))
        note("stats_ms", bench.timed(lambda: bench.get(f"/api/projects/{pid}/stats")))

        annotation_url = f"{images_url}/{middle}/annotation"
        class_id = project["classes"][0]["id"]
        samples = []
        for n in range(10):
            doc = bench.get(annotation_url)
            boxes = [{"id": f"00000000-0000-4000-8000-{n:012d}", "class_id": class_id, "raw_label": None,
                      "x1": 1.0 + n * 0.5, "y1": 1.0, "x2": 9.0, "y2": 9.0}]
            began = time.perf_counter()
            bench.client.put(annotation_url, json={"base_version": doc["version"], "boxes": boxes,
                                                   "force": False}).raise_for_status()
            samples.append((time.perf_counter() - began) * 1000)
        note("save_ms", round(statistics.median(samples), 2))

        for name, value in bench.parallel(f"{images_url}?limit=100&offset={images // 2}", 20, 10).items():
            note(name, value)
        note_memory("requests")

        seconds, size = bench.export(pid, "yolo")
        note("export_yolo_s", seconds)
        note("export_yolo_mb", round(size / 1e6, 2))
        note_memory("export_yolo")
        seconds, size = bench.export(pid, "coco")
        note("export_coco_s", seconds)
        note("export_coco_mb", round(size / 1e6, 2))
        note("export_coco_again_s", bench.export(pid, "coco")[0])
        note_memory("export_coco")

        began = time.perf_counter()
        bench.client.post(f"/api/projects/{pid}/rescan").raise_for_status()
        bench.wait_indexed(pid)
        note("rescan_after_work_s", round(time.perf_counter() - began, 2))

        memory.stop()
        if memory.available:
            note("idle_rss_mb", round(memory.idle / 1e6, 1))
            note("peak_rss_mb", round(memory.peak / 1e6, 1))
        size = sum(path.stat().st_size for path in data.glob("annotamate.db*"))  # with the write-ahead log
        if size:
            note("database_mb", round(size / 1e6, 2))
        return report
    finally:
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                server.wait(20)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(20)
        log.close()
        if keep:
            print(f"kept {work}", file=sys.stderr)
        else:
            shutil.rmtree(work, ignore_errors=True)


def check(report: dict[str, Any]) -> list[str]:
    """The measures that are past their limit, scaled linearly with the number of images where that applies."""
    scale = max(1.0, report["images"] / 10_000)
    scaled = {"first_index_s", "rescan_unchanged_s", "export_yolo_s", "export_coco_s"}
    problems = []
    for name, limit in THRESHOLDS_10K.items():
        if name not in report:
            continue
        allowed = limit * scale if name in scaled else limit
        if report[name] > allowed:
            problems.append(f"{name} = {report[name]} (limit {allowed:g})")
    for name, minimum in MINIMUMS_10K.items():
        if name in report and report[name] < minimum:
            problems.append(f"{name} = {report[name]} (minimum {minimum:g})")
    for name, (other, factor) in RATIOS.items():
        if name in report and other in report and report[name] > factor * report[other]:
            problems.append(f"{name} = {report[name]} (more than {factor:g} x {other} = {report[other]})")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--images", type=int, default=10_000, help="number of images to generate (default 10000)")
    parser.add_argument("--check", action="store_true", help="exit 1 when a measure is past its threshold")
    parser.add_argument("--keep", action="store_true", help="keep the temporary folder (dataset, data, server log)")
    parser.add_argument("--quiet", action="store_true", help="print only the JSON report")
    args = parser.parse_args()
    if args.images < 200:
        parser.error("--images must be at least 200")
    env_note = os.environ.get("PYTHONPATH")
    if env_note and not args.quiet:
        print(f"PYTHONPATH={env_note}", file=sys.stderr)
    report = run(args.images, args.keep, not args.quiet)
    problems = check(report) if args.check else []
    if args.check:
        report["check"] = "failed" if problems else "passed"
    print(json.dumps(report, indent=2))
    for problem in problems:
        print(f"REGRESSION: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
