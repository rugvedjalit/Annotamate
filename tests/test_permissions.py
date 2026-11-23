"""The role/permission matrix of architecture.md section 5."""

from __future__ import annotations

import pytest

from conftest import box, images_of

ROLES = ("viewer", "annotator", "reviewer", "manager", "admin")


@pytest.fixture
def team(client, admin, make_user, create_project, dataset):
    users = {role: make_user(role) for role in ("viewer", "annotator", "reviewer", "manager")}
    users["admin"] = make_user("admin2", "Second Admin", is_admin=True)  # admin who is not a member
    outsider = make_user("outsider")
    project = create_project(dataset, classes=["cat", "dog"],
                             members=[(users[r], r) for r in ("viewer", "annotator", "reviewer", "manager")])
    return project, users, outsider


def allowed(role: str, minimum: str) -> bool:
    return ROLES.index(role) >= ROLES.index(minimum)


@pytest.mark.parametrize("role", ROLES)
def test_read_access_for_everyone(team, role):
    project, users, _ = team
    user, pid = users[role], project["id"]
    image_id = images_of(user, pid)[0]["id"]
    for url in (f"/api/projects/{pid}", f"/api/projects/{pid}/images", f"/api/projects/{pid}/images/{image_id}",
                f"/api/projects/{pid}/images/{image_id}/annotation", f"/api/projects/{pid}/stats",
                f"/api/projects/{pid}/activity", f"/api/projects/{pid}/members", f"/api/projects/{pid}/classes",
                f"/api/projects/{pid}/images/{image_id}/file", f"/api/projects/{pid}/images/{image_id}/thumb",
                f"/api/projects/{pid}/chat", f"/api/projects/{pid}/comments"):
        assert user.get(url).status_code == 200, (role, url)
    assert user.post(f"/api/projects/{pid}/chat", json={"body": f"hi from {role}"}).status_code == 200
    assert user.post(f"/api/projects/{pid}/images/{image_id}/comments", json={"body": "note"}).status_code == 200


@pytest.mark.parametrize("role", ROLES)
def test_permissions_object(team, role):
    project, users, _ = team
    perms = users[role].get(f"/api/projects/{project['id']}").json()["permissions"]
    assert perms == {
        "can_edit": allowed(role, "annotator"),
        "can_review": allowed(role, "reviewer"),
        "can_manage": allowed(role, "manager"),
        "can_add_classes": allowed(role, "annotator"),
        "can_delete": role == "admin",
    }
    detail = users[role].get(f"/api/projects/{project['id']}").json()
    assert detail["my_role"] == (None if role == "admin" else role)
    assert (detail["image_dir"] != "") == allowed(role, "manager")


def test_non_members_get_404(team):
    project, _, outsider = team
    pid = project["id"]
    assert outsider.get(f"/api/projects/{pid}").status_code == 404
    assert outsider.get(f"/api/projects/{pid}/images").json()["code"] == "not_found"
    assert outsider.post(f"/api/projects/{pid}/chat", json={"body": "x"}).status_code == 404
    assert outsider.get("/api/projects").json() == []
    assert outsider.get("/api/projects/9999").status_code == 404


@pytest.mark.parametrize("role", ROLES)
def test_edit_and_submit(team, role):
    project, users, _ = team
    user, pid = users[role], project["id"]
    cat = project["classes"][0]["id"]
    image_id = images_of(user, pid)[0]["id"]
    put = user.put(f"/api/projects/{pid}/images/{image_id}/annotation",
                   json={"base_version": None, "boxes": [box(cat, 1, 1, 20, 20)]})
    assert (put.status_code == 200) == allowed(role, "annotator"), put.text
    if put.status_code != 200:
        assert put.status_code == 403 and put.json()["code"] == "forbidden"
    submit = user.post(f"/api/projects/{pid}/images/{image_id}/status", json={"action": "submit"})
    assert (submit.status_code == 200) == allowed(role, "annotator")
    flag = user.patch(f"/api/projects/{pid}/images/{image_id}", json={"flagged": True})
    assert (flag.status_code == 200) == allowed(role, "annotator")


@pytest.mark.parametrize("role", ROLES)
def test_claim_and_assign(team, role):
    project, users, _ = team
    user, pid = users[role], project["id"]
    images = images_of(user, pid)
    claim = user.patch(f"/api/projects/{pid}/images/{images[0]['id']}", json={"assignee_id": user.id})
    if role == "admin":
        assert claim.status_code == 400  # admins who are not members cannot be assignees
    else:
        assert (claim.status_code == 200) == allowed(role, "annotator"), claim.text
    other = users["reviewer"] if role != "reviewer" else users["annotator"]
    assign_other = user.patch(f"/api/projects/{pid}/images/{images[1]['id']}", json={"assignee_id": other.id})
    assert (assign_other.status_code == 200) == allowed(role, "manager")
    bulk = user.post(f"/api/projects/{pid}/images/bulk", json={"filter": {}, "action": "flag"})
    assert (bulk.status_code == 200) == allowed(role, "manager")


@pytest.mark.parametrize("role", ROLES)
def test_review_actions(team, role, admin):
    project, users, _ = team
    pid = project["id"]
    image_id = images_of(admin, pid)[0]["id"]
    admin.patch(f"/api/projects/{pid}", json={"settings": {"require_review": True}})
    assert users["annotator"].post(f"/api/projects/{pid}/images/{image_id}/status",
                                   json={"action": "submit"}).json()["status"] == "review"
    response = users[role].post(f"/api/projects/{pid}/images/{image_id}/status", json={"action": "approve"})
    assert (response.status_code == 200) == allowed(role, "reviewer")


@pytest.mark.parametrize("role", ROLES)
def test_class_permissions(team, role, admin):
    project, users, _ = team
    user, pid = users[role], project["id"]
    add = user.post(f"/api/projects/{pid}/classes", json={"name": f"new-{role}"})
    assert (add.status_code == 200) == allowed(role, "annotator"), add.text
    cat = project["classes"][0]["id"]
    rename = user.patch(f"/api/projects/{pid}/classes/{cat}", json={"color": "#123456"})
    assert (rename.status_code == 200) == allowed(role, "manager")
    if add.status_code == 200:
        delete = user.delete(f"/api/projects/{pid}/classes/{add.json()['id']}")
        assert (delete.status_code == 200) == allowed(role, "manager")


def test_annotators_can_add_classes_setting(team, admin):
    project, users, _ = team
    pid = project["id"]
    admin.patch(f"/api/projects/{pid}", json={"settings": {"annotators_can_add_classes": False}})
    assert users["annotator"].post(f"/api/projects/{pid}/classes", json={"name": "x"}).status_code == 403
    assert users["reviewer"].post(f"/api/projects/{pid}/classes", json={"name": "y"}).status_code == 200
    perms = users["annotator"].get(f"/api/projects/{pid}").json()["permissions"]
    assert perms["can_add_classes"] is False


@pytest.mark.parametrize("role", ROLES)
def test_management_actions(team, role, make_user):
    project, users, _ = team
    user, pid = users[role], project["id"]
    expected = allowed(role, "manager")
    assert (user.patch(f"/api/projects/{pid}", json={"description": role}).status_code == 200) == expected
    assert (user.post(f"/api/projects/{pid}/rescan").status_code == 202) == expected
    assert (user.get(f"/api/projects/{pid}/export").status_code == 200) == expected
    newcomer = make_user(f"new{role}")
    assert (user.post(f"/api/projects/{pid}/members", json={"user_id": newcomer.id, "role": "viewer"})
            .status_code == 200) == expected
    upload = user.post(f"/api/projects/{pid}/upload", files={"files[]": ("x.png", b"not an image", "image/png")})
    assert (upload.status_code == 200) == expected


@pytest.mark.parametrize("role", ROLES)
def test_delete_project_admin_only(team, role):
    project, users, _ = team
    response = users[role].delete(f"/api/projects/{project['id']}")
    assert (response.status_code == 204) == (role == "admin")


def test_admin_only_endpoints(team, admin):
    _, users, _ = team
    manager = users["manager"]
    assert manager.get("/api/fs/roots").status_code == 403
    assert manager.get("/api/fs/browse").status_code == 403
    assert manager.post("/api/projects", json={"name": "x", "image_dir": "/", "label_format": "yolo"}) \
        .status_code == 403
    assert manager.patch(f"/api/users/{users['viewer'].id}", json={"is_admin": True}).status_code == 403


def test_restrict_to_assigned(team, admin):
    project, users, _ = team
    pid = project["id"]
    admin.patch(f"/api/projects/{pid}", json={"settings": {"restrict_to_assigned": True}})
    annotator, reviewer = users["annotator"], users["reviewer"]
    first, second, _third = images_of(admin, pid)
    admin.patch(f"/api/projects/{pid}/images/{first['id']}", json={"assignee_id": reviewer.id})
    blocked = annotator.put(f"/api/projects/{pid}/images/{first['id']}/annotation",
                            json={"base_version": None, "boxes": []})
    assert blocked.status_code == 403
    assert annotator.post(f"/api/projects/{pid}/images/{first['id']}/status",
                          json={"action": "submit"}).status_code == 403
    # unassigned images are claimed on first save
    saved = annotator.put(f"/api/projects/{pid}/images/{second['id']}/annotation",
                          json={"base_version": None, "boxes": []})
    assert saved.status_code == 200
    assert saved.json()["image"]["assignee"]["id"] == annotator.id
    # reviewers are not restricted
    assert reviewer.put(f"/api/projects/{pid}/images/{second['id']}/annotation",
                        json={"base_version": saved.json()["version"], "boxes": []}).status_code == 200


def test_annotator_assignment_rules(team):
    project, users, _ = team
    pid = project["id"]
    annotator, reviewer = users["annotator"], users["reviewer"]
    image = images_of(annotator, pid)[0]
    url = f"/api/projects/{pid}/images/{image['id']}"
    assert annotator.patch(url, json={"assignee_id": annotator.id}).json()["assignee"]["id"] == annotator.id
    assert reviewer.patch(url, json={"assignee_id": reviewer.id}).status_code == 403  # already assigned
    assert reviewer.patch(url, json={"assignee_id": None}).status_code == 403  # not theirs
    assert annotator.patch(url, json={"assignee_id": None}).json()["assignee"] is None
    assert users["manager"].patch(url, json={"assignee_id": users["viewer"].id}).status_code == 400


def test_restricted_annotator_cannot_flag_images_assigned_to_others(team, admin):
    project, users, _ = team
    pid = project["id"]
    admin.patch(f"/api/projects/{pid}", json={"settings": {"restrict_to_assigned": True}})
    annotator, reviewer = users["annotator"], users["reviewer"]
    first, second, _third = images_of(admin, pid)
    admin.patch(f"/api/projects/{pid}/images/{first['id']}", json={"assignee_id": reviewer.id})
    refused = annotator.patch(f"/api/projects/{pid}/images/{first['id']}", json={"flagged": True})
    assert refused.status_code == 403
    assert annotator.patch(f"/api/projects/{pid}/images/{second['id']}", json={"flagged": True}).status_code == 200
    assert reviewer.patch(f"/api/projects/{pid}/images/{first['id']}", json={"flagged": True}).status_code == 200


def test_id_lists_are_bounded(team):
    project, users, _ = team
    pid = project["id"]
    admin_like = users["reviewer"]
    too_many = list(range(5001))
    assert admin_like.post(f"/api/projects/{pid}/images/bulk",
                           json={"image_ids": too_many, "action": "flag"}).status_code == 422
    assert admin_like.post("/api/notifications/read", json={"ids": too_many}).status_code == 422
