"""Fixes from the security audit: sessions, headers, sign-in admission, WebSocket abuse, access after removal,
archived projects and look-alike names."""

from __future__ import annotations

from datetime import timedelta

import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import CSRF, PASSWORD, box, images_of, login
from test_realtime import acquire, collect_until_pong, hello, receive_until, recv, subscribe

# ----------------------------------------------------------------------------------------------- sessions


def test_sessions_end_after_the_absolute_lifetime(app, admin):
    from annotamate.server.models import UserSession, utcnow

    ctx = app.state.ctx
    assert ctx.settings.session_max_days == 90
    with ctx.db.session() as session:
        row = session.query(UserSession).one()
        row.created_at = utcnow() - timedelta(days=89, hours=23)
        row.last_used_at = utcnow() - timedelta(days=1)  # due for a sliding refresh
        session.commit()
    assert admin.get("/api/me").status_code == 200
    with ctx.db.session() as session:
        row = session.query(UserSession).one()
        assert row.expires_at <= row.created_at + timedelta(days=90)  # the refresh did not extend past the cap
        row.expires_at = utcnow() - timedelta(seconds=1)
        session.commit()
    assert admin.get("/api/me").status_code == 401


def test_admins_change_their_own_password_only_with_the_current_one(admin, make_user):
    me = admin.get("/api/me").json()
    refused = admin.post(f"/api/users/{me['id']}/password", json={"new_password": "another-password"})
    assert refused.status_code == 400
    other = make_user("ann")
    assert admin.post(f"/api/users/{other.id}/password", json={"new_password": "another-password"}).status_code == 204


def test_a_demoted_admin_cannot_keep_changing_accounts(admin, make_user):
    second = make_user("root2", is_admin=True)
    assert admin.patch(f"/api/users/{second.id}", json={"is_admin": False}).status_code == 200
    assert second.patch(f"/api/users/{admin.id}", json={"is_admin": False}).status_code == 403
    assert admin.get("/api/me").json()["is_admin"] is True


# ------------------------------------------------------------------------------------------------ headers


def test_api_responses_are_not_cached_and_carry_isolation_headers(admin, create_project, dataset):
    me = admin.get("/api/me")
    assert me.headers["cache-control"] == "no-store"
    for name in ("cross-origin-opener-policy", "cross-origin-resource-policy", "permissions-policy"):
        assert name in me.headers
    assert "strict-transport-security" not in me.headers  # plain HTTP deployment
    project = create_project(dataset)
    image = images_of(admin, project["id"])[0]
    thumb = admin.get(f"/api/projects/{project['id']}/images/{image['id']}/thumb", params={"v": "1"})
    assert "no-store" not in thumb.headers["cache-control"]  # images keep their own caching


def test_hsts_is_sent_for_https_deployments(tmp_path, root):
    from fastapi.testclient import TestClient

    from annotamate.server import Settings, create_app

    app = create_app(Settings(data_dir=tmp_path / "d", roots=[str(root)], secure_cookies=True))
    response = TestClient(app, base_url="https://annotate.example").get("/api/auth/state")
    assert response.headers["strict-transport-security"] == "max-age=31536000"


def test_api_description_needs_a_signed_in_user(client, admin):
    client.cookies.clear()
    assert client.get("/api/openapi.json").status_code == 401
    schema = admin.get("/api/openapi.json")
    assert schema.status_code == 200 and "/api/auth/login" in schema.json()["paths"]


def test_password_routes_answer_busy_instead_of_queueing(settings, monkeypatch):
    from fastapi.testclient import TestClient

    from annotamate.server import create_app
    from annotamate.server.app import PasswordGate

    monkeypatch.setattr(PasswordGate, "LIMIT", 0)
    client = TestClient(create_app(settings))
    busy = client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD}, headers=CSRF)
    assert busy.status_code == 503 and busy.json()["code"] == "busy" and busy.headers["retry-after"]
    assert client.get("/api/auth/state").status_code == 200  # everything else is unaffected


def test_untrusted_forwarding_headers_are_reported_once(client, caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="annotamate.server"):
        for _ in range(3):
            client.get("/api/auth/state", headers={"X-Forwarded-For": "203.0.113.20"})
    assert caplog.text.count("FORWARDED_ALLOW_IPS") == 1


# ---------------------------------------------------------------------------------------------- websocket


def test_websocket_origin_ignores_forwarded_host_and_checks_the_scheme(admin, app):
    with pytest.raises(WebSocketDisconnect) as refused, admin.ws(origin="http://evil.example",
                                                                   **{"x-forwarded-host": "evil.example"}) as ws:
        ws.receive_json()
    assert refused.value.code == 1008
    with admin.ws(origin="http://testserver") as ws:
        hello(ws)
    app.state.ctx.settings.secure_cookies = True
    try:
        with pytest.raises(WebSocketDisconnect) as insecure, admin.ws(origin="http://testserver") as ws:
            ws.receive_json()
        assert insecure.value.code == 1008
    finally:
        app.state.ctx.settings.secure_cookies = False


def test_sockets_per_user_are_capped(admin, monkeypatch):
    from annotamate.server import realtime

    monkeypatch.setattr(realtime, "MAX_CONNECTIONS_PER_USER", 2)
    with admin.ws() as first, admin.ws() as second:
        hello(first)
        hello(second)
        with admin.ws() as third:
            assert recv(third)["code"] == "rate_limited"
            with pytest.raises(WebSocketDisconnect) as closed:
                recv(third)
            assert closed.value.code == 4429


def _drain(ws, limit: int = 500) -> None:
    for _ in range(limit):
        recv(ws)


def test_frame_flood_is_dropped_and_then_closed(admin, make_user):
    other = make_user("ann")
    with other.ws() as victim, admin.ws() as attacker:
        hello(victim)
        hello(attacker)
        for _ in range(400):
            attacker.send_json({"type": "typing", "scope": "dm", "user_id": other.id})
        assert receive_until(attacker, "error", lambda m: m["code"] == "rate_limited")["code"] == "rate_limited"
        with pytest.raises(WebSocketDisconnect) as closed:
            _drain(attacker)
        assert closed.value.code == 1008
        # the victim got one typing notice (throttled), stayed connected and still answers
        seen = collect_until_pong(victim)
        assert [m["type"] for m in seen if m["type"] == "typing"] == ["typing"]


def test_bad_frames_do_not_cause_internal_errors(admin):
    with admin.ws() as ws:
        hello(ws)
        ws.send_json({"type": "subscribe", "project_id": 10**40})
        assert recv(ws)["code"] == "not_found"
        ws.send_text("[" * 60000)
        assert recv(ws)["code"] == "bad_request"
        assert collect_until_pong(ws) == []


def test_lock_is_revoked_when_the_image_is_reassigned(admin, make_user, create_project, dataset):
    ann = make_user("ann")
    bob = make_user("bob")
    project = create_project(dataset, members=[(ann, "annotator"), (bob, "annotator")],
                             settings={"restrict_to_assigned": True})
    pid = project["id"]
    image = images_of(admin, pid)[0]["id"]
    with ann.ws() as ws:
        hello(ws)
        subscribe(ws, pid)
        assert acquire(ws, image)["type"] == "lock.granted"
        assert admin.patch(f"/api/projects/{pid}/images/{image}", json={"assignee_id": bob.id}).status_code == 200
        seen = collect_until_pong(ws)
        revoked = [m for m in seen if m["type"] == "lock.revoked"]
        assert revoked and revoked[0]["by"] is None and "assigned" in revoked[0]["reason"]
    saved = bob.put(f"/api/projects/{pid}/images/{image}/annotation",
                    json={"base_version": None, "boxes": [box(project["classes"][0]["id"] if project["classes"]
                                                              else None, 5, 5, 20, 20)]})
    assert saved.status_code != 423  # nobody holds the lock any more


def test_one_user_holds_at_most_three_locks(admin, create_project, dataset, root):
    from conftest import make_image

    for n in range(3, 6):
        make_image(dataset / f"img{n}x.jpg")
    project = create_project(dataset)
    pid = project["id"]
    ids = [i["id"] for i in images_of(admin, pid)][:4]
    sockets = [admin.ws() for _ in range(4)]
    opened = [s.__enter__() for s in sockets]
    try:
        for ws in opened:
            hello(ws)
            subscribe(ws, pid)
        for ws, image_id in zip(opened[:3], ids[:3], strict=True):
            assert acquire(ws, image_id)["type"] == "lock.granted"
        assert acquire(opened[3], ids[3])["type"] == "lock.granted"
        revoked = receive_until(opened[0], "lock.revoked")
        assert revoked["image_id"] == ids[0]  # the oldest lock was let go
    finally:
        for s in reversed(sockets):
            s.__exit__(None, None, None)


# ----------------------------------------------------------------------------------------------- access


def test_removed_members_get_no_review_results_or_project_links(app, admin, make_user, create_project, dataset):
    ann = make_user("ann")
    project = create_project(dataset, members=[(ann, "annotator")], settings={"require_review": True})
    pid = project["id"]
    image = images_of(admin, pid)[0]["id"]
    assert ann.post(f"/api/projects/{pid}/images/{image}/comments", json={"body": "hello @admin"}).status_code == 200
    assert ann.post(f"/api/projects/{pid}/images/{image}/status", json={"action": "submit"}).status_code == 200
    admin.post(f"/api/projects/{pid}/images/{image}/comments", json={"body": "@ann thanks"})
    assert admin.delete(f"/api/projects/{pid}/members/{ann.id}").status_code == 204
    admin.patch(f"/api/projects/{pid}", json={"name": "Renamed secret"})
    assert admin.post(f"/api/projects/{pid}/images/{image}/status",
                      json={"action": "reject", "comment": "confidential reason"}).status_code == 200
    items = ann.get("/api/notifications").json()["items"]
    assert not any("confidential" in n["text"] for n in items)
    assert all(n["project"] is None and n["image"] is None for n in items if n["type"] == "mention")


def test_archived_projects_are_read_only(admin, make_user, create_project, dataset):
    ann = make_user("ann")
    project = create_project(dataset, classes=["cat"], members=[(ann, "annotator")])
    pid, cat = project["id"], project["classes"][0]["id"]
    image = images_of(admin, pid)[0]["id"]
    assert admin.patch(f"/api/projects/{pid}", json={"archived": True}).status_code == 200
    detail = ann.get(f"/api/projects/{pid}").json()
    assert detail["permissions"]["can_edit"] is False
    put = ann.put(f"/api/projects/{pid}/images/{image}/annotation",
                  json={"base_version": None, "boxes": [box(cat, 5, 5, 20, 20)]})
    assert put.status_code == 403 and "archived" in put.json()["detail"]
    assert admin.post(f"/api/projects/{pid}/classes", json={"name": "dog"}).status_code == 403
    assert admin.delete(f"/api/projects/{pid}/classes/{cat}", params={"strategy": "delete_boxes"}).status_code == 403
    assert admin.post(f"/api/projects/{pid}/images/bulk",
                      json={"image_ids": [image], "action": "flag"}).status_code == 403
    assert ann.post(f"/api/projects/{pid}/chat", json={"body": "still talking"}).status_code == 200
    assert admin.patch(f"/api/projects/{pid}", json={"archived": False}).status_code == 200
    assert ann.put(f"/api/projects/{pid}/images/{image}/annotation",
                   json={"base_version": None, "boxes": [box(cat, 5, 5, 20, 20)]}).status_code == 200


def test_deactivated_managers_do_not_count_as_the_last_manager(admin, make_user, create_project, dataset):
    one = make_user("mgr1")
    two = make_user("mgr2")
    project = create_project(dataset, members=[(one, "manager"), (two, "manager")])
    pid = project["id"]
    assert admin.delete(f"/api/projects/{pid}/members/{admin.id}").status_code == 204  # admins act as managers anyway
    assert admin.patch(f"/api/users/{two.id}", json={"is_active": False}).status_code == 200
    assert one.delete(f"/api/projects/{pid}/members/{one.id}").status_code == 400


def test_restricted_annotators_cannot_resolve_comments_on_others_images(admin, make_user, create_project, dataset):
    ann = make_user("ann")
    bob = make_user("bob")
    project = create_project(dataset, members=[(ann, "annotator"), (bob, "annotator")],
                             settings={"restrict_to_assigned": True})
    pid = project["id"]
    image = images_of(admin, pid)[0]["id"]
    admin.patch(f"/api/projects/{pid}/images/{image}", json={"assignee_id": bob.id})
    comment = admin.post(f"/api/projects/{pid}/images/{image}/comments", json={"body": "fix this"}).json()
    assert ann.patch(f"/api/projects/{pid}/comments/{comment['id']}", json={"resolved": True}).status_code == 403
    assert bob.patch(f"/api/projects/{pid}/comments/{comment['id']}", json={"resolved": True}).status_code == 200


# ------------------------------------------------------------------------------------------------- names


def test_invisible_characters_are_removed_from_names(admin, make_user, create_project, dataset):
    ann = make_user("ann")
    assert ann.patch("/api/me", json={"display_name": "Ada​‮"}).json()["display_name"] == "Ada"
    project = create_project(dataset, name="Cars‮")
    assert project["name"] == "Cars"
    refused = admin.post(f"/api/projects/{project['id']}/classes", json={"name": "car‮"})
    assert refused.status_code == 400


def test_login_of_a_deactivated_user_with_the_right_password_counts_as_an_attempt(client, admin, make_user):
    make_user("ann")
    target = admin.get("/api/users").json()
    ann_id = next(u["id"] for u in target if u["username"] == "ann")
    admin.patch(f"/api/users/{ann_id}", json={"is_active": False})
    client.cookies.clear()
    statuses = {client.post("/api/auth/login", json={"username": "ann", "password": PASSWORD},
                            headers=CSRF).status_code for _ in range(11)}
    assert statuses == {403, 429}
    assert login  # imported helper stays available for other tests
