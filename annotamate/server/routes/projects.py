"""Projects, members, statistics, rescans, uploads and export."""

import re
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from starlette.datastructures import UploadFile

from annotamate.server.deps import DB, Access, AdminUser, Ctx, CurrentUser
from annotamate.server.errors import bad_request
from annotamate.server.models import Project, ProjectMember, User
from annotamate.server.schemas import (
    Member,
    MemberIn,
    MemberPatch,
    ProjectCreate,
    ProjectPatch,
    ProjectSummary,
    PruneResult,
    RescanResult,
    Stats,
    UploadResult,
)
from annotamate.server.schemas import (
    Project as ProjectOut,
)
from annotamate.server.services import projects as svc
from annotamate.server.services import serialize
from annotamate.server.services.access import load_access
from annotamate.server.services.classes import has_pending_renames, schedule_rename
from annotamate.server.services.export import Exporter, select_items
from annotamate.server.services.indexing import index_project
from annotamate.server.services.labels import load_class_table
from annotamate.server.services.paths import ProjectPaths
from annotamate.server.services.stats import project_stats
from annotamate.server.services.uploads import IncomingFile, save_uploads

router = APIRouter(tags=["projects"])

MAX_UPLOAD_FILES = 1000


@router.get("/projects", response_model=list[ProjectSummary])
def list_projects(user: CurrentUser, ctx: Ctx, db: DB, archived: bool = False) -> list[dict]:
    query = select(Project).where(Project.archived.is_(archived))
    if not user.is_admin:
        query = query.join(ProjectMember, ProjectMember.project_id == Project.id).where(
            ProjectMember.user_id == user.id)
    projects = list(db.scalars(query.order_by(Project.name, Project.id)))
    return svc.summaries(ctx, db, projects, user)


@router.post("/projects", response_model=ProjectOut)
def create_project(body: ProjectCreate, admin: AdminUser, ctx: Ctx, db: DB) -> dict:
    project = svc.create_project(ctx, db, admin, body)
    return svc.detail(ctx, db, load_access(db, admin, project.id))


@router.get("/projects/{pid}", response_model=ProjectOut)
def get_project(access: Access, ctx: Ctx, db: DB) -> dict:
    return svc.detail(ctx, db, access)


@router.patch("/projects/{pid}", response_model=ProjectOut)
def patch_project(body: ProjectPatch, access: Access, ctx: Ctx, db: DB) -> dict:
    svc.update_project(ctx, db, access, body)
    return svc.detail(ctx, db, access)


@router.delete("/projects/{pid}", status_code=204)
def delete_project(access: Access, ctx: Ctx, db: DB) -> Response:
    svc.delete_project(ctx, db, access)
    return Response(status_code=204)


@router.post("/projects/{pid}/rescan", status_code=202, response_model=RescanResult)
def rescan(access: Access, ctx: Ctx, db: DB) -> dict:
    access.require_manage()
    # A rescan requested while one is waiting is merged into it; either way a fresh scan will run.
    started = index_project(ctx, access.project.id, record_activity=True) or ctx.is_indexing(access.project.id)
    if has_pending_renames(db, access.project.id):  # also retry a class rename that could not finish
        schedule_rename(ctx, access.project.id)
    return {"started": started}


@router.post("/projects/{pid}/prune-missing", response_model=PruneResult)
def prune_missing(access: Access, ctx: Ctx, db: DB) -> dict:
    """Permanently remove the images whose files disappeared (managers only)."""
    return {"removed": svc.prune_missing(ctx, db, access)}


@router.get("/projects/{pid}/stats", response_model=Stats)
def stats(access: Access, ctx: Ctx, db: DB, tz_offset: Annotated[int, Query(ge=-14 * 60, le=14 * 60)] = 0) -> dict:
    """``tz_offset``: the viewer's UTC offset in minutes (east positive), so "daily" follows their calendar."""
    return project_stats(ctx, db, access.project.id, tz_offset)


# ------------------------------------------------------------------------------------------- members


@router.get("/projects/{pid}/members", response_model=list[Member])
def list_members(access: Access, ctx: Ctx, db: DB) -> list[dict]:
    return svc.members_out(ctx, db, access.project.id)


@router.post("/projects/{pid}/members", response_model=Member)
def add_member(body: MemberIn, access: Access, ctx: Ctx, db: DB) -> dict:
    member = svc.add_member(ctx, db, access, body.user_id, body.role)
    db.commit()
    return member


@router.patch("/projects/{pid}/members/{uid}", response_model=Member)
def update_member(uid: int, body: MemberPatch, access: Access, ctx: Ctx, db: DB) -> dict:
    member = svc.update_member(ctx, db, access, uid, body.role)
    db.commit()
    target = db.get(User, uid)
    if body.role == "viewer" and target is not None and not target.is_admin:
        ctx.hub.revoke_locks(uid, {access.project.id}, serialize.brief(access.user))
    return member


@router.delete("/projects/{pid}/members/{uid}", status_code=204)
def remove_member(uid: int, access: Access, ctx: Ctx, db: DB) -> Response:
    svc.remove_member(ctx, db, access, uid)
    return Response(status_code=204)


# ------------------------------------------------------------------------------------------- upload / export


@router.post("/projects/{pid}/upload", response_model=UploadResult)
async def upload(request: Request, access: Access, ctx: Ctx, db: DB) -> dict:
    access.require_manage()
    access.require_writable()
    ctx.refuse_while_migrating(access.project.id)
    form = await request.form(max_files=MAX_UPLOAD_FILES, max_fields=50)
    try:
        uploads = [f for f in [*form.getlist("files[]"), *form.getlist("files")] if isinstance(f, UploadFile)]
        if not uploads:
            raise bad_request("No files were uploaded (use the multipart field 'files[]').")
        subdir = form.get("subdir")
        incoming = [IncomingFile(f.filename or "", f.size or 0, f.file) for f in uploads]
        # On the upload pool: checking and writing many files takes seconds, too long for a request thread.
        return await ctx.run_upload(save_uploads, ctx, db, access, incoming,
                                    subdir if isinstance(subdir, str) else None)
    finally:
        await form.close()


def _slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.") or "project"


@router.get("/projects/{pid}/export")
def export(access: Access, ctx: Ctx, db: DB, format: Literal["yolo", "voc", "coco"] | None = None,
           scope: Literal["all", "done"] = "all", include_images: bool = False) -> StreamingResponse:
    access.require_manage()
    project = access.project
    ctx.refuse_while_migrating(project.id)
    fmt = format or project.label_format
    paths = ProjectPaths(ctx.settings, project)
    paths.check()
    table = load_class_table(db, project.id, project.label_format)
    items = select_items(db, project, scope)
    exporter = Exporter(paths, table, fmt, items, include_images, ctx.read_guard(project.id))
    filename = f"{_slug(project.name)}-{fmt}.zip"
    return StreamingResponse(exporter.stream(), media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"',
                                      "Cache-Control": "no-store"})
