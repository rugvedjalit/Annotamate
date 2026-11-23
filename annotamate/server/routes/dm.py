"""Direct messages."""

from typing import Annotated

from fastapi import APIRouter, Query, Response

from annotamate.server.deps import DB, CurrentUser
from annotamate.server.models import DirectMessage as DmRow
from annotamate.server.schemas import Conversation, DirectMessage, DirectMessageCreate, DirectMessagePage
from annotamate.server.services import messages as svc
from annotamate.server.services import serialize

router = APIRouter(tags=["dm"])


@router.get("/dm", response_model=list[Conversation])
def conversations(user: CurrentUser, db: DB) -> list[dict]:
    return svc.conversations(db, user)


@router.get("/dm/{user_id}", response_model=DirectMessagePage)
def thread(user_id: int, user: CurrentUser, db: DB, before_id: int | None = None,
           limit: Annotated[int, Query(ge=1, le=200)] = 50) -> dict:
    other = svc.get_other_user(db, user_id)
    rows, has_more = svc.page(svc.thread_query(user, other), DmRow.id, before_id, limit, db)
    return {"items": [serialize.direct_message(m) for m in rows], "has_more": has_more}


@router.post("/dm/{user_id}", response_model=DirectMessage)
def send(user_id: int, body: DirectMessageCreate, user: CurrentUser, db: DB) -> dict:
    other = svc.get_other_user(db, user_id)
    out = svc.send_dm(db, user, other, body.body)
    db.commit()
    return out


@router.post("/dm/{user_id}/read", status_code=204)
def read(user_id: int, user: CurrentUser, db: DB) -> Response:
    other = svc.get_other_user(db, user_id)
    svc.mark_dm_read(db, user, other)
    db.commit()
    return Response(status_code=204)
