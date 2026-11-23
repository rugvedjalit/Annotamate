"""Server settings (``ANNOTAMATE_*`` environment variables, overridden by CLI flags)."""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def default_data_dir() -> Path:
    """``%LOCALAPPDATA%\\Annotamate`` on Windows, ``$XDG_DATA_HOME/annotamate`` (or ``~/.local/share``) elsewhere."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
        return Path(base) / "Annotamate"
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return Path(base) / "annotamate"


_BASE_URL_CHARS = re.compile(r"^/[A-Za-z0-9._~\-/]*$")


def normalize_base_url(value: str) -> str:
    """``""`` -> ``"/"``, ``"x"`` / ``"/x"`` -> ``"/x/"``.

    Only unreserved URL characters are accepted (``A-Z a-z 0-9 . _ ~ -`` and ``/``); anything else, and
    ``.`` / ``..`` path segments, raise ``ValueError`` so a bad value stops the server at start-up.
    """
    value = (value or "/").strip()
    parts = [p for p in value.split("/") if p]
    normalized = "/" + "".join(f"{p}/" for p in parts)
    if not _BASE_URL_CHARS.match(normalized) or any(p in (".", "..") for p in parts):
        raise ValueError("base_url may only contain letters, digits and . _ ~ - separated by /, "
                         f"for example /annotamate/ (got {value!r})")
    return normalized


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ANNOTAMATE_", extra="ignore")

    host: str = "127.0.0.1"
    port: int = Field(8765, ge=1, le=65535)
    roots: Annotated[list[str], NoDecode] = Field(default_factory=lambda: [os.getcwd()])
    data_dir: Path = Field(default_factory=default_data_dir)
    database_url: str | None = None
    base_url: str = "/"
    secure_cookies: bool = False
    session_days: int = Field(14, ge=1, le=3650)
    #: Absolute session lifetime: a session ends this many days after sign-in, however often it is used.
    session_max_days: int = Field(90, ge=1, le=3650)
    max_upload_mb: int = Field(50, ge=1)
    #: Largest request body for everything except uploads (JSON, forms), in MB.
    max_body_mb: int = Field(2, ge=1)
    #: Largest whole upload request (all files together), in MB. ``max_upload_mb`` still limits each file.
    max_upload_request_mb: int = Field(1024, ge=1)
    #: Images with more pixels than this are refused (decompression-bomb protection), in megapixels.
    max_image_megapixels: int = Field(150, ge=1)
    #: Failed sign-ins allowed per public client address in 10 minutes, across all usernames (0 = no limit).
    #: Loopback and private addresses only get the per-account limit (see the deployment guide).
    login_ip_limit: int = Field(30, ge=0)
    log_level: str = "info"
    #: Folder holding the built SPA. Defaults to the ``static`` folder shipped inside the package.
    static_dir: Path | None = None
    #: Upper bound for each on-disk cache (thumbnails, re-encoded images), in MB.
    cache_max_mb: int = Field(2048, ge=16)

    @field_validator("roots", mode="before")
    @classmethod
    def _split_roots(cls, value: object) -> object:
        if isinstance(value, str):
            return [p for p in value.split(os.pathsep) if p.strip()]
        return value

    @field_validator("roots")
    @classmethod
    def _resolve_roots(cls, value: list[str]) -> list[str]:
        resolved: list[str] = []
        for root in value:
            real = os.path.realpath(os.path.expanduser(root))
            if real not in resolved:
                resolved.append(real)
        if not resolved:
            raise ValueError("at least one root folder is required")
        return resolved

    @field_validator("base_url")
    @classmethod
    def _base_url(cls, value: str) -> str:
        return normalize_base_url(value)

    @field_validator("log_level")
    @classmethod
    def _log_level(cls, value: str) -> str:
        return value.lower()

    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        return "sqlite:///" + (self.data_dir / "annotamate.db").as_posix()

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def resolved_static_dir(self) -> Path:
        return self.static_dir or Path(__file__).resolve().parent / "static"

    @property
    def journal_dir(self) -> Path:
        """Where in-flight multi-file label rewrites are journalled (rolled back at start-up)."""
        return self.data_dir / "journal"

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def max_body_bytes(self) -> int:
        return self.max_body_mb * 1024 * 1024

    @property
    def max_upload_request_bytes(self) -> int:
        return self.max_upload_request_mb * 1024 * 1024

    @property
    def api_prefix(self) -> str:
        """``/api`` or ``/x/api`` (no trailing slash)."""
        return f"{self.base_url}api"
