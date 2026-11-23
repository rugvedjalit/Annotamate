"""The ``annotamate`` command: ``serve``, ``user``, ``desktop`` and ``version``."""

from __future__ import annotations

import argparse
import getpass
import ipaddress
import logging
import socket
import sys
import threading
import time
import webbrowser
from collections.abc import Sequence
from typing import Any

from annotamate import __version__


def _settings(args: argparse.Namespace):
    """Settings from the environment, overridden by the flags that were given."""
    from annotamate.server.config import Settings

    overrides: dict[str, Any] = {}
    for name in ("host", "port", "data_dir", "base_url", "log_level"):
        value = getattr(args, name, None)
        if value is not None:
            overrides[name] = value
    if getattr(args, "root", None):
        overrides["roots"] = args.root
    if getattr(args, "secure_cookies", False):
        overrides["secure_cookies"] = True
    return Settings(**overrides)


def _is_loopback(host: str) -> bool:
    if host in ("localhost", ""):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _display_url(host: str, port: int, base_url: str) -> str:
    shown = host
    if host in ("0.0.0.0", "::", ""):
        shown = "localhost"
    elif ":" in host and not host.startswith("["):
        shown = f"[{host}]"
    return f"http://{shown}:{port}{base_url}"


# ---------------------------------------------------------------------------------------------- serve


def cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    from annotamate.server.app import create_app
    from annotamate.server.services.users import user_count

    settings = _settings(args)
    logging.basicConfig(level=settings.log_level.upper(), format="%(levelname)s %(name)s: %(message)s")
    if settings.log_level != "debug":
        logging.getLogger("alembic").setLevel(logging.WARNING)  # migration chatter before the banner
    app = create_app(settings)
    with app.state.ctx.db.session() as session:
        needs_setup = user_count(session) == 0

    url = _display_url(settings.host, settings.port, settings.base_url)
    print(f"Annotamate {__version__}")
    print(f"  Data folder : {settings.data_dir}")
    for root in settings.roots:
        print(f"  Root        : {root}")
    print(f"\n  Open {url}\n")
    if settings.host in ("0.0.0.0", "::"):
        print(f"  (listening on all interfaces; from other machines use http://{socket.gethostname()}:"
              f"{settings.port}{settings.base_url})")
    if needs_setup:
        print("  No accounts yet: the first visit asks you to create the administrator.")
    if not _is_loopback(settings.host) and not settings.secure_cookies:
        print("\n  WARNING: listening on a non-loopback address without --secure-cookies. Session cookies\n"
              "  travel in clear text over plain HTTP. Put Annotamate behind HTTPS (see deploy/) and pass\n"
              "  --secure-cookies.", file=sys.stderr)
    print("  Press Ctrl+C to stop.\n", flush=True)

    config = uvicorn.Config(app, host=settings.host, port=settings.port, log_level=settings.log_level,
                            proxy_headers=True, workers=1, ws_max_size=1024 * 1024)
    server = uvicorn.Server(config)
    if args.open:
        local_url = _display_url("127.0.0.1" if settings.host in ("0.0.0.0", "") else settings.host,
                                 settings.port, settings.base_url)

        def open_when_ready() -> None:
            for _ in range(200):
                if server.started:
                    webbrowser.open(local_url)
                    return
                time.sleep(0.05)

        threading.Thread(target=open_when_ready, daemon=True).start()
    server.run()
    return 0


# ---------------------------------------------------------------------------------------------- user


def _db(args: argparse.Namespace):
    from annotamate.server.db import Database

    settings = _settings(args)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    db = Database(settings.db_url)
    db.migrate()
    return db


def _ask_password(confirm: bool = True) -> str:
    from annotamate.server.security import MIN_PASSWORD_LENGTH

    while True:
        password = getpass.getpass("Password: ")
        if len(password) < MIN_PASSWORD_LENGTH:
            print(f"Passwords need at least {MIN_PASSWORD_LENGTH} characters.", file=sys.stderr)
            continue
        if confirm and getpass.getpass("Repeat password: ") != password:
            print("The passwords do not match.", file=sys.stderr)
            continue
        return password


def cmd_user_create(args: argparse.Namespace) -> int:
    from pydantic import ValidationError

    from annotamate.server.errors import ApiError
    from annotamate.server.schemas import UserCreate
    from annotamate.server.services.users import create_user

    password = args.password if args.password is not None else _ask_password()
    try:
        body = UserCreate(username=args.username, display_name=args.display_name or args.username,
                          password=password, is_admin=args.admin)
    except ValidationError as exc:
        for err in exc.errors():
            print(f"{'.'.join(map(str, err['loc']))}: {err['msg']}", file=sys.stderr)
        return 2
    db = _db(args)
    with db.session() as session:
        try:
            user = create_user(session, username=body.username, display_name=body.display_name,
                               password=body.password, is_admin=body.is_admin)
        except ApiError as exc:
            print(exc.detail, file=sys.stderr)
            return 1
        session.commit()
        print(f"Created {'administrator' if user.is_admin else 'user'} '{user.username}'.")
    db.dispose()
    return 0


def cmd_user_passwd(args: argparse.Namespace) -> int:
    from annotamate.server.security import hash_password
    from annotamate.server.services.users import find_by_username, revoke_sessions

    db = _db(args)
    with db.session() as session:
        user = find_by_username(session, args.username)
        if user is None:
            print(f"No user named '{args.username}'.", file=sys.stderr)
            return 1
        user.password_hash = hash_password(_ask_password())
        revoke_sessions(session, user.id)
        session.commit()
        print(f"Password changed for '{user.username}'; their sessions were signed out.")
    db.dispose()
    return 0


def cmd_user_list(args: argparse.Namespace) -> int:
    from sqlalchemy import select

    from annotamate.server.models import User

    db = _db(args)
    with db.session() as session:
        users = list(session.scalars(select(User).order_by(User.username)))
        if not users:
            print("No users yet.")
        for u in users:
            flags = ", ".join(f for f, on in (("admin", u.is_admin), ("inactive", not u.is_active)) if on)
            print(f"{u.username:<32} {u.display_name}" + (f"  ({flags})" if flags else ""))
    db.dispose()
    return 0


# ---------------------------------------------------------------------------------------------- others


def cmd_desktop(_args: argparse.Namespace) -> int:
    from annotamate.desktop import run

    return run()


def cmd_version(_args: argparse.Namespace) -> int:
    print(f"annotamate {__version__}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="annotamate", description="Self-hosted, multi-user image annotation.")
    parser.add_argument("--version", action="version", version=f"annotamate {__version__}")
    sub = parser.add_subparsers(dest="command")

    def data_dir_option(p: argparse.ArgumentParser) -> None:
        p.add_argument("--data-dir", help="folder for the database and caches (env ANNOTAMATE_DATA_DIR)")

    serve = sub.add_parser("serve", help="run the web server")
    serve.add_argument("--host", help="interface to bind (default 127.0.0.1)")
    serve.add_argument("--port", type=int, help="port (default 8765)")
    serve.add_argument("--root", action="append", metavar="PATH",
                       help="folder projects may live in (repeatable; default: current directory)")
    data_dir_option(serve)
    serve.add_argument("--base-url", help="URL prefix when served behind a reverse proxy, e.g. /annotamate/")
    serve.add_argument("--secure-cookies", action="store_true", help="mark cookies Secure (use behind HTTPS)")
    serve.add_argument("--open", action=argparse.BooleanOptionalAction, default=False,
                       help="open a browser once the server is up")
    serve.add_argument("--log-level", choices=["critical", "error", "warning", "info", "debug"])
    serve.set_defaults(func=cmd_serve)

    user = sub.add_parser("user", help="manage accounts")
    user_sub = user.add_subparsers(dest="user_command", required=True)
    create = user_sub.add_parser("create", help="create an account")
    create.add_argument("username")
    create.add_argument("--admin", action="store_true", help="grant administrator rights")
    create.add_argument("--display-name")
    create.add_argument("--password", help="password (prompted when omitted)")
    data_dir_option(create)
    create.set_defaults(func=cmd_user_create)
    passwd = user_sub.add_parser("passwd", help="set a new password (prompts)")
    passwd.add_argument("username")
    data_dir_option(passwd)
    passwd.set_defaults(func=cmd_user_passwd)
    listing = user_sub.add_parser("list", help="list accounts")
    data_dir_option(listing)
    listing.set_defaults(func=cmd_user_list)

    desktop = sub.add_parser("desktop", help="launch the legacy desktop app (needs the [desktop] extra)")
    desktop.set_defaults(func=cmd_desktop)
    version = sub.add_parser("version", help="print the version")
    version.set_defaults(func=cmd_version)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:  # bare `annotamate`: local use, open the browser
        args = parser.parse_args(["serve", "--open"])
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:
        return 130
