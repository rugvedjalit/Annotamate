"""Project chat."""

from typing import Annotated

from fastapi import APIRouter, Query, Response
from sqlalchemy import select

from annotamate.server.deps import DB, Access
from annotamate.server.models import ChatMessage as ChatRow
from annotamate.server.schemas import ChatCreate, ChatMessage, ChatPage, ChatPatch, ChatReadIn
from annotamate.server.services import messages as svc
from annotamate.server.services import serialize

router = APIRouter(tags=["chat"])


@router.get("/projects/{pid}/chat", response_model=ChatPage)
def list_chat(access: Access, db: DB, before_id: int | None = None,
              limit: Annotated[int, Query(ge=1, le=200)] = 50) -> dict:
    query = select(ChatRow).where(ChatRow.project_id == access.project.id)
    rows, has_more = svc.page(query, ChatRow.id, before_id, limit, db)
    return {"items": serialize.chat_messages(db, rows), "has_more": has_more}


@router.post("/projects/{pid}/chat", response_model=ChatMessage)
def post_chat(body: ChatCreate, access: Access, db: DB) -> dict:
    out = svc.post_chat(db, access, body.body, body.image_id)
    db.commit()
    return out


@router.patch("/projects/{pid}/chat/{mid}", response_model=ChatMessage)
def edit_chat(mid: int, body: ChatPatch, access: Access, db: DB) -> dict:
    message = svc.get_chat_message(db, access.project.id, mid)
    out = svc.edit_chat(db, access, message, body.body)
    db.commit()
    return out


@router.delete("/projects/{pid}/chat/{mid}", status_code=204)
def delete_chat(mid: int, access: Access, db: DB) -> Response:
    message = svc.get_chat_message(db, access.project.id, mid)
    svc.delete_chat(db, access, message)
    db.commit()
    return Response(status_code=204)


@router.post("/projects/{pid}/chat/read", status_code=204)
def read_chat(body: ChatReadIn, access: Access, db: DB) -> Response:
    svc.mark_chat_read(db, access.project.id, access.user.id, body.last_id)
    db.commit()
    return Response(status_code=204)
