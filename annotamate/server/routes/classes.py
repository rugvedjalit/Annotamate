"""Project classes."""

from typing import Literal

from fastapi import APIRouter

from annotamate.server.deps import DB, Access, Ctx
from annotamate.server.errors import forbidden
from annotamate.server.schemas import ClassCreate, ClassDeleteResult, ClassPatch, ProjectClass
from annotamate.server.services import classes as svc
from annotamate.server.services import serialize
from annotamate.server.services.labels import load_class_table

router = APIRouter(tags=["classes"])


@router.get("/projects/{pid}/classes", response_model=list[ProjectClass])
def list_classes(access: Access, db: DB) -> list[dict]:
    table = load_class_table(db, access.project.id, access.project.label_format)
    return [serialize.class_out(c) for c in table.classes]


@router.post("/projects/{pid}/classes", response_model=ProjectClass)
def add_class(body: ClassCreate, access: Access, ctx: Ctx, db: DB) -> dict:
    if not access.can_add_classes:
        raise forbidden("Your role cannot add classes in this project.")
    return serialize.class_out(svc.add_class(ctx, db, access, body.name, body.color))


@router.patch("/projects/{pid}/classes/{cid}", response_model=ProjectClass)
def update_class(cid: int, body: ClassPatch, access: Access, ctx: Ctx, db: DB) -> dict:
    access.require_manage()
    cls = svc.get_class(db, access.project.id, cid)
    return serialize.class_out(svc.update_class(ctx, db, access, cls, name=body.name, color=body.color))


@router.delete("/projects/{pid}/classes/{cid}", response_model=ClassDeleteResult)
def delete_class(cid: int, access: Access, ctx: Ctx, db: DB,
                 strategy: Literal["forbid", "delete_boxes", "merge"] = "forbid",
                 merge_into: int | None = None) -> dict:
    access.require_manage()
    cls = svc.get_class(db, access.project.id, cid)
    return {"rewritten_files": svc.delete_class(ctx, db, access, cls, strategy=strategy, merge_into=merge_into)}
