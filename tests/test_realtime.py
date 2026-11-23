"""WebSocket hub: presence, edit locks, typing and server-pushed events (docs/api.md, WebSocket section)."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import anyio
import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import ApiUser, images_of, make_image, wait_idle

Message = dict[str, Any]


def recv(ws, timeout: float = 5.0) -> Message:
    """Next server frame as JSON; fails instead of hanging when nothing arrives within ``timeout``."""

    async def _get() -> Message:
        with anyio.fail_after(timeout):
            return await ws._send_rx.receive()

    message = ws.portal.call(_get)
    ws._raise_on_close(message)
    return json.loads(message["text"])


def receive_until(ws, type_: str, predicate: Callable[[Message], bool] | None = None, max_messages: int = 30,
                  timeout: float = 5.0) -> Message:
    """Skip unrelated frames until one of ``type_`` (matching ``predicate``) arrives."""
    for _ in range(max_messages):
        message = recv(ws, timeout)
        if message["type"] == type_ and (predicate is None or predicate(message)):
            return message
    raise AssertionError(f"no {type_!r} message within {max_messages} frames")


def collect_until_pong(ws) -> list[Message]:
    """Send a ping and return every frame received before the pong (frames are delivered in order)."""
    ws.send_json({"type": "ping"})
    seen: list[Message] = []
    for _ in range(50):
        message = recv(ws)
        if message["type"] == "pong":
            return seen
        seen.append(message)
    raise AssertionError("no pong")


def hello(ws) -> Message:
    message = recv(ws)
    assert message["type"] == "hello"
    return message


def subscribe(ws, project_id: int) -> Message:
    ws.send_json({"type": "subscribe", "project_id": project_id})
    return receive_until(ws, "presence.snapshot")


def acquire(ws, image_id: int, force: bool = False) -> Message:
    """Request a lock and return the answer: ``lock.granted``, ``lock.denied`` or ``error``."""
    ws.send_json({"type": "lock.acquire", "image_id": image_id, "force": force})
    for _ in range(30):
        message = recv(ws)
        if message["type"] in ("lock.granted", "lock.denied", "error"):
            return message
    raise AssertionError("no answer to lock.acquire")


def holder_is(user: ApiUser | None) -> Callable[[Message], bool]:
    if user is None:
        return lambda m: m["holder"] is None
    return lambda m: m["holder"] is not None and m["holder"]["id"] == user.id


def put_annotation(user: ApiUser, project_id: int, image_id: int, boxes: list | None = None,
                   base_version: str | None = None):
    return user.put(f"/api/projects/{project_id}/images/{image_id}/annotation",
                    json={"base_version": base_version, "boxes": boxes or []})


@pytest.fixture
def team(admin, make_user, create_project, dataset):
    alice = make_user("alice", "Alice")
    bob = make_user("bob", "Bob")
    vera = make_user("vera", "Vera")
    max_ = make_user("max", "Max")
    olga = make_user("olga", "Olga")
    project = create_project(dataset, classes=["cat"], members=[
        (alice, "annotator"), (bob, "annotator"), (vera, "viewer"), (max_, "manager")])
    image_ids = [item["id"] for item in images_of(admin, project["id"])]
    return SimpleNamespace(admin=admin, alice=alice, bob=bob, viewer=vera, manager=max_, outsider=olga,
                           project=project, pid=project["id"], images=image_ids)


# ------------------------------------------------------------------------------------------- connection


def test_hello_online_and_offline(client, admin, make_user):
    bob = make_user("bob", "Bob")
    with admin.ws() as wa:
        first = hello(wa)
        assert first["user_id"] == admin.id
        assert admin.id in first["online_user_ids"]
        with bob.ws() as wb:
            second = hello(wb)
            assert {admin.id, bob.id} <= set(second["online_user_ids"])
            assert receive_until(wa, "user.online")["user_id"] == bob.id
            users = {u["id"]: u for u in admin.get("/api/users").json()}
            assert users[bob.id]["online"] is True
            assert users[admin.id]["online"] is True
        assert receive_until(wa, "user.offline")["user_id"] == bob.id
        users = {u["id"]: u for u in admin.get("/api/users").json()}
        assert users[bob.id]["online"] is False


def test_second_tab_does_not_announce_again(client, admin, make_user):
    bob = make_user("bob", "Bob")
    with admin.ws() as wa, bob.ws() as wb1:
        hello(wa)
        hello(wb1)
        receive_until(wa, "user.online")
        with bob.ws() as wb2:
            hello(wb2)
            assert not any(m["type"] == "user.online" for m in collect_until_pong(wa))
        # Bob still has a tab open: no offline event for the first tab closing
        assert not any(m["type"] == "user.offline" for m in collect_until_pong(wa))


def test_origin_must_match_host(client, admin):
    with pytest.raises(WebSocketDisconnect), admin.ws(origin="http://evil.example"):
        pass
    with admin.ws(origin="http://testserver") as ws:
        assert hello(ws)["user_id"] == admin.id


def test_unauthenticated_socket_gets_error_then_close(client, admin):
    client.cookies.clear()
    with client.websocket_connect("/api/ws") as ws:
        message = recv(ws)
        assert message == {"type": "error", "code": "unauthenticated", "detail": message["detail"]}
        with pytest.raises(WebSocketDisconnect) as exc:
            recv(ws)
        assert exc.value.code == 4401
    with client.websocket_connect("/api/ws", headers={"cookie": "annotamate_session=bogus"}) as ws:
        assert recv(ws)["code"] == "unauthenticated"


def test_malformed_frames_and_unknown_types(client, admin):
    with admin.ws() as ws:
        hello(ws)
        ws.send_text("{not json")
        error = recv(ws)
        assert error["type"] == "error"
        assert error["code"] == "bad_request"
        ws.send_json({"type": "something.new", "x": 1})
        assert collect_until_pong(ws) == []


def test_logout_closes_that_sessions_sockets(client, team):
    with team.alice.ws() as ws:
        hello(ws)
        assert team.alice.post("/api/auth/logout").status_code == 204
        with pytest.raises(WebSocketDisconnect) as exc:
            receive_until(ws, "never-sent")
        assert exc.value.code == 4401


# ------------------------------------------------------------------------------------------- presence


def test_presence_snapshot_updates_and_leave(client, team):
    with team.alice.ws() as w1, team.bob.ws() as w2:
        hello(w1)
        hello(w2)
        snap = subscribe(w1, team.pid)
        assert snap["project_id"] == team.pid
        assert [u["user"]["id"] for u in snap["users"]] == [team.alice.id]
        snap2 = subscribe(w2, team.pid)
        assert {u["user"]["id"] for u in snap2["users"]} == {team.alice.id, team.bob.id}
        joined = receive_until(w1, "presence.update")
        assert joined["user"]["id"] == team.bob.id
        assert joined["project_id"] == team.pid
        assert joined["image_id"] is None
        assert "left" not in joined

        w2.send_json({"type": "presence", "image_id": team.images[0]})
        moved = receive_until(w1, "presence.update")
        assert (moved["user"]["id"], moved["image_id"]) == (team.bob.id, team.images[0])
        filename = {i["id"]: i["filename"] for i in images_of(team.admin, team.pid)}[team.images[0]]
        assert moved["image_filename"] == filename

        # An image of another project (or an unknown id) is not shown: the user is just "in the project".
        w2.send_json({"type": "presence", "image_id": 987654})
        nowhere = receive_until(w1, "presence.update")
        assert (nowhere["image_id"], nowhere["image_filename"]) == (None, None)

        w2.send_json({"type": "unsubscribe"})
        left = receive_until(w1, "presence.update")
        assert left["user"]["id"] == team.bob.id
        assert left["left"] is True


def test_presence_snapshot_shows_current_images(client, team):
    with team.alice.ws() as w1, team.bob.ws() as w2:
        hello(w1)
        hello(w2)
        subscribe(w1, team.pid)
        w1.send_json({"type": "presence", "image_id": team.images[1]})
        snap = subscribe(w2, team.pid)
        images = {u["user"]["id"]: u["image_id"] for u in snap["users"]}
        assert images == {team.alice.id: team.images[1], team.bob.id: None}
        names = {i["id"]: i["filename"] for i in images_of(team.admin, team.pid)}
        assert {u["user"]["id"]: u["image_filename"] for u in snap["users"]} == {
            team.alice.id: names[team.images[1]], team.bob.id: None}


def test_disconnect_announces_leave(client, team):
    with team.alice.ws() as w1:
        hello(w1)
        subscribe(w1, team.pid)
        with team.bob.ws() as w2:
            hello(w2)
            subscribe(w2, team.pid)
            receive_until(w1, "presence.update")
        left = receive_until(w1, "presence.update")
        assert left["user"]["id"] == team.bob.id
        assert left["left"] is True


def test_subscribe_requires_membership(client, team):
    with team.outsider.ws() as ws:
        hello(ws)
        ws.send_json({"type": "subscribe", "project_id": team.pid})
        error = receive_until(ws, "error")
        assert error["code"] == "not_found"
        ws.send_json({"type": "subscribe", "project_id": 9999})
        assert receive_until(ws, "error")["code"] == "not_found"


# ------------------------------------------------------------------------------------------- locks


def test_lock_grant_deny_and_http_423(client, team):
    image = team.images[0]
    with team.alice.ws() as w1, team.bob.ws() as w2:
        hello(w1)
        hello(w2)
        subscribe(w1, team.pid)
        subscribe(w2, team.pid)

        granted = acquire(w1, image)
        assert granted == {"type": "lock.granted", "image_id": image}
        state = receive_until(w2, "lock.state")
        assert state["project_id"] == team.pid
        assert state["image_id"] == image
        assert state["holder"]["id"] == team.alice.id

        denied = acquire(w2, image)
        assert denied["type"] == "lock.denied"
        assert denied["holder"]["id"] == team.alice.id
        assert acquire(w2, image, force=True)["type"] == "lock.denied"  # annotators cannot take over

        response = put_annotation(team.bob, team.pid, image)
        assert response.status_code == 423
        body = response.json()
        assert body["code"] == "locked"
        assert body["holder"]["id"] == team.alice.id
        assert set(body["holder"]) == {"id", "username", "display_name", "avatar_color"}

        assert put_annotation(team.alice, team.pid, image).status_code == 200


def test_manager_takes_over_lock(client, team):
    image = team.images[0]
    with team.alice.ws() as w1, team.manager.ws() as wm:
        hello(w1)
        hello(wm)
        subscribe(w1, team.pid)
        subscribe(wm, team.pid)
        assert acquire(w1, image)["type"] == "lock.granted"
        assert acquire(wm, image)["type"] == "lock.denied"

        assert acquire(wm, image, force=True) == {"type": "lock.granted", "image_id": image}
        revoked = receive_until(w1, "lock.revoked")
        assert revoked["image_id"] == image
        assert revoked["by"]["id"] == team.manager.id
        state = receive_until(w1, "lock.state", holder_is(team.manager))
        assert state["image_id"] == image
        assert team.admin.client.app.state.ctx.hub.lock_holder(image)[0] == team.manager.id
        assert put_annotation(team.alice, team.pid, image).status_code == 423


def test_admin_can_force_as_well(client, team):
    image = team.images[1]
    with team.alice.ws() as w1, team.admin.ws() as wa:
        hello(w1)
        hello(wa)
        subscribe(w1, team.pid)
        subscribe(wa, team.pid)
        acquire(w1, image)
        assert acquire(wa, image, force=True)["type"] == "lock.granted"
        assert receive_until(w1, "lock.revoked")["by"]["id"] == team.admin.id


def test_release_and_disconnect_free_the_lock(client, team):
    first, second = team.images[0], team.images[1]
    with team.bob.ws() as w2:
        hello(w2)
        subscribe(w2, team.pid)
        with team.alice.ws() as w1:
            hello(w1)
            subscribe(w1, team.pid)
            acquire(w1, first)
            receive_until(w2, "lock.state", holder_is(team.alice))
            w1.send_json({"type": "lock.release", "image_id": first})
            released = receive_until(w2, "lock.state", holder_is(None))
            assert released["image_id"] == first
            assert acquire(w2, first)["type"] == "lock.granted"  # free again

            acquire(w1, second)
            receive_until(w2, "lock.state", lambda m: m["image_id"] == second and m["holder"] is not None)
        gone = receive_until(w2, "lock.state", lambda m: m["image_id"] == second)
        assert gone["holder"] is None
        assert put_annotation(team.bob, team.pid, second).status_code == 200


def test_release_of_someone_elses_lock_is_ignored(client, team):
    image = team.images[0]
    with team.alice.ws() as w1, team.bob.ws() as w2:
        hello(w1)
        hello(w2)
        subscribe(w1, team.pid)
        subscribe(w2, team.pid)
        acquire(w1, image)
        w2.send_json({"type": "lock.release", "image_id": image})
        assert not any(m["type"] == "lock.state" and m["holder"] is None for m in collect_until_pong(w2))
        assert team.admin.client.app.state.ctx.hub.lock_holder(image)[0] == team.alice.id


def test_unsubscribe_releases_locks(client, team):
    image = team.images[2]
    with team.alice.ws() as w1, team.bob.ws() as w2:
        hello(w1)
        hello(w2)
        subscribe(w1, team.pid)
        subscribe(w2, team.pid)
        acquire(w1, image)
        receive_until(w2, "lock.state", holder_is(team.alice))
        w1.send_json({"type": "unsubscribe"})
        assert receive_until(w2, "lock.state", holder_is(None))["image_id"] == image


def test_viewers_and_unsubscribed_sockets_cannot_lock(client, team):
    with team.viewer.ws() as wv:
        hello(wv)
        error = acquire(wv, team.images[0])
        assert (error["type"], error["code"]) == ("error", "forbidden")  # not subscribed yet
        subscribe(wv, team.pid)
        error = acquire(wv, team.images[0])
        assert (error["type"], error["code"]) == ("error", "forbidden")
        wv.send_json({"type": "lock.acquire"})
        assert receive_until(wv, "error")["code"] == "bad_request"


def test_image_of_another_project_cannot_be_locked(client, team, root, create_project):
    make_image(root / "other" / "x.png")
    other = create_project(root / "other", name="Other")
    other_image = images_of(team.admin, other["id"])[0]["id"]
    with team.alice.ws() as w1:
        hello(w1)
        subscribe(w1, team.pid)
        error = acquire(w1, other_image)
        assert (error["type"], error["code"]) == ("error", "not_found")
        error = acquire(w1, 999_999)
        assert error["code"] == "not_found"


def test_joining_a_room_reports_existing_locks(client, team):
    image = team.images[1]
    with team.alice.ws() as w1:
        hello(w1)
        subscribe(w1, team.pid)
        acquire(w1, image)
        with team.bob.ws() as w2:
            hello(w2)
            subscribe(w2, team.pid)
            state = receive_until(w2, "lock.state")
            assert state["image_id"] == image
            assert state["holder"]["id"] == team.alice.id


def test_ping_renews_and_expired_locks_are_ignored(client, team):
    hub = team.admin.client.app.state.ctx.hub
    image = team.images[2]
    with team.alice.ws() as w1, team.bob.ws() as w2:
        hello(w1)
        hello(w2)
        subscribe(w1, team.pid)
        subscribe(w2, team.pid)
        acquire(w1, image)
        receive_until(w2, "lock.state", holder_is(team.alice))

        with hub._mutex:
            hub._locks[image].expires_at = time.monotonic() + 1
        w1.send_json({"type": "ping"})
        receive_until(w1, "pong")
        with hub._mutex:
            assert hub._locks[image].expires_at > time.monotonic() + 30

        with hub._mutex:
            hub._locks[image].expires_at = time.monotonic() - 1
        assert hub.lock_holder(image) is None
        assert put_annotation(team.bob, team.pid, image).status_code == 200  # an expired lock does not block saves

        hub.loop.call_soon_threadsafe(hub.sweep)
        swept = receive_until(w2, "lock.state", holder_is(None))
        assert swept["image_id"] == image
        with hub._mutex:
            assert image not in hub._locks


def test_expired_lock_can_be_acquired_by_someone_else(client, team):
    hub = team.admin.client.app.state.ctx.hub
    image = team.images[0]
    with team.alice.ws() as w1, team.bob.ws() as w2:
        hello(w1)
        hello(w2)
        subscribe(w1, team.pid)
        subscribe(w2, team.pid)
        acquire(w1, image)
        with hub._mutex:
            hub._locks[image].expires_at = time.monotonic() - 1
        assert acquire(w2, image)["type"] == "lock.granted"
        assert receive_until(w1, "lock.state", holder_is(team.bob))["image_id"] == image


# ------------------------------------------------------------------------------------------- typing


def test_typing_in_chat_and_dm(client, team):
    with team.alice.ws() as w1, team.bob.ws() as w2, team.outsider.ws() as wo:
        for ws in (w1, w2, wo):
            hello(ws)
        subscribe(w1, team.pid)
        subscribe(w2, team.pid)
        w1.send_json({"type": "typing", "scope": "chat"})
        typing = receive_until(w2, "typing")
        assert typing == {"type": "typing", "scope": "chat", "project_id": team.pid, "user": typing["user"]}
        assert typing["user"]["id"] == team.alice.id
        assert not any(m["type"] == "typing" for m in collect_until_pong(w1))  # not echoed to the sender
        assert not any(m["type"] == "typing" for m in collect_until_pong(wo))  # outsider is not in the room

        w1.send_json({"type": "typing", "scope": "dm", "user_id": team.outsider.id})
        dm = receive_until(wo, "typing")
        assert dm["scope"] == "dm"
        assert dm["user"]["id"] == team.alice.id
        assert "project_id" not in dm
        assert not any(m["type"] == "typing" for m in collect_until_pong(w2))


# ------------------------------------------------------------------------------------------- server events


def test_chat_and_annotation_events_reach_the_room(client, team):
    class_id = team.project["classes"][0]["id"]
    image = team.images[0]
    with team.alice.ws() as w1, team.bob.ws() as w2, team.outsider.ws() as wo:
        for ws in (w1, w2, wo):
            hello(ws)
        subscribe(w1, team.pid)
        subscribe(w2, team.pid)

        posted = team.bob.post(f"/api/projects/{team.pid}/chat", json={"body": "hello team"}).json()
        message = receive_until(w1, "chat.message")["message"]
        assert message["id"] == posted["id"]
        assert message["body"] == "hello team"
        assert message["user"]["id"] == team.bob.id
        assert receive_until(w2, "chat.message")["message"]["id"] == posted["id"]

        edited = team.bob.patch(f"/api/projects/{team.pid}/chat/{posted['id']}", json={"body": "hello all"})
        assert edited.status_code == 200
        assert receive_until(w1, "chat.updated")["message"]["body"] == "hello all"

        saved = put_annotation(team.alice, team.pid, image,
                               [{"id": "b1", "class_id": class_id, "raw_label": None,
                                 "x1": 10, "y1": 10, "x2": 40, "y2": 30}])
        assert saved.status_code == 200, saved.text
        update = receive_until(w2, "image.updated")
        assert update["project_id"] == team.pid
        assert update["image"]["id"] == image
        assert update["image"]["box_count"] == 1
        assert update["version"] == saved.json()["version"]
        assert update["by"]["id"] == team.alice.id
        assert not any(m["type"] in ("chat.message", "image.updated") for m in collect_until_pong(wo))


def test_dm_and_notification_events(client, team):
    with team.alice.ws() as tab1, team.alice.ws() as tab2, team.bob.ws() as wb:
        for ws in (tab1, tab2, wb):
            hello(ws)
        sent = team.bob.post(f"/api/dm/{team.alice.id}", json={"body": "hi there"})
        assert sent.status_code == 200, sent.text
        for ws in (tab1, tab2, wb):  # recipient's tabs and the sender's socket
            message = receive_until(ws, "dm.message")["message"]
            assert message["id"] == sent.json()["id"]
            assert (message["sender_id"], message["recipient_id"]) == (team.bob.id, team.alice.id)
        note = receive_until(tab1, "notification")
        assert note["notification"]["type"] == "dm"
        assert note["notification"]["actor"]["id"] == team.bob.id
        before = team.alice.get("/api/notifications").json()["unread_count"]
        assert note["unread_count"] == before  # includes the earlier project_added notification
        assert not any(m["type"] == "notification" for m in collect_until_pong(wb))  # nothing for the sender

        team.bob.post(f"/api/projects/{team.pid}/chat", json={"body": "@alice please check img2"})
        mention = receive_until(tab2, "notification", lambda m: m["notification"]["type"] == "mention")
        assert mention["notification"]["project"] == {"id": team.pid, "name": team.project["name"]}
        listed = team.alice.get("/api/notifications").json()
        assert mention["unread_count"] == listed["unread_count"] == before + 1


def test_dm_read_receipt_event(client, team):
    """Reading a conversation tells the sender (read receipt) and the reader's tabs (badges) live."""
    with team.alice.ws() as reader, team.bob.ws() as sender:
        hello(reader)
        hello(sender)
        sent = team.bob.post(f"/api/dm/{team.alice.id}", json={"body": "ping"})
        assert sent.status_code == 200, sent.text
        receive_until(reader, "notification")
        assert team.alice.post(f"/api/dm/{team.bob.id}/read").status_code == 204

        receipt = receive_until(sender, "dm.read")
        assert (receipt["reader_id"], receipt["sender_id"]) == (team.alice.id, team.bob.id)
        assert receipt["read_at"].endswith("Z")
        assert "unread_count" not in receipt
        thread = team.bob.get(f"/api/dm/{team.alice.id}").json()["items"]
        assert thread[-1]["read_at"] == receipt["read_at"]

        own = receive_until(reader, "dm.read")
        assert (own["reader_id"], own["sender_id"]) == (team.alice.id, team.bob.id)
        assert own["unread_count"] == team.alice.get("/api/notifications").json()["unread_count"]

        # Nothing left to read: no event at all.
        assert team.alice.post(f"/api/dm/{team.bob.id}/read").status_code == 204
        assert not any(m["type"] == "dm.read" for m in collect_until_pong(sender))
        assert not any(m["type"] == "dm.read" for m in collect_until_pong(reader))


def test_classes_updated_event(client, team):
    with team.alice.ws() as ws:
        hello(ws)
        subscribe(ws, team.pid)
        response = team.manager.post(f"/api/projects/{team.pid}/classes", json={"name": "dog"})
        assert response.status_code == 200, response.text
        event = receive_until(ws, "classes.updated")
        assert event["project_id"] == team.pid
        assert [c["name"] for c in event["classes"]] == ["cat", "dog"]
        assert [c["index"] for c in event["classes"]] == [0, 1]


def test_rescan_reports_indexing_progress(client, app, team):
    with team.admin.ws() as ws:
        hello(ws)
        subscribe(ws, team.pid)
        response = team.admin.post(f"/api/projects/{team.pid}/rescan")
        assert response.status_code == 202
        assert response.json() == {"started": True}
        finished = receive_until(ws, "project.indexing", lambda m: m["finished"], max_messages=50, timeout=30)
        assert finished["project_id"] == team.pid
        assert finished["done"] == finished["total"] == 3
        assert receive_until(ws, "images.bulk_updated")["project_id"] == team.pid
        wait_idle(app)


def test_member_events_and_bulk_updates(client, team):
    with team.alice.ws() as ws:
        hello(ws)
        subscribe(ws, team.pid)
        response = team.manager.patch(f"/api/projects/{team.pid}/members/{team.viewer.id}", json={"role": "annotator"})
        assert response.status_code == 200, response.text
        assert receive_until(ws, "members.updated")["project_id"] == team.pid
        bulk = team.manager.post(f"/api/projects/{team.pid}/images/bulk",
                                 json={"image_ids": team.images[:2], "action": "flag"})
        assert bulk.json() == {"updated": 2}
        event = receive_until(ws, "images.bulk_updated")
        assert event == {"type": "images.bulk_updated", "project_id": team.pid, "count": 2}
        team.manager.patch(f"/api/projects/{team.pid}", json={"description": "new"})
        assert receive_until(ws, "project.updated")["project_id"] == team.pid
