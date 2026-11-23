from fastapi import APIRouter

from annotamate import __version__
from annotamate.server.deps import Ctx
from annotamate.server.schemas import Health, Meta

router = APIRouter(tags=["meta"])


@router.get("/health", response_model=Health)
def health() -> dict:
    return {"status": "ok", "version": __version__}


@router.get("/meta", response_model=Meta)
def meta(ctx: Ctx) -> dict:
    return {"version": __version__, "app_name": "Annotamate", "max_upload_mb": ctx.settings.max_upload_mb}
