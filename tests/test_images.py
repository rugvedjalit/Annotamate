"""Image list filters, pagination, neighbours, file/thumbnail serving, workflow and bulk actions."""

from __future__ import annotations

import io

import pytest
from PIL import Image

from conftest import box, images_of, make_image


@pytest.fixture
def big(root):
    folder = root / "big"
    for n in range(1, 13):
        make_image(folder / f"frame{n}.png", (40, 30))
    return folder


@pytest.fixture
def project(create_project, big, make_user):
    ann = make_user("ann")
    rev = make_user("rev")
    project = create_project(big, classes=["cat", "dog"], members=[(ann, "annotator"), (rev, "reviewer")])
    return project, ann, rev


def test_pagination_and_natural_order(admin, project):
    proj, _, _ = project
    pid = proj["id"]
    page = admin.get(f"/api/projects/{pid}/images", params={"offset": 10, "limit": 5}).json()
    assert page["total"] == 12 and page["offset"] == 10
    assert [i["filename"] for i in page["items"]] == ["frame11.png", "frame12.png"]
    first = admin.get(f"/api/projects/{pid}/images", params={"limit": 3}).json()["items"]
    assert [i["filename"] for i in first] == ["frame1.png", "frame2.png", "frame3.png"]
    assert set(first[0]) == {"id", "filename", "rel_path", "position", "status", "box_count", "class_ids",
                             "assignee", "flagged", "comment_count", "open_comment_count", "last_editor",
                             "updated_at"}
    assert admin.get(f"/api/projects/{pid}/images", params={"limit": 501}).status_code == 422
    assert admin.get(f"/api/projects/{pid}/images", params={"offset": -1}).status_code == 422


def test_filters(admin, project):
    proj, ann, _ = project
    pid = proj["id"]
    cat, dog = (c["id"] for c in proj["classes"])
    items = images_of(admin, pid)
    by_name = {i["filename"]: i["id"] for i in items}
    admin.put(f"/api/projects/{pid}/images/{by_name['frame2.png']}/annotation",
              json={"base_version": None, "boxes": [box(dog, 1, 1, 10, 10)]})
    admin.patch(f"/api/projects/{pid}/images/{by_name['frame3.png']}", json={"flagged": True})
    admin.patch(f"/api/projects/{pid}/images/{by_name['frame4.png']}", json={"assignee_id": ann.id})
    c = admin.post(f"/api/projects/{pid}/images/{by_name['frame5.png']}/comments", json={"body": "look"}).json()
    admin.post(f"/api/projects/{pid}/images/{by_name['frame6.png']}/comments", json={"body": "done"})
    admin.patch(f"/api/projects/{pid}/comments/{c['id'] + 1}", json={"resolved": True})

    def names(**params):
        return [i["filename"] for i in images_of(admin, pid, **params)]

    assert names(q="FRAME1") == ["frame1.png", "frame10.png", "frame11.png", "frame12.png"]
    assert names(q="%") == [] and names(q="_") == []
    assert names(status="in_progress") == ["frame2.png"]
    assert len(names(status="todo,in_progress")) == 12
    assert names(flagged="true") == ["frame3.png"]
    assert len(names(flagged="false")) == 11
    assert names(class_id=dog) == ["frame2.png"] and names(class_id=cat) == []
    assert names(assignee=str(ann.id)) == ["frame4.png"]
    assert names(assignee="none")[:3] == ["frame1.png", "frame2.png", "frame3.png"]
    assert ann.get(f"/api/projects/{pid}/images", params={"assignee": "me"}).json()["total"] == 1
    assert names(has_comments="open") == ["frame5.png"]
    assert names(has_comments="any") == ["frame5.png", "frame6.png"]
    assert names(sort="updated")[0] == "frame2.png"  # last save or status change first; comments do not count
    for bad in ({"status": "lost"}, {"assignee": "someone"}, {"has_comments": "maybe"}, {"sort": "random"}):
        response = admin.get(f"/api/projects/{pid}/images", params=bad)
        assert response.status_code == 422 and response.json()["code"] == "validation_error"


def test_neighbors(admin, project):
    proj, _, _ = project
    pid = proj["id"]
    items = images_of(admin, pid)
    ids = [i["id"] for i in items]
    url = f"/api/projects/{pid}/images/{{}}/neighbors"
    assert admin.get(url.format(ids[0])).json() == {"prev_id": None, "next_id": ids[1], "index": 0, "total": 12}
    assert admin.get(url.format(ids[5])).json() == {"prev_id": ids[4], "next_id": ids[6], "index": 5, "total": 12}
    assert admin.get(url.format(ids[11])).json()["next_id"] is None
    for i in (2, 7):
        admin.patch(f"/api/projects/{pid}/images/{ids[i]}", json={"flagged": True})
    flagged = admin.get(url.format(ids[2]), params={"flagged": "true"}).json()
    assert flagged == {"prev_id": None, "next_id": ids[7], "index": 0, "total": 2}
    excluded = admin.get(url.format(ids[5]), params={"flagged": "true"}).json()
    assert excluded == {"prev_id": ids[2], "next_id": ids[7], "index": -1, "total": 2}
    for i in (2, 7):  # status changes set updated_at; ids[7] becomes the most recent
        admin.post(f"/api/projects/{pid}/images/{ids[i]}/status", json={"action": "submit"})
    updated = admin.get(url.format(ids[7]), params={"sort": "updated"}).json()
    assert updated["index"] == 0 and updated["next_id"] == ids[2] and updated["prev_id"] is None


def test_image_detail(admin, create_project, root):
    folder = root / "exif"
    make_image(folder / "rot.jpg", (40, 20), orientation=6)
    (folder / "broken.png").write_bytes(b"not a png")
    project = create_project(folder)
    pid = project["id"]
    items = {i["filename"]: i for i in images_of(admin, pid)}
    detail = admin.get(f"/api/projects/{pid}/images/{items['rot.jpg']['id']}").json()
    assert (detail["width"], detail["height"], detail["error"]) == (20, 40, None)
    assert detail["label_path"] == "rot.txt"
    assert detail["file_url"].startswith(f"api/projects/{pid}/images/{detail['id']}/file?v=")
    broken = admin.get(f"/api/projects/{pid}/images/{items['broken.png']['id']}").json()
    assert broken["width"] is None and broken["error"] == "Cannot decode image"
    assert admin.get(f"/api/projects/{pid}/images/99999").status_code == 404

    admin.patch(f"/api/projects/{pid}", json={"settings": {"exif_mode": "ignore"}})
    raw = admin.get(f"/api/projects/{pid}/images/{items['rot.jpg']['id']}").json()
    assert (raw["width"], raw["height"]) == (40, 20)


def test_file_and_thumbnail(admin, create_project, root):
    folder = root / "files"
    make_image(folder / "plain.png", (30, 20))
    make_image(folder / "rot.jpg", (40, 20), orientation=6)
    make_image(folder / "scan.tif", (16, 8))
    project = create_project(folder)
    pid = project["id"]
    items = {i["filename"]: i["id"] for i in images_of(admin, pid)}

    plain = admin.get(f"/api/projects/{pid}/images/{items['plain.png']}/file", params={"v": "1"})
    assert plain.headers["content-type"] == "image/png"
    assert plain.headers["cache-control"] == "private, max-age=31536000, immutable"
    assert plain.content == (folder / "plain.png").read_bytes()
    assert "immutable" not in admin.get(f"/api/projects/{pid}/images/{items['plain.png']}/file") \
        .headers["cache-control"]

    rotated = admin.get(f"/api/projects/{pid}/images/{items['rot.jpg']}/file")
    img = Image.open(io.BytesIO(rotated.content))
    assert img.size == (20, 40) and img.getexif().get(0x0112) in (None, 1)
    tiff = admin.get(f"/api/projects/{pid}/images/{items['scan.tif']}/file")
    assert tiff.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(tiff.content)).size == (16, 8)

    thumb = admin.get(f"/api/projects/{pid}/images/{items['rot.jpg']}/thumb", params={"size": 64})
    assert thumb.headers["content-type"] == "image/webp"
    timg = Image.open(io.BytesIO(thumb.content))
    assert timg.format == "WEBP" and max(timg.size) <= 64 and timg.size[1] > timg.size[0]
    assert admin.get(f"/api/projects/{pid}/images/{items['plain.png']}/thumb", params={"size": 32}).status_code == 422
    assert admin.get(f"/api/projects/{pid}/images/{items['plain.png']}/thumb", params={"size": 999}).status_code == 422


def test_status_workflow(admin, project, app):
    proj, ann, rev = project
    pid = proj["id"]
    image = images_of(admin, pid)[0]
    url = f"/api/projects/{pid}/images/{image['id']}"

    def act(user, action, **extra):
        return user.post(f"{url}/status", json={"action": action, **extra})

    saved = ann.put(f"{url}/annotation", json={"base_version": None, "boxes": []}).json()
    assert saved["image"]["status"] == "in_progress"
    assert act(ann, "submit").json()["status"] == "done"  # require_review is off
    assert act(ann, "submit").status_code == 400
    assert act(ann, "reopen").status_code == 200

    admin.patch(f"/api/projects/{pid}", json={"settings": {"require_review": True}})
    assert act(ann, "submit").json()["status"] == "review"
    requested = rev.get("/api/notifications").json()["items"]
    assert requested[0]["type"] == "review_requested" and requested[0]["image"]["id"] == image["id"]
    assert act(ann, "approve").status_code == 403
    missing = act(rev, "reject")
    assert missing.status_code == 400
    assert act(rev, "reject", comment="   ").status_code == 400
    rejected = act(rev, "reject", comment="The tail is missing @ann")
    assert rejected.status_code == 200 and rejected.json()["status"] == "rejected"
    assert rejected.json()["open_comment_count"] == 1
    comments = admin.get(f"{url}/comments").json()
    assert comments[-1]["body"] == "The tail is missing @ann" and comments[-1]["user"]["id"] == rev.id
    types = [n["type"] for n in ann.get("/api/notifications").json()["items"]]
    assert "review_rejected" in types and "mention" in types
    assert act(rev, "approve").status_code == 400  # not in review any more

    resaved = ann.put(f"{url}/annotation", json={"base_version": saved["version"], "boxes": []}).json()
    assert resaved["image"]["status"] == "in_progress"  # rejected -> in_progress on save
    assert act(ann, "submit").json()["status"] == "review"
    approved = act(rev, "approve").json()
    assert approved["status"] == "done"
    assert ann.get("/api/notifications").json()["items"][0]["type"] == "review_approved"
    assert act(rev, "reopen").json()["status"] == "in_progress"
    assert act(admin, "teleport").status_code == 422

    history = [a for a in admin.get(f"/api/projects/{pid}/activity", params={"image_id": image["id"]}).json()["items"]
               if a["type"] == "status_changed"]
    assert history[0]["data"] == {"from": "done", "to": "in_progress", "action": "reopen"}


def test_reopen_needs_ownership(admin, project, make_user, app):
    proj, ann, _ = project
    pid = proj["id"]
    other = make_user("other")
    admin.post(f"/api/projects/{pid}/members", json={"user_id": other.id, "role": "annotator"})
    image = images_of(admin, pid)[0]
    url = f"/api/projects/{pid}/images/{image['id']}"
    ann.post(f"{url}/status", json={"action": "submit"})
    assert other.post(f"{url}/status", json={"action": "reopen"}).status_code == 403
    assert ann.post(f"{url}/status", json={"action": "reopen"}).status_code == 200


def test_flag_and_assign_notifications(admin, project):
    proj, ann, _ = project
    pid = proj["id"]
    image = images_of(admin, pid)[0]
    url = f"/api/projects/{pid}/images/{image['id']}"
    flagged = ann.patch(url, json={"flagged": True}).json()
    assert flagged["flagged"] is True
    assigned = admin.patch(url, json={"assignee_id": ann.id}).json()
    assert assigned["assignee"]["id"] == ann.id
    note = ann.get("/api/notifications").json()["items"][0]
    assert note["type"] == "assignment" and note["actor"]["id"] == admin.id
    assert "assigned you frame1.png" in note["text"]
    assert admin.patch(url, json={"assignee_id": 4242}).status_code == 400


def test_bulk_actions(admin, project):
    proj, ann, _rev = project
    pid = proj["id"]
    ids = [i["id"] for i in images_of(admin, pid)]
    bulk = f"/api/projects/{pid}/images/bulk"

    assert admin.post(bulk, json={"image_ids": ids[:3], "action": "assign", "assignee_id": ann.id}).json() == \
        {"updated": 3}
    assert ann.get(f"/api/projects/{pid}/images", params={"assignee": "me"}).json()["total"] == 3
    summary = [n for n in ann.get("/api/notifications").json()["items"] if n["type"] == "assignment"]
    assert len(summary) == 1 and "3 images" in summary[0]["text"]
    assert admin.post(bulk, json={"filter": {"assignee": str(ann.id)}, "action": "unassign"}).json()["updated"] == 3
    assert admin.post(bulk, json={"filter": {"q": "frame1"}, "action": "flag"}).json()["updated"] == 4
    assert admin.post(bulk, json={"image_ids": ids, "action": "set_status", "status": "done"}).json()["updated"] == 12
    assert admin.get(f"/api/projects/{pid}").json()["status_counts"]["done"] == 12
    assert admin.post(bulk, json={"filter": {"flagged": True}, "action": "unflag", "limit": 2}).json()["updated"] == 2
    assert admin.post(bulk, json={"action": "flag"}).status_code == 400
    assert admin.post(bulk, json={"image_ids": [99999], "action": "flag"}).status_code == 400
    assert admin.post(bulk, json={"image_ids": ids, "action": "assign"}).status_code == 400
    assert admin.post(bulk, json={"image_ids": ids, "action": "set_status"}).status_code == 400
    assert admin.post(bulk, json={"image_ids": ids, "action": "explode"}).status_code == 422


def test_bulk_distribute(admin, project):
    proj, ann, rev = project
    pid = proj["id"]
    response = admin.post(f"/api/projects/{pid}/images/bulk", json={
        "filter": {"assignee": "none"}, "action": "distribute", "user_ids": [ann.id, rev.id], "limit": 11})
    assert response.json() == {"updated": 11}
    items = images_of(admin, pid)
    owners = [i["assignee"]["id"] if i["assignee"] else None for i in items]
    assert owners == [ann.id] * 6 + [rev.id] * 5 + [None]  # contiguous, natural order, split evenly
    for user, count in ((ann, 6), (rev, 5)):
        notes = [n for n in user.get("/api/notifications").json()["items"] if n["type"] == "assignment"]
        assert len(notes) == 1 and f"{count} images" in notes[0]["text"]
    activity = admin.get(f"/api/projects/{pid}/activity").json()["items"][0]
    assert activity["type"] == "assigned" and activity["data"]["count"] == 11
    assert admin.post(f"/api/projects/{pid}/images/bulk", json={"filter": {}, "action": "distribute",
                                                                "user_ids": []}).status_code == 400
    viewer_like = admin.post(f"/api/projects/{pid}/images/bulk", json={"filter": {}, "action": "distribute",
                                                                       "user_ids": [admin.id, 9999]})
    assert viewer_like.status_code == 400
