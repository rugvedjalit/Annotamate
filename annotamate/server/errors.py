"""Uniform error bodies: ``{detail, code, ...extra}`` for every failure."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("annotamate.server")

DEFAULT_CODES = {
    400: "bad_request",
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "too_large",
    415: "unsupported_media_type",
    422: "validation_error",
    423: "locked",
    429: "rate_limited",
}


class ApiError(StarletteHTTPException):
    """An HTTP error with a machine-readable ``code`` and optional extra body fields."""

    def __init__(self, status_code: int, code: str, detail: str, *, headers: dict[str, str] | None = None,
                 **extra: Any) -> None:
        super().__init__(status_code=status_code, detail=detail, headers=headers)
        self.code = code
        self.extra = extra


def bad_request(detail: str, **extra: Any) -> ApiError:
    return ApiError(400, "bad_request", detail, **extra)


def forbidden(detail: str = "You do not have permission to do this.") -> ApiError:
    return ApiError(403, "forbidden", detail)


def not_found(detail: str = "Not found.") -> ApiError:
    return ApiError(404, "not_found", detail)


def conflict(code: str, detail: str, **extra: Any) -> ApiError:
    return ApiError(409, code, detail, **extra)


def validation_error(loc: list[str | int], msg: str) -> ApiError:
    return ApiError(422, "validation_error", msg, errors=[{"loc": [str(p) for p in loc], "msg": msg}])


def error_body(status_code: int, detail: str, code: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"detail": detail, "code": code or DEFAULT_CODES.get(status_code, "error"), **extra}


async def _http_exception(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    if isinstance(exc, ApiError):
        body = error_body(exc.status_code, str(exc.detail), exc.code, **exc.extra)
    else:
        detail = exc.detail if isinstance(exc.detail, str) else "Request failed."
        body = error_body(exc.status_code, detail)
    return JSONResponse(body, status_code=exc.status_code, headers=getattr(exc, "headers", None))


async def _validation_exception(_request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = [{"loc": [str(p) for p in err.get("loc", ())], "msg": str(err.get("msg", ""))} for err in exc.errors()]
    first = errors[0] if errors else None
    detail = "Invalid request."
    if first:
        field = ".".join(p for p in first["loc"] if p not in ("body", "query", "path"))
        detail = f"{field}: {first['msg']}" if field else first["msg"]
    return JSONResponse(error_body(422, detail, "validation_error", errors=errors), status_code=422)


async def _unexpected_exception(request: Request, exc: Exception) -> JSONResponse:
    log.exception("Unhandled error on %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse(error_body(500, "Internal server error.", "internal_error"), status_code=500)


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(StarletteHTTPException, _http_exception)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _validation_exception)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, _unexpected_exception)
