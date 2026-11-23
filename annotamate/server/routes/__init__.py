"""HTTP and WebSocket routes, one module per area of the API."""

from fastapi import APIRouter

from annotamate.server.routes import (
    activity,
    annotations,
    auth,
    chat,
    classes,
    comments,
    dm,
    fs,
    images,
    meta,
    notifications,
    projects,
    users,
    ws,
)


def api_router() -> APIRouter:
    router = APIRouter()
    for module in (meta, auth, users, fs, projects, classes, images, annotations, comments, chat, dm, notifications,
                   activity, ws):
        router.include_router(module.router)
    return router
