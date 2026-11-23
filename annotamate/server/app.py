"""``create_app(settings)``: the API, the WebSocket hub and the single-page app under one base URL."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from annotamate import __version__
from annotamate.core.fsutil import OutsideRootError, resolve_inside
from annotamate.server.config import Settings
from annotamate.server.context import AppContext, JobRunner
from annotamate.server.db import Database
from annotamate.server.errors import error_body, install_error_handlers, not_found
from annotamate.server.models import Project, ProjectClass
from annotamate.server.routes import api_router
from annotamate.server.routes.auth import set_session_cookie
from annotamate.server.security import CSRF_HEADER
from annotamate.server.services.indexing import index_project

log = logging.getLogger("annotamate.server")

CONFIG_PLACEHOLDER = "<!--annotamate:config-->"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSP_TEMPLATE = (
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'{scripts}; "
    "connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'; "
    "frame-ancestors 'none'; form-action 'self'"
)
DEFAULT_CSP = CSP_TEMPLATE.format(scripts="")
SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
}
#: Fixed types for SPA assets: on Windows ``mimetypes`` reads the registry, which may map ``.js`` to
#: ``text/plain`` (fatal for module scripts with ``nosniff``).
STATIC_TYPES = {
    ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html",
    ".json": "application/json", ".map": "application/json", ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2",
    ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm", ".txt": "text/plain",
}
_INLINE_SCRIPT = re.compile(r"<script(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script>", re.IGNORECASE | re.DOTALL)
_HEAD_TAG = re.compile(r"<head(\s[^>]*)?>", re.IGNORECASE)

BUILD_HINT = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Annotamate</title>
<style>body{{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#16181d}}
code{{background:#eef1f5;padding:.15rem .35rem;border-radius:4px}}</style></head>
<body><h1>Annotamate {version}</h1>
<p>The server is running, but the web interface has not been built.</p>
<p>From a source checkout, build it with:</p>
<p><code>cd web &amp;&amp; npm ci &amp;&amp; npm run build</code></p>
<p>then reload this page. The API is available under <code>{base}api/</code>.</p></body></html>
"""


class HttpMiddleware:
    """CSRF header check for mutating API requests, security headers and sliding session cookies."""

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings
        self.api_prefix = settings.api_prefix

    def _is_api(self, path: str) -> bool:
        return path == self.api_prefix or path.startswith(self.api_prefix + "/")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if (scope["method"] not in SAFE_METHODS and self._is_api(scope["path"])
                and not Headers(scope=scope).get(CSRF_HEADER, "").strip()):
            response = JSONResponse(error_body(403, f"Missing {CSRF_HEADER} header.", "csrf"), status_code=403)
            await response(scope, receive, self._wrap(send, {}))
            return
        state = scope.setdefault("state", {})
        await self.app(scope, receive, self._wrap(send, state))

    def _wrap(self, send: Send, state: dict) -> Send:
        async def wrapped(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in SECURITY_HEADERS.items():
                    if name not in headers:
                        headers[name] = value
                if "content-security-policy" not in headers:
                    headers["content-security-policy"] = DEFAULT_CSP
                token = state.get("refresh_session")
                if token:
                    cookie = Response()
                    set_session_cookie(cookie, self.settings, token)
                    headers.append("set-cookie", cookie.headers["set-cookie"])
            await send(message)

        return wrapped


class SpaRenderer:
    """Serves ``index.html`` with the runtime config injected and a CSP that allows exactly its inline scripts."""

    def __init__(self, static_dir: Path, base_url: str) -> None:
        self.static_dir = static_dir
        self.base_url = base_url
        self._cache: tuple[tuple[int, int], str, str] | None = None

    @property
    def index_path(self) -> Path:
        return self.static_dir / "index.html"

    def render(self) -> tuple[str, str]:
        stat = self.index_path.stat()
        key = (stat.st_mtime_ns, stat.st_size)
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1], self._cache[2]
        html = self.index_path.read_text(encoding="utf-8")
        config = json.dumps({"baseUrl": self.base_url}, separators=(",", ":")).replace("</", "<\\/")
        script = f"<script>window.__ANNOTAMATE__={config}</script>"
        if CONFIG_PLACEHOLDER in html:
            html = html.replace(CONFIG_PLACEHOLDER, script)
        else:
            html = html.replace("</head>", f"{script}</head>", 1)
        if "<base " not in html.lower():
            # Relative asset URLs ("./assets/...") must resolve from the base URL on deep client-side routes.
            html = _HEAD_TAG.sub(lambda m: f'{m.group(0)}<base href="{self.base_url}">', html, count=1)
        hashes = []
        for body in _INLINE_SCRIPT.findall(html):
            digest = base64.b64encode(hashlib.sha256(body.encode("utf-8")).digest()).decode("ascii")
            hashes.append(f" 'sha256-{digest}'")
        csp = CSP_TEMPLATE.format(scripts="".join(dict.fromkeys(hashes)))
        self._cache = (key, html, csp)
        return html, csp


def _install_spa(app: FastAPI, settings: Settings) -> None:
    base = settings.base_url
    prefix = base.rstrip("/")
    static_dir = settings.resolved_static_dir
    renderer = SpaRenderer(static_dir, base)

    def index() -> Response:
        try:
            html, csp = renderer.render()
        except OSError:
            return HTMLResponse(BUILD_HINT.format(version=__version__, base=base),
                                headers={"Cache-Control": "no-cache"})
        return HTMLResponse(html, headers={"Cache-Control": "no-cache", "Content-Security-Policy": csp})

    def serve(path: str) -> Response:
        if path == "api" or path.startswith("api/"):
            raise not_found("Unknown API endpoint.")
        if path and os.path.isdir(static_dir):
            try:
                file = resolve_inside(str(static_dir), path)
            except OutsideRootError:
                file = None
            if file and os.path.isfile(file) and os.path.basename(file) != "index.html":
                cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
                media = STATIC_TYPES.get(os.path.splitext(file)[1].lower())
                return FileResponse(file, media_type=media, headers={"Cache-Control": cache})
            if path.startswith("assets/"):
                raise not_found("File not found.")
        return index()

    @app.api_route(prefix + "/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def spa(path: str) -> Response:
        return serve(path)

    if prefix:
        @app.api_route(prefix, methods=["GET", "HEAD"], include_in_schema=False)
        def spa_root_redirect() -> Response:
            return RedirectResponse(base, status_code=308)

        @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
        def outside_base() -> Response:
            return RedirectResponse(base, status_code=307)


def quiet_connection_resets(loop: asyncio.AbstractEventLoop) -> None:
    """Drop the traceback asyncio logs when a client resets its connection.

    Windows' proactor event loop reports every abruptly closed browser socket (tab closed, reload, a cancelled
    request) as an ``ERROR`` with a full ``ConnectionResetError`` traceback; it is harmless. Anything else still
    goes to the previous (or default) handler.
    """
    previous = loop.get_exception_handler()

    def handler(loop: asyncio.AbstractEventLoop, context: dict) -> None:
        if isinstance(context.get("exception"), (ConnectionResetError, ConnectionAbortedError)):
            log.debug("Client connection reset: %s", context.get("exception"))
            return
        if previous is not None:
            previous(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(handler)


def _resume_indexing(ctx: AppContext) -> None:
    with ctx.db.session() as session:
        pending = list(session.scalars(select(Project.id).where(Project.indexed_at.is_(None))))
        with_classes = set(session.scalars(select(ProjectClass.project_id).where(ProjectClass.project_id.in_(pending))))
    for project_id in pending:
        index_project(ctx, project_id, discover_classes=project_id not in with_classes)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the application. The database is migrated to the latest schema before this returns."""
    settings = settings or Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    db = Database(settings.db_url)
    db.migrate()
    ctx = AppContext(settings, db)
    db.publish = lambda items: ctx.hub.publish(items)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if ctx.jobs.stopping.is_set():
            ctx.jobs = JobRunner()
        loop = asyncio.get_running_loop()
        quiet_connection_resets(loop)
        ctx.hub.start(loop)
        await run_in_threadpool(_resume_indexing, ctx)
        try:
            yield
        finally:
            await ctx.hub.stop()
            await run_in_threadpool(ctx.jobs.shutdown)

    app = FastAPI(
        title="Annotamate",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=f"{settings.api_prefix}/openapi.json",
    )
    app.state.ctx = ctx
    install_error_handlers(app)
    app.include_router(api_router(), prefix=settings.api_prefix)
    _install_spa(app, settings)
    app.add_middleware(HttpMiddleware, settings=settings)
    return app
