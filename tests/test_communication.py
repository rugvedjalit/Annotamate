"""Project chat, image comments, direct messages, @mentions, notifications and the activity feed."""

from __future__ import annotations

import pytest

from conftest import images_of


@pytest.fixture
def team(admin, make_user, create_project, dataset):
    bob = make_user("bob", "Bob")
    carol = make_user("carol", "Carol")
    viewer = make_user("vic", "Vic")
    outsider = make_user("olga", "Olga")
    project = create_project(dataset, classes=["cat"],
                             members=[(bob, "annotator"), (carol, "reviewer"), (viewer, "viewer")])
    for user in (bob, carol, viewer):
        assert user.get("/api/notifications").json()["items"][0]["type"] == "project_added"
        user.post("/api/notifications/read", json={"all": True})
    return project, bob, carol, viewer, outsider


def test_chat_flow(team, admin):
    project, bob, carol, viewer, _ = team
    pid = project["id"]
    image = images_of(admin, pid)[0]
    first = bob.post(f"/api/projects/{pid}/chat", json={"body": "  hello team  "})
    assert first.status_code == 200
    msg = first.json()
    assert msg["body"] == "hello team" and msg["user"]["id"] == bob.id and msg["image"] is None
    assert msg["deleted"] is False and msg["edited_at"] is None and msg["mentions"] == []
    shared = carol.post(f"/api/projects/{pid}/chat", json={"body": "look", "image_id": image["id"]}).json()
    assert shared["image"] == {"id": image["id"], "filename": image["filename"]}
    assert carol.post(f"/api/projects/{pid}/chat", json={"body": "x", "image_id": 9999}).status_code == 400
    assert carol.post(f"/api/projects/{pid}/chat", json={"body": ""}).status_code == 422
    assert carol.post(f"/api/projects/{pid}/chat", json={"body": "x" * 4001}).status_code == 422

    edited = bob.patch(f"/api/projects/{pid}/chat/{msg['id']}", json={"body": "hello everyone"}).json()
    assert edited["body"] == "hello everyone" and edited["edited_at"] is not None
    assert carol.patch(f"/api/projects/{pid}/chat/{msg['id']}", json={"body": "hijack"}).status_code == 403
    assert viewer.delete(f"/api/projects/{pid}/chat/{msg['id']}").status_code == 403
    assert admin.delete(f"/api/projects/{pid}/chat/{msg['id']}").status_code == 204  # managers may delete any
    page = viewer.get(f"/api/projects/{pid}/chat").json()
    assert [m["id"] for m in page["items"]] == [msg["id"], shared["id"]] and page["has_more"] is False
    assert page["items"][0]["deleted"] is True and page["items"][0]["body"] == ""
    assert bob.patch(f"/api/projects/{pid}/chat/{msg['id']}", json={"body": "again"}).status_code == 404
    assert bob.delete(f"/api/projects/{pid}/chat/{shared['id']}").status_code == 403
    assert carol.delete(f"/api/projects/{pid}/chat/{shared['id']}").status_code == 204


def test_chat_pagination_and_unread(team, admin):
    project, bob, carol, _, _ = team
    pid = project["id"]
    ids = [bob.post(f"/api/projects/{pid}/chat", json={"body": f"m{n}"}).json()["id"] for n in range(7)]
    latest = carol.get(f"/api/projects/{pid}/chat", params={"limit": 3}).json()
    assert [m["id"] for m in latest["items"]] == ids[-3:] and latest["has_more"] is True
    older = carol.get(f"/api/projects/{pid}/chat", params={"limit": 3, "before_id": ids[-3]}).json()
    assert [m["id"] for m in older["items"]] == ids[1:4]
    oldest = carol.get(f"/api/projects/{pid}/chat", params={"limit": 3, "before_id": ids[1]}).json()
    assert [m["id"] for m in oldest["items"]] == ids[:1] and oldest["has_more"] is False

    def unread(user):
        return next(p["unread_chat"] for p in user.get("/api/projects").json() if p["id"] == pid)

    assert unread(carol) == 7 and unread(bob) == 0 and unread(admin) == 7
    assert carol.post(f"/api/projects/{pid}/chat/read", json={"last_id": ids[3]}).status_code == 204
    assert unread(carol) == 3
    carol.post(f"/api/projects/{pid}/chat/read", json={"last_id": ids[1]})  # never moves backwards
    assert unread(carol) == 3
    carol.post(f"/api/projects/{pid}/chat/read", json={"last_id": ids[-1]})
    assert unread(carol) == 0


def test_chat_mentions_notify(team, admin):
    project, bob, carol, viewer, outsider = team
    pid = project["id"]
    msg = bob.post(f"/api/projects/{pid}/chat",
                   json={"body": "@carol and @VIC, see this. @olga @bob @nobody @carol."}).json()
    # olga is not a member and @nobody does not exist; self-mentions are listed but never notified
    assert msg["mentions"] == [carol.id, viewer.id, bob.id]
    note = carol.get("/api/notifications").json()
    assert note["unread_count"] == 1
    item = note["items"][0]
    assert item["type"] == "mention" and item["actor"]["id"] == bob.id
    assert item["project"] == {"id": pid, "name": project["name"]}
    assert "mentioned you" in item["text"] and project["name"] in item["text"]
    assert outsider.get("/api/notifications").json()["unread_count"] == 0
    assert bob.get("/api/notifications").json()["unread_count"] == 0
    edited = bob.patch(f"/api/projects/{pid}/chat/{msg['id']}", json={"body": "@carol @admin"}).json()
    assert edited["mentions"] == [carol.id, admin.id]
    assert carol.get("/api/notifications").json()["unread_count"] == 1  # not notified twice
    assert admin.get("/api/notifications").json()["items"][0]["type"] == "mention"


def test_comments(team, admin):
    project, bob, _carol, viewer, _ = team
    pid = project["id"]
    image = images_of(admin, pid)[0]
    url = f"/api/projects/{pid}/images/{image['id']}/comments"
    first = viewer.post(url, json={"body": "Is this a cat?", "pin": {"x": 10.5, "y": 20}})
    assert first.status_code == 200
    comment = first.json()
    assert comment["pin"] == {"x": 10.5, "y": 20.0} and comment["resolved"] is False
    assert comment["image_id"] == image["id"] and comment["project_id"] == pid
    second = bob.post(url, json={"body": "yes"}).json()
    assert viewer.post(url, json={"body": " "}).status_code == 422
    assert viewer.post(url, json={"body": "x", "pin": {"x": "nan", "y": 1}}).status_code == 422
    item = images_of(admin, pid)[0]
    assert (item["comment_count"], item["open_comment_count"]) == (2, 2)

    assert bob.patch(f"/api/projects/{pid}/comments/{comment['id']}", json={"body": "edit"}).status_code == 403
    resolved = bob.patch(f"/api/projects/{pid}/comments/{comment['id']}", json={"resolved": True}).json()
    assert resolved["resolved"] is True
    edited = viewer.patch(f"/api/projects/{pid}/comments/{comment['id']}", json={"body": "Is it a dog?"}).json()
    assert edited["body"] == "Is it a dog?" and edited["edited_at"] is not None
    assert viewer.patch(f"/api/projects/{pid}/comments/{second['id']}", json={"resolved": True}).status_code == 403
    item = images_of(admin, pid)[0]
    assert (item["comment_count"], item["open_comment_count"]) == (2, 1)

    assert viewer.delete(f"/api/projects/{pid}/comments/{second['id']}").status_code == 403
    assert bob.delete(f"/api/projects/{pid}/comments/{second['id']}").status_code == 204
    thread = viewer.get(url).json()
    assert [c["id"] for c in thread] == [comment["id"], second["id"]]
    assert thread[1]["deleted"] is True and thread[1]["body"] == ""
    assert images_of(admin, pid)[0]["comment_count"] == 1
    assert admin.patch(f"/api/projects/{pid}/comments/999", json={"resolved": True}).status_code == 404
    assert "comment_added" in [a["type"] for a in admin.get(f"/api/projects/{pid}/activity").json()["items"]]


def test_project_comment_list(team, admin):
    project, bob, _, _, _ = team
    pid = project["id"]
    images = images_of(admin, pid)
    ids = []
    for n, image in enumerate(images * 2):
        ids.append(bob.post(f"/api/projects/{pid}/images/{image['id']}/comments", json={"body": f"c{n}"}).json()["id"])
    admin.patch(f"/api/projects/{pid}/comments/{ids[0]}", json={"resolved": True})
    page = admin.get(f"/api/projects/{pid}/comments", params={"limit": 4}).json()
    assert [c["id"] for c in page["items"]] == ids[2:] and page["has_more"] is True
    assert page["items"][0]["image"] == {"id": images[2]["id"], "filename": images[2]["filename"]}
    rest = admin.get(f"/api/projects/{pid}/comments", params={"limit": 4, "before_id": ids[2]}).json()
    assert [c["id"] for c in rest["items"]] == ids[:2] and rest["has_more"] is False
    open_only = admin.get(f"/api/projects/{pid}/comments", params={"resolved": "false"}).json()
    assert ids[0] not in [c["id"] for c in open_only["items"]] and len(open_only["items"]) == 5
    done = admin.get(f"/api/projects/{pid}/comments", params={"resolved": "true"}).json()
    assert [c["id"] for c in done["items"]] == [ids[0]]


def test_comment_notifications(team, admin):
    project, bob, carol, viewer, _ = team
    pid = project["id"]
    image = images_of(admin, pid)[0]
    url = f"/api/projects/{pid}/images/{image['id']}/comments"
    admin.patch(f"/api/projects/{pid}/images/{image['id']}", json={"assignee_id": bob.id})
    viewer.post(url, json={"body": "first"})
    bob_notes = [n for n in bob.get("/api/notifications").json()["items"] if n["type"] == "comment"]
    assert len(bob_notes) == 1 and bob_notes[0]["image"]["id"] == image["id"]
    assert "commented on img1.jpg" in bob_notes[0]["text"]
    carol.post(url, json={"body": "ping @vic"})
    vic_types = [n["type"] for n in viewer.get("/api/notifications", params={"unread": True}).json()["items"]]
    assert vic_types == ["mention"]  # mentioned watchers get one notification, not two
    assert len([n for n in bob.get("/api/notifications").json()["items"] if n["type"] == "comment"]) == 2
    assert not [n for n in carol.get("/api/notifications").json()["items"] if n["type"] == "comment"]


def test_direct_messages(team, admin):
    _, bob, carol, _, _ = team
    sent = [bob.post(f"/api/dm/{carol.id}", json={"body": f"hi {n}"}).json() for n in range(3)]
    assert sent[0]["sender_id"] == bob.id and sent[0]["recipient_id"] == carol.id and sent[0]["read_at"] is None
    reply = carol.post(f"/api/dm/{bob.id}", json={"body": "hello bob"}).json()
    admin.post(f"/api/dm/{carol.id}", json={"body": "from admin"})

    convs = carol.get("/api/dm").json()
    assert [c["user"]["id"] for c in convs] == [admin.id, bob.id]  # newest first
    by_user = {c["user"]["id"]: c for c in convs}
    assert by_user[bob.id]["last_message"]["id"] == reply["id"] and by_user[bob.id]["unread_count"] == 3
    assert {c["user"]["id"]: c["unread_count"] for c in bob.get("/api/dm").json()} == {carol.id: 1}

    thread = carol.get(f"/api/dm/{bob.id}", params={"limit": 2}).json()
    assert [m["id"] for m in thread["items"]] == [sent[2]["id"], reply["id"]] and thread["has_more"] is True
    older = carol.get(f"/api/dm/{bob.id}", params={"before_id": sent[2]["id"]}).json()
    assert [m["id"] for m in older["items"]] == [sent[0]["id"], sent[1]["id"]]
    assert admin.get(f"/api/dm/{bob.id}").json()["items"] == []

    notes = carol.get("/api/notifications").json()["items"]
    dm_from_bob = [n for n in notes if n["type"] == "dm" and n["actor"]["id"] == bob.id]
    assert len(dm_from_bob) == 1 and "3 messages" in dm_from_bob[0]["text"]  # coalesced per sender
    assert carol.post(f"/api/dm/{bob.id}/read").status_code == 204
    assert {c["user"]["id"]: c["unread_count"] for c in carol.get("/api/dm").json()}[bob.id] == 0
    assert carol.get(f"/api/dm/{bob.id}").json()["items"][0]["read_at"] is not None
    remaining = [n for n in carol.get("/api/notifications", params={"unread": True}).json()["items"]
                 if n["actor"]["id"] == bob.id]
    assert remaining == []

    assert bob.post(f"/api/dm/{bob.id}", json={"body": "me"}).status_code == 400
    assert bob.post("/api/dm/9999", json={"body": "?"}).status_code == 404
    assert bob.get("/api/dm/9999").status_code == 404
    admin.patch(f"/api/users/{carol.id}", json={"is_active": False})
    assert bob.post(f"/api/dm/{carol.id}", json={"body": "still there?"}).status_code == 400


def test_dm_mention_notification(team):
    _, bob, carol, _, _ = team
    bob.post(f"/api/dm/{carol.id}", json={"body": "hey @carol, quick question"})
    note = carol.get("/api/notifications").json()["items"][0]
    assert note["type"] == "mention" and note["project"] is None and "direct message" in note["text"]


def test_notifications_list_and_read(team, admin):
    project, bob, carol, _, _ = team
    pid = project["id"]
    for n in range(5):
        bob.post(f"/api/projects/{pid}/chat", json={"body": f"@carol {n}"})
    page = carol.get("/api/notifications", params={"limit": 2}).json()
    assert page["unread_count"] == 5 and page["has_more"] is True
    ids = [n["id"] for n in page["items"]]
    assert ids == sorted(ids, reverse=True)  # newest first
    older = carol.get("/api/notifications", params={"before_id": ids[-1], "limit": 10, "unread": True}).json()
    assert len(older["items"]) == 3 and older["has_more"] is False
    assert len(carol.get("/api/notifications", params={"before_id": ids[-1]}).json()["items"]) == 4  # + read one
    assert carol.post("/api/notifications/read", json={"ids": ids}).json() == {"unread_count": 3}
    assert len(carol.get("/api/notifications", params={"unread": True}).json()["items"]) == 3
    assert carol.post("/api/notifications/read", json={"ids": []}).json() == {"unread_count": 3}
    assert bob.post("/api/notifications/read", json={"all": True}).json() == {"unread_count": 0}
    assert carol.get("/api/notifications").json()["unread_count"] == 3  # other users unaffected
    assert carol.post("/api/notifications/read", json={"all": True}).json() == {"unread_count": 0}
    assert carol.get("/api/notifications").json()["items"][0]["read_at"] is not None


def test_activity_feed(team, admin):
    project, bob, carol, _, _ = team
    pid = project["id"]
    images = images_of(admin, pid)
    for image in images:
        bob.put(f"/api/projects/{pid}/images/{image['id']}/annotation", json={"base_version": None, "boxes": []})
    carol.patch(f"/api/projects/{pid}/images/{images[0]['id']}", json={"flagged": True})
    feed = admin.get(f"/api/projects/{pid}/activity").json()
    assert feed["items"][0]["type"] == "flagged" and feed["items"][0]["user"]["id"] == carol.id
    assert feed["items"][0]["image"] == {"id": images[0]["id"], "filename": images[0]["filename"]}
    assert feed["items"][0]["data"] == {"flagged": True}
    ids = [a["id"] for a in feed["items"]]
    assert ids == sorted(ids, reverse=True)
    by_bob = admin.get(f"/api/projects/{pid}/activity", params={"user_id": bob.id}).json()["items"]
    assert {a["type"] for a in by_bob} == {"annotation_saved"} and len(by_bob) == 3
    by_image = admin.get(f"/api/projects/{pid}/activity", params={"image_id": images[0]["id"]}).json()["items"]
    assert [a["type"] for a in by_image] == ["flagged", "annotation_saved"]
    page = admin.get(f"/api/projects/{pid}/activity", params={"limit": 2}).json()
    assert len(page["items"]) == 2 and page["has_more"] is True
    rest = admin.get(f"/api/projects/{pid}/activity", params={"before_id": page["items"][-1]["id"]}).json()
    assert rest["has_more"] is False and len(rest["items"]) == len(ids) - 2
