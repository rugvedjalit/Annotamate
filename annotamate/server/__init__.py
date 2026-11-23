"""The Annotamate web server (FastAPI)."""

from annotamate.server.app import create_app
from annotamate.server.config import Settings

__all__ = ["Settings", "create_app"]
