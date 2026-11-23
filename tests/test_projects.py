"""Projects: creation, indexing, rescans, settings, members, statistics and the folder browser."""

from __future__ import annotations

import json
import os
from datetime import timedelta

from annotamate.server.models import Activity, utcnow
from conftest import box, images_of, make_image, wait_idle


def test_create_project_and_index_existing_labels(admin, create_project, dataset):
    (dataset / "classes.txt").write_text("cat\ndog\n")
    (dataset / "img2.txt").write_text("0 0.5 0.5 0.2 0.2\n1 0.1 0.1 0.1 0.1\n1 0.3 0.3 0.1 0.1\n")
    (dataset / "img10.txt").write_text("")  # background image
    project = create_project(dataset)
    assert [c["name"] for c in project["classes"]] == ["cat", "dog"]
    assert [c["index"] for c in project["classes"]] == [0, 1]
    assert project["image_count"] == 3
    assert project["status_counts"] == {"todo": 1, "in_progress": 0, "review": 0, "done": 2, "rejected": 0}
    assert project["indexing"] is False
    assert project["settings"] == {"require_review": False, "restrict_to_assigned": False,
                                   "annotators_can_add_classes": True, "exif_mode": "apply", "recursive": False}
    assert project["members"][0]["user"]["id"] == admin.id and project["members"][0]["role"] == "manager"
    items = images_of(admin, project["id"])
    assert [i["filename"] for i in items] == ["img1.jpg", "img2.jpg", "img10.jpg"]
    assert [i["position"] for i in items] == [0, 1, 2]
    cat, dog = (c["id"] for c in project["classes"])
    assert items[1]["box_count"] == 3 and items[1]["class_ids"] == [cat, dog]
    assert items[2]["status"] == "done" and items[2]["box_count"] == 0
    assert items[0]["status"] == "todo"


def test_explicit_classes_write_classes_txt(create_project, dataset):
    project = create_project(dataset, classes=["b", "a", "b"])
    assert [c["name"] for c in project["classes"]] == ["b", "a"]
    assert (dataset / "classes.txt").read_text() == "b\na\n"
    colors = {c["color"] for c in project["classes"]}
    assert len(colors) == 2


def test_discover_classes_from_voc_and_coco(create_project, root):
    voc = root / "voc"
    make_image(voc / "a.jpg")
    (voc / "a.xml").write_text("<annotation><object><name>truck</name><bndbox><xmin>1</xmin><ymin>1</ymin>"
                               "<xmax>5</xmax><ymax>5</ymax></bndbox></object></annotation>")
    project = create_project(voc, label_format="voc")
    assert [c["name"] for c in project["classes"]] == ["truck"]
    assert (voc / "classes.txt").read_text() == "truck\n"

    coco = root / "coco"
    make_image(coco / "a.jpg")
    (coco / "a.json").write_text(json.dumps({
        "images": [{"id": 1, "file_name": "a.jpg", "width": 100, "height": 50}],
        "annotations": [{"id": 1, "image_id": 1, "category_id": 2, "bbox": [1, 1, 4, 4]}],
        "categories": [{"id": 1, "name": "person"}, {"id": 2, "name": "bike"}],
    }))
    project = create_project(coco, label_format="coco", name="Coco")
    assert [c["name"] for c in project["classes"]] == ["person", "bike"]


def test_create_project_validation(admin, root, tmp_path):
    def create(**body):
        return admin.post("/api/projects", json={"name": "P", "label_format": "yolo", **body})

    outside = tmp_path / "outside"
    outside.mkdir()
    assert create(image_dir=str(outside)).status_code == 400
    assert create(image_dir=str(root / ".." / "outside")).status_code == 400
    assert create(image_dir="relative/path").status_code == 400
    assert create(image_dir=str(root / "missing")).status_code == 400
    assert create(image_dir=str(root), label_format="xml").status_code == 422
    assert create(image_dir=str(root), name="").status_code == 422
    assert create(image_dir=str(root), label_dir=str(outside)).status_code == 400
    assert create(image_dir=str(root), members=[{"user_id": 999, "role": "viewer"}]).status_code == 400
    assert create(image_dir=str(root), classes=["bad\nname"]).status_code == 400


def test_label_dir_is_created_and_used(admin, app, create_project, dataset, root):
    labels = root / "labels" / "train"
    project = create_project(dataset, label_dir=labels, classes=["cat"])
    assert labels.is_dir() and (labels / "classes.txt").read_text() == "cat\n"
    assert project["label_dir"] == os.path.realpath(labels)
    image = images_of(admin, project["id"])[0]
    response = admin.put(f"/api/projects/{project['id']}/images/{image['id']}/annotation",
                         json={"base_version": None, "boxes": [box(project["classes"][0]["id"], 10, 10, 30, 30)]})
    assert response.status_code == 200
    assert (labels / "img1.txt").exists() and not (dataset / "img1.txt").exists()
    detail = admin.get(f"/api/projects/{project['id']}/images/{image['id']}").json()
    assert detail["label_path"] == "img1.txt"


def test_recursive_projects(admin, app, create_project, root):
    folder = root / "nested"
    make_image(folder / "top.png")
    make_image(folder / "sub" / "a2.png")
    make_image(folder / "sub" / "a10.png")
    make_image(folder / ".hidden" / "x.png")
    flat = create_project(folder)
    assert flat["image_count"] == 1
    admin.patch(f"/api/projects/{flat['id']}", json={"settings": {"recursive": True}})
    wait_idle(app)
    items = images_of(admin, flat["id"])
    assert [i["rel_path"] for i in items] == ["sub/a2.png", "sub/a10.png", "top.png"]
    image = items[0]
    response = admin.put(f"/api/projects/{flat['id']}/images/{image['id']}/annotation",
                         json={"base_version": None, "boxes": []})
    assert response.status_code == 200
    assert (folder / "sub" / "a2.txt").exists()
    assert admin.get(f"/api/projects/{flat['id']}/images/{image['id']}").json()["label_path"] == "sub/a2.txt"


def test_rescan_adds_and_removes(admin, app, create_project, dataset):
    project = create_project(dataset)
    pid = project["id"]
    keep = images_of(admin, pid)[0]
    admin.post(f"/api/projects/{pid}/images/{keep['id']}/comments", json={"body": "keep me"})
    make_image(dataset / "img3.jpg")
    os.remove(dataset / "img10.jpg")
    (dataset / "img2.txt").write_text("0 0.5 0.5 0.1 0.1\n")
    response = admin.post(f"/api/projects/{pid}/rescan")
    assert response.status_code == 202 and response.json() == {"started": True}
    wait_idle(app)
    items = images_of(admin, pid)
    assert [i["filename"] for i in items] == ["img1.jpg", "img2.jpg", "img3.jpg"]
    assert items[0]["id"] == keep["id"] and items[0]["comment_count"] == 1
    assert items[1]["status"] == "todo" and items[1]["box_count"] == 1  # workflow status is never changed by a rescan
    activity = admin.get(f"/api/projects/{pid}/activity").json()["items"]
    rescanned = next(a for a in activity if a["type"] == "rescanned")
    assert rescanned["data"] == {"added": 1, "removed": 1, "total": 3}


def test_rescan_keeps_index_when_folder_missing(admin, app, create_project, root):
    folder = root / "gone"
    make_image(folder / "a.jpg")
    project = create_project(folder)
    for name in os.listdir(folder):
        os.remove(folder / name)
    folder.rmdir()
    admin.post(f"/api/projects/{project['id']}/rescan")
    wait_idle(app)
    assert admin.get(f"/api/projects/{project['id']}").json()["image_count"] == 1


def test_project_list_and_summary(admin, make_user, create_project, dataset, root):
    bob = make_user("bob")
    project = create_project(dataset, members=[(bob, "annotator")])
    pid = project["id"]
    other = root / "other"
    make_image(other / "x.png")
    create_project(other, name="Zeta")
    image = images_of(admin, pid)[0]
    admin.patch(f"/api/projects/{pid}/images/{image['id']}", json={"assignee_id": bob.id})
    admin.post(f"/api/projects/{pid}/chat", json={"body": "hello"})
    admin.post(f"/api/projects/{pid}/chat", json={"body": "again"})

    summaries = bob.get("/api/projects").json()
    assert len(summaries) == 1
    summary = summaries[0]
    assert set(summary) == {"id", "name", "description", "label_format", "image_count", "missing_count",
                            "status_counts", "member_count", "my_role", "my_assigned_todo", "unread_chat",
                            "archived", "indexing", "class_migration", "created_at", "updated_at",
                            "members_preview"}
    assert summary["class_migration"] is None
    assert summary["my_role"] == "annotator" and summary["member_count"] == 2
    # Card avatars without one /members request per card: managers first, then by name.
    assert [u["username"] for u in summary["members_preview"]] == ["admin", "bob"]
    assert set(summary["members_preview"][0]) == {"id", "username", "display_name", "avatar_color"}
    assert summary["my_assigned_todo"] == 1 and summary["unread_chat"] == 2
    assert len(admin.get("/api/projects").json()) == 2

    assert admin.patch(f"/api/projects/{pid}", json={"archived": True}).json()["archived"] is True
    assert [p["name"] for p in admin.get("/api/projects").json()] == ["Zeta"]
    assert [p["id"] for p in admin.get("/api/projects", params={"archived": True}).json()] == [pid]


def test_members_preview_is_capped(admin, make_user, create_project, dataset):
    people = [make_user(f"user{i}") for i in range(7)]
    project = create_project(dataset, members=[(u, "viewer" if i < 4 else "reviewer") for i, u in enumerate(people)])
    summary = next(p for p in admin.get("/api/projects").json() if p["id"] == project["id"])
    assert summary["member_count"] == 8
    preview = [u["username"] for u in summary["members_preview"]]
    assert preview == ["admin", "user4", "user5", "user6", "user0"]  # manager, reviewers, then viewers by name


def test_patch_project(admin, app, create_project, dataset):
    project = create_project(dataset)
    pid = project["id"]
    patched = admin.patch(f"/api/projects/{pid}", json={"name": "Renamed", "description": "about",
                                                        "settings": {"require_review": True, "exif_mode": "ignore"}})
    assert patched.status_code == 200
    body = patched.json()
    assert body["name"] == "Renamed" and body["description"] == "about"
    assert body["settings"]["require_review"] is True and body["settings"]["exif_mode"] == "ignore"
    assert admin.patch(f"/api/projects/{pid}", json={"settings": {"exif_mode": "rotate"}}).status_code == 422
    feed = admin.get(f"/api/projects/{pid}/activity").json()["items"]
    types = [a["type"] for a in feed]
    assert "project_updated" in types and "project_created" in types
    updated = next(a for a in feed if a["type"] == "project_updated")
    # Changed fields plus display values (never the description text or folder paths).
    assert updated["data"] == {"changes": ["name", "description", "require_review", "exif_mode"],
                               "values": {"name": "Renamed", "require_review": True, "exif_mode": "ignore"}}
    admin.patch(f"/api/projects/{pid}", json={"archived": True})
    archived = admin.get(f"/api/projects/{pid}/activity").json()["items"][0]
    assert archived["data"] == {"changes": ["archived"], "values": {"archived": True}}


def test_delete_project_keeps_files(admin, create_project, dataset):
    (dataset / "img1.txt").write_text("0 0.5 0.5 0.1 0.1\n")
    project = create_project(dataset, classes=["a"])
    assert admin.delete(f"/api/projects/{project['id']}").status_code == 204
    assert admin.get(f"/api/projects/{project['id']}").status_code == 404
    assert (dataset / "img1.txt").exists() and (dataset / "img1.jpg").exists()


def test_members(admin, make_user, create_project, dataset):
    bob, carol = make_user("bob"), make_user("carol")
    project = create_project(dataset)
    pid = project["id"]
    member = admin.post(f"/api/projects/{pid}/members", json={"user_id": bob.id, "role": "annotator"})
    assert member.status_code == 200
    assert member.json()["user"]["id"] == bob.id and member.json()["role"] == "annotator"
    assert set(member.json()) == {"user", "role", "joined_at", "assigned_count", "done_count", "last_seen_at"}
    assert member.json()["last_seen_at"] is not None and member.json()["last_seen_at"].endswith("Z")  # signed in
    dup = admin.post(f"/api/projects/{pid}/members", json={"user_id": bob.id, "role": "viewer"})
    assert dup.status_code == 409 and dup.json()["code"] == "exists"
    assert admin.post(f"/api/projects/{pid}/members", json={"user_id": 999, "role": "viewer"}).status_code == 400
    assert admin.post(f"/api/projects/{pid}/members", json={"user_id": carol.id, "role": "boss"}).status_code == 422
    notes = bob.get("/api/notifications").json()["items"]
    assert notes[0]["type"] == "project_added" and notes[0]["project"]["id"] == pid

    image = images_of(admin, pid)[0]
    admin.patch(f"/api/projects/{pid}/images/{image['id']}", json={"assignee_id": bob.id})
    members = {m["user"]["id"]: m for m in admin.get(f"/api/projects/{pid}/members").json()}
    assert members[bob.id]["assigned_count"] == 1

    assert admin.patch(f"/api/projects/{pid}/members/{bob.id}", json={"role": "reviewer"}).json()["role"] == \
        "reviewer"
    last = admin.patch(f"/api/projects/{pid}/members/{admin.id}", json={"role": "viewer"})
    assert last.status_code == 400
    assert admin.delete(f"/api/projects/{pid}/members/{admin.id}").status_code == 400
    assert admin.patch(f"/api/projects/{pid}/members/{carol.id}", json={"role": "viewer"}).status_code == 404

    # leaving clears assignments
    assert bob.delete(f"/api/projects/{pid}/members/{bob.id}").status_code == 204
    assert bob.get(f"/api/projects/{pid}").status_code == 404
    assert admin.get(f"/api/projects/{pid}/images/{image['id']}").json()["assignee"] is None
    types = [a["type"] for a in admin.get(f"/api/projects/{pid}/activity").json()["items"]]
    assert {"member_added", "member_updated", "member_removed"} <= set(types)


def test_member_cannot_remove_others(admin, make_user, create_project, dataset):
    bob, carol = make_user("bob"), make_user("carol")
    project = create_project(dataset, members=[(bob, "reviewer"), (carol, "viewer")])
    assert bob.delete(f"/api/projects/{project['id']}/members/{carol.id}").status_code == 403


def test_stats(admin, make_user, create_project, dataset):
    bob = make_user("bob")
    project = create_project(dataset, classes=["cat", "dog"], members=[(bob, "annotator")],
                             settings={"require_review": True})
    pid = project["id"]
    cat, dog = (c["id"] for c in project["classes"])
    first, second, _ = images_of(admin, pid)
    url = f"/api/projects/{pid}/images/{first['id']}"
    saved = bob.put(f"{url}/annotation", json={"base_version": None, "boxes": [box(cat, 1, 1, 9, 9),
                                                                              box(dog, 2, 2, 8, 8)]}).json()
    bob.put(f"{url}/annotation", json={"base_version": saved["version"],
                                       "boxes": [box(cat, 1, 1, 9, 9), box(cat, 2, 2, 8, 8), box(dog, 3, 3, 6, 6)]})
    bob.post(f"{url}/status", json={"action": "submit"})
    admin.post(f"{url}/status", json={"action": "approve"})
    url2 = f"/api/projects/{pid}/images/{second['id']}"
    bob.put(f"{url2}/annotation", json={"base_version": None, "boxes": [box(dog, 1, 1, 5, 5)]})
    bob.post(f"{url2}/status", json={"action": "submit"})
    admin.post(f"{url2}/status", json={"action": "reject", "comment": "missing a cat"})

    stats = admin.get(f"/api/projects/{pid}/stats").json()
    assert stats["images_total"] == 3 and stats["boxes_total"] == 4
    assert stats["status_counts"]["done"] == 1 and stats["status_counts"]["rejected"] == 1
    counts = {c["class_id"]: c for c in stats["class_counts"]}
    assert counts[cat] == {"class_id": cat, "boxes": 2, "images": 1}
    assert counts[dog] == {"class_id": dog, "boxes": 2, "images": 2}
    per = {p["user"]["id"]: p for p in stats["per_user"]}
    assert per[bob.id] == {"user": per[bob.id]["user"], "saves": 3, "boxes": 4, "submitted": 2, "approved": 1,
                           "rejected": 1, "reviewed": 0}
    assert per[admin.id]["reviewed"] == 2
    assert len(stats["daily"]) == 30
    assert stats["daily"][-1]["saves"] == 3 and stats["daily"][-1]["done"] == 1
    members = {m["user"]["id"]: m for m in admin.get(f"/api/projects/{pid}/members").json()}
    assert members[bob.id]["done_count"] == 1


def test_stats_daily_follows_the_viewers_calendar(admin, app, create_project, dataset):
    """"Daily" buckets use the viewer's UTC offset: late-evening UTC work is "tomorrow" in Asia, for example."""
    project = create_project(dataset)
    pid = project["id"]
    with app.state.ctx.db.session() as session:
        late = utcnow().replace(hour=21, minute=10, second=0, microsecond=0) - timedelta(days=1)
        session.add(Activity(project_id=pid, type="annotation_saved", user_id=admin.id, data={"box_count": 1},
                             count=2, created_at=late))
        session.commit()
    utc_days = {d["date"]: d["saves"] for d in admin.get(f"/api/projects/{pid}/stats").json()["daily"]}
    india = admin.get(f"/api/projects/{pid}/stats", params={"tz_offset": 330}).json()["daily"]
    india_days = {d["date"]: d["saves"] for d in india}
    assert utc_days[late.date().isoformat()] == 2
    assert india_days[(late + timedelta(days=1)).date().isoformat()] == 2  # 02:40 the next day in UTC+05:30
    assert india[-1]["date"] == (utcnow() + timedelta(minutes=330)).date().isoformat()
    assert len(india) == 30
    assert admin.get(f"/api/projects/{pid}/stats", params={"tz_offset": 9999}).status_code == 422


def test_fs_browser(admin, root, tmp_path):
    (root / "b10").mkdir()
    (root / "b2").mkdir()
    (root / ".secret").mkdir()
    make_image(root / "b2" / "x.jpg")
    make_image(root / "top.png")
    roots = admin.get("/api/fs/roots").json()
    assert roots == [{"path": os.path.realpath(root), "name": "root"}]
    listing = admin.get("/api/fs/browse", params={"path": str(root)}).json()
    assert listing["parent"] is None and listing["image_count"] == 1
    assert [e["name"] for e in listing["entries"]] == ["b2", "b10"]
    assert listing["entries"][0]["image_count"] == 1
    child = admin.get("/api/fs/browse", params={"path": listing["entries"][0]["path"]}).json()
    assert child["parent"] == os.path.realpath(root)
    assert admin.get("/api/fs/browse").json()["path"] == os.path.realpath(root)
    assert admin.get("/api/fs/browse", params={"path": str(tmp_path)}).status_code == 400
    assert admin.get("/api/fs/browse", params={"path": str(root / ".." / "data")}).status_code == 400
    assert admin.get("/api/fs/browse", params={"path": str(root / "missing")}).status_code == 404
