#!/usr/bin/env python3
"""Set up Annotamate from a source checkout in one command (Linux, macOS and Windows).

    python scripts/bootstrap.py                       # install into .venv and build the web interface
    python scripts/bootstrap.py --admin admin         # ... and create an administrator account
    python scripts/bootstrap.py --start --root ~/data # ... and start the server

Steps: check Python and Node.js, create ``.venv``, install the package into it, build the web interface
(``web/`` -> ``annotamate/server/static``) and verify the result. Every step is safe to repeat.

Non-interactive use (CI, AI agents): pass ``--admin NAME`` and put the password in the environment variable
``ANNOTAMATE_ADMIN_PASSWORD``; nothing then waits for keyboard input. Exit code 0 means success.
Only the Python standard library is used, so this runs before anything is installed.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV = ROOT / ".venv"
WEB = ROOT / "web"
STATIC_INDEX = ROOT / "annotamate" / "server" / "static" / "index.html"
MIN_PYTHON = (3, 11)
#: Vite 8 needs Node.js ^20.19 or >= 22.12; CI and the Docker image use Node.js 24.
MIN_NODE = ((20, 19), (22, 12))
PASSWORD_ENV = "ANNOTAMATE_ADMIN_PASSWORD"  # noqa: S105 - the variable's name, not a password
WINDOWS = os.name == "nt"


class SetupError(Exception):
    """A step failed; the message says what to do."""


def step(number: int, total: int, text: str) -> None:
    print(f"\n[{number}/{total}] {text}", flush=True)


def ok(text: str) -> None:
    print(f"      ok: {text}", flush=True)


def run(command: list[str], *, cwd: Path = ROOT, stdin_text: str | None = None) -> None:
    shown = " ".join(command)
    print(f"      $ {shown}", flush=True)
    try:
        result = subprocess.run(command, cwd=cwd, input=stdin_text, text=stdin_text is not None, check=False)
    except FileNotFoundError as exc:
        raise SetupError(f"Could not run {command[0]}: {exc}") from None
    if result.returncode != 0:
        raise SetupError(f"Command failed with exit code {result.returncode}: {shown}")


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if WINDOWS else "bin/python")


def venv_annotamate() -> Path:
    return VENV / ("Scripts/annotamate.exe" if WINDOWS else "bin/annotamate")


def check_python() -> None:
    version = sys.version_info[:3]
    if version[:2] < MIN_PYTHON:
        raise SetupError(f"Python {'.'.join(map(str, MIN_PYTHON))} or newer is required; this is "
                         f"{'.'.join(map(str, version))}. Install a newer Python and run this script with it.")
    ok(f"Python {'.'.join(map(str, version))} ({sys.executable})")


def find_npm() -> str | None:
    return shutil.which("npm.cmd" if WINDOWS else "npm") or shutil.which("npm")


def check_node(required: bool) -> str | None:
    """Path of npm when Node.js is usable; raises when it is required but missing or too old."""
    node = shutil.which("node")
    npm = find_npm()
    if node is None or npm is None:
        if required:
            raise SetupError("Node.js (with npm) is needed to build the web interface. Install Node.js 24 LTS "
                             "from https://nodejs.org/ (or 22.12+), or run with --skip-web if "
                             "annotamate/server/static is already built.")
        return None
    output = subprocess.run([node, "--version"], capture_output=True, text=True, check=False).stdout.strip()
    match = re.match(r"v(\d+)\.(\d+)", output)
    version = (int(match.group(1)), int(match.group(2))) if match else (0, 0)
    supported = (version[0] == MIN_NODE[0][0] and version >= MIN_NODE[0]) or version >= MIN_NODE[1]
    if not supported:
        raise SetupError(f"Node.js {output or '(unknown version)'} is too old; the web build needs 20.19+ or "
                         "22.12+ (24 LTS recommended).")
    ok(f"Node.js {output}, npm at {npm}")
    return npm


def create_venv() -> None:
    if venv_python().exists():
        ok(f"reusing {VENV}")
        return
    run([sys.executable, "-m", "venv", str(VENV)])
    ok(f"created {VENV}")


def install_package(dev: bool) -> None:
    python = str(venv_python())
    run([python, "-m", "pip", "install", "--quiet", "--upgrade", "pip"])
    target = ".[dev]" if dev else "."
    run([python, "-m", "pip", "install", "--quiet", "--editable", target])
    ok("installed annotamate" + (" with development tools" if dev else ""))


def build_web(npm: str) -> None:
    run([npm, "ci", "--no-audit", "--no-fund"], cwd=WEB)
    run([npm, "run", "build"], cwd=WEB)
    if not STATIC_INDEX.exists():
        raise SetupError(f"The web build finished but {STATIC_INDEX} is missing.")
    ok(f"web interface built into {STATIC_INDEX.parent}")


def verify() -> None:
    annotamate = str(venv_annotamate())
    result = subprocess.run([annotamate, "--version"], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise SetupError(f"`annotamate --version` failed: {result.stderr.strip()}")
    ok(result.stdout.strip())
    if not STATIC_INDEX.exists():
        raise SetupError("The web interface is not built (annotamate/server/static/index.html is missing). "
                         "Run again without --skip-web.")
    ok("web interface present")


def create_admin(name: str, data_dir: str | None) -> None:
    command = [str(venv_annotamate()), "user", "create", name, "--admin"]
    if data_dir:
        command += ["--data-dir", data_dir]
    password = os.environ.get(PASSWORD_ENV)
    if password is not None:
        run([*command, "--password-stdin"], stdin_text=password + "\n")
    else:
        if not sys.stdin.isatty():
            raise SetupError(f"No terminal to ask for the password: set {PASSWORD_ENV} for non-interactive use.")
        run(command)  # the CLI prompts for the password twice
    ok(f"administrator '{name}' created")


def wait_for_health(url: str, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:  # noqa: S310 - local URL built here
                if response.status == 200:
                    return True
        except OSError:
            time.sleep(0.5)
    return False


def serve(args: argparse.Namespace) -> int:
    command = [str(venv_annotamate()), "serve", "--host", args.host, "--port", str(args.port)]
    for root in args.root or []:
        command += ["--root", root]
    if args.data_dir:
        command += ["--data-dir", args.data_dir]
    print(f"\nStarting the server (Ctrl+C stops it): {' '.join(command)}", flush=True)
    process = subprocess.Popen(command, cwd=ROOT)
    wildcard = args.host in ("0.0.0.0", "::")  # noqa: S104 - turns a wildcard bind into a local URL
    host = "127.0.0.1" if wildcard else args.host
    url = f"http://{host}:{args.port}/api/health"
    if wait_for_health(url):
        print(f"\nAnnotamate is up: open http://{host}:{args.port}/ (health check {url} answered 200)", flush=True)
    else:
        print(f"\nThe server did not answer {url} within 30 seconds; see its output above.", flush=True)
    try:
        return process.wait()
    except KeyboardInterrupt:
        process.terminate()
        return 0


def next_steps(args: argparse.Namespace) -> None:
    annotamate = venv_annotamate()
    root = args.root[0] if args.root else str(ROOT / "datasets")
    data = f' --data-dir "{args.data_dir}"' if args.data_dir else ""
    if args.admin:
        account = f"Then open http://127.0.0.1:8765/ and sign in as '{args.admin}'."
    else:
        account = ("Then open http://127.0.0.1:8765/ and create the administrator account,\n"
                   f"or on the command line: {annotamate} user create admin --admin{data}")
    print(f"""
Setup complete.

Start the server (projects may be created inside the --root folder):
    {annotamate} serve --root "{root}"{data}

{account}

Full guide: docs/guides/setup.md""", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Set up Annotamate from this source checkout.")
    parser.add_argument("--dev", action="store_true", help="also install the development tools (tests, linters)")
    parser.add_argument("--skip-web", action="store_true", help="do not build the web interface (already built)")
    parser.add_argument("--admin", metavar="NAME",
                        help=f"create an administrator account (password from ${PASSWORD_ENV} or a prompt)")
    parser.add_argument("--data-dir", help="data folder for the database (default: per-user application data)")
    parser.add_argument("--start", action="store_true", help="start the server when setup is done")
    parser.add_argument("--root", action="append", metavar="PATH",
                        help="folder projects may live in (repeatable; used with --start)")
    parser.add_argument("--host", default="127.0.0.1", help="interface for --start (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="port for --start (default 8765)")
    args = parser.parse_args(argv)

    total = 4 + (args.admin is not None)
    try:
        step(1, total, "Checking Python and Node.js")
        check_python()
        npm = check_node(required=not args.skip_web)
        step(2, total, "Creating the virtual environment")
        create_venv()
        install_package(args.dev)
        step(3, total, "Building the web interface")
        if args.skip_web:
            ok("skipped (--skip-web)")
        else:
            assert npm is not None
            build_web(npm)
        step(4, total, "Verifying the installation")
        verify()
        if args.admin is not None:
            step(5, total, f"Creating the administrator '{args.admin}'")
            create_admin(args.admin, args.data_dir)
    except SetupError as exc:
        print(f"\nSetup failed: {exc}", file=sys.stderr, flush=True)
        return 1
    if args.start:
        if not args.root:
            default_root = ROOT / "datasets"
            default_root.mkdir(exist_ok=True)
            args.root = [str(default_root)]
        return serve(args)
    next_steps(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
