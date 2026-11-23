"""Request and response models. Field names and shapes follow ``docs/api.md`` exactly."""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from annotamate.server.security import MIN_PASSWORD_LENGTH

Role = Literal["viewer", "annotator", "reviewer", "manager"]
ImageStatus = Literal["todo", "in_progress", "review", "done", "rejected"]
LabelFormat = Literal["yolo", "voc", "coco"]
ExifMode = Literal["apply", "ignore"]
Color = Annotated[str, StringConstraints(pattern=r"^#[0-9a-fA-F]{6}$")]
FiniteFloat = Annotated[float, Field(allow_inf_nan=False)]

ROLES: tuple[str, ...] = ("viewer", "annotator", "reviewer", "manager")
STATUSES: tuple[str, ...] = ("todo", "in_progress", "review", "done", "rejected")
USERNAME_RE = re.compile(r"^[a-z0-9_.-]{3,32}$")
MAX_BODY = 4000
MAX_IDS = 5000  # upper bound for id lists in requests


def _username(value: str) -> str:
    value = value.strip().lower()
    if not USERNAME_RE.match(value):
        raise ValueError("must be 3-32 characters using a-z, 0-9, '_', '.' or '-'")
    return value


def _password(value: str) -> str:
    if len(value) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"must be at least {MIN_PASSWORD_LENGTH} characters")
    if len(value) > 1024:
        raise ValueError("is too long")
    return value


#: Characters that change how text around them is shown without being visible: bidirectional overrides,
#: embeddings, isolates and marks, zero-width spaces, word joiner, BOM, soft hyphen. In names they enable
#: spoofing (``Ada\u200b`` looks like ``Ada``; U+202E reverses what follows). Zero-width (non-)joiners are kept:
#: emoji sequences and several scripts need them.
INVISIBLE_CHARS = frozenset("\u061c\u200b\u200e\u200f\u202a\u202b\u202c\u202d\u202e"
                            "\u2060\u2066\u2067\u2068\u2069\ufeff\u00ad")


def strip_invisible(value: str) -> str:
    """``value`` without control characters and the invisible formatting characters above."""
    return "".join(ch for ch in value if ch not in INVISIBLE_CHARS and (ch >= " " or ch in "\t\n") and ch != "\x7f")


def _display_name(value: str) -> str:
    value = " ".join(strip_invisible(value).split())
    if not 1 <= len(value) <= 64:
        raise ValueError("must be 1-64 characters")
    return value


def _project_name(value: str | None) -> str | None:
    if value is None:
        return None
    value = " ".join(strip_invisible(value).split())
    if not value:
        raise ValueError("is required")
    return value


def _email(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) > 254 or not re.match(r"^[^@\s]+@[^@\s]+$", value):
        raise ValueError("is not a valid e-mail address")
    return value


def _message_body(value: str) -> str:
    value = value.strip()
    if not 1 <= len(value) <= MAX_BODY:
        raise ValueError(f"must be 1-{MAX_BODY} characters")
    return value


class Model(BaseModel):
    model_config = ConfigDict(extra="ignore")


# ---------------------------------------------------------------- shared response types


class UserBrief(Model):
    id: int
    username: str
    display_name: str
    avatar_color: str


class User(UserBrief):
    email: str | None
    is_admin: bool
    is_active: bool
    created_at: str
    last_seen_at: str | None


class UserBriefWithOnline(UserBrief):
    online: bool


class UserWithOnline(User):
    online: bool


class ProjectSettings(Model):
    require_review: bool = False
    restrict_to_assigned: bool = False
    annotators_can_add_classes: bool = True
    exif_mode: ExifMode = "apply"
    recursive: bool = False


class ProjectSettingsPatch(Model):
    require_review: bool | None = None
    restrict_to_assigned: bool | None = None
    annotators_can_add_classes: bool | None = None
    exif_mode: ExifMode | None = None
    recursive: bool | None = None


class ProjectClass(Model):
    id: int
    index: int
    name: str
    color: str


class StatusCounts(Model):
    todo: int = 0
    in_progress: int = 0
    review: int = 0
    done: int = 0
    rejected: int = 0


class Permissions(Model):
    can_edit: bool
    can_review: bool
    can_manage: bool
    can_add_classes: bool
    can_delete: bool


class ProjectSummary(Model):
    id: int
    name: str
    description: str
    label_format: LabelFormat
    image_count: int
    #: Images whose file disappeared from disk (kept hidden until they return or a manager removes them).
    missing_count: int = 0
    status_counts: StatusCounts
    member_count: int
    my_role: Role | None
    my_assigned_todo: int
    unread_chat: int
    archived: bool
    indexing: bool
    created_at: str
    updated_at: str
    members_preview: list[UserBrief]


class Member(Model):
    user: UserBrief
    role: Role
    joined_at: str
    assigned_count: int
    done_count: int
    last_seen_at: str | None


class Project(ProjectSummary):
    image_dir: str
    label_dir: str | None
    settings: ProjectSettings
    classes: list[ProjectClass]
    members: list[Member]
    permissions: Permissions


class ImageRef(Model):
    id: int
    filename: str


class ImageItem(Model):
    id: int
    filename: str
    rel_path: str
    position: int
    status: ImageStatus
    box_count: int
    class_ids: list[int]
    assignee: UserBrief | None
    flagged: bool
    comment_count: int
    open_comment_count: int
    last_editor: UserBrief | None
    updated_at: str | None


class ImageDetail(ImageItem):
    width: int | None
    height: int | None
    error: str | None
    label_path: str
    file_url: str


class Box(Model):
    id: str
    class_id: int | None
    raw_label: str | None
    x1: float
    y1: float
    x2: float
    y2: float
    difficult: bool = False
    truncated: bool = False


class AnnotationDoc(Model):
    version: str | None
    boxes: list[Box]
    readonly_reason: str | None
    updated_at: str | None
    updated_by: UserBrief | None


class SaveResult(Model):
    version: str
    updated_at: str | None
    box_count: int
    image: ImageItem
    boxes: list[Box]


class RevisionSummary(Model):
    id: int
    user: UserBrief | None
    created_at: str
    box_count: int
    version: str


class RevisionDetail(Model):
    id: int
    user: UserBrief | None
    created_at: str
    boxes: list[Box]


class Pin(Model):
    x: FiniteFloat
    y: FiniteFloat


class ChatMessage(Model):
    id: int
    project_id: int
    user: UserBrief
    body: str
    image: ImageRef | None
    mentions: list[int]
    created_at: str
    edited_at: str | None
    deleted: bool


class Comment(Model):
    id: int
    project_id: int
    image_id: int
    user: UserBrief
    body: str
    pin: Pin | None
    resolved: bool
    mentions: list[int]
    created_at: str
    edited_at: str | None
    deleted: bool


class CommentWithImage(Comment):
    image: ImageRef


class DirectMessage(Model):
    id: int
    sender_id: int
    recipient_id: int
    body: str
    created_at: str
    read_at: str | None


class Conversation(Model):
    user: UserBrief
    last_message: DirectMessage
    unread_count: int


class ProjectRef(Model):
    id: int
    name: str


class Notification(Model):
    id: int
    type: Literal["mention", "assignment", "review_approved", "review_rejected", "review_requested", "comment", "dm",
                  "project_added"]
    actor: UserBrief | None
    project: ProjectRef | None
    image: ImageRef | None
    text: str
    created_at: str
    read_at: str | None


class Activity(Model):
    id: int
    type: str
    user: UserBrief | None
    image: ImageRef | None
    data: dict[str, Any]
    created_at: str


# ---------------------------------------------------------------- envelopes


class Health(Model):
    status: str
    version: str


class Meta(Model):
    version: str
    app_name: str
    max_upload_mb: int


class AuthState(Model):
    setup_required: bool
    #: True while the first-run setup needs ``setup_token`` (non-loopback client, no account yet).
    setup_token_required: bool = False
    user: User | None


class ChatPage(Model):
    items: list[ChatMessage]
    has_more: bool


class CommentPage(Model):
    items: list[CommentWithImage]
    has_more: bool


class DirectMessagePage(Model):
    items: list[DirectMessage]
    has_more: bool


class NotificationPage(Model):
    items: list[Notification]
    has_more: bool
    unread_count: int


class UnreadCount(Model):
    unread_count: int


class ActivityPage(Model):
    items: list[Activity]
    has_more: bool


class ImageList(Model):
    total: int
    offset: int
    items: list[ImageItem]


class Neighbors(Model):
    prev_id: int | None
    next_id: int | None
    index: int
    total: int


class ClassCount(Model):
    class_id: int
    boxes: int
    images: int


class UserStats(Model):
    user: UserBrief
    saves: int
    boxes: int
    submitted: int
    approved: int
    rejected: int
    reviewed: int


class DailyStats(Model):
    date: str
    saves: int
    done: int


class Stats(Model):
    status_counts: StatusCounts
    images_total: int
    boxes_total: int
    class_counts: list[ClassCount]
    per_user: list[UserStats]
    daily: list[DailyStats]


class Skipped(Model):
    filename: str
    reason: str


class UploadResult(Model):
    added: list[ImageItem]
    skipped: list[Skipped]


class BulkResult(Model):
    updated: int


class RescanResult(Model):
    started: bool


class PruneResult(Model):
    removed: int


class ClassDeleteResult(Model):
    rewritten_files: int


class FsRoot(Model):
    path: str
    name: str


class FsEntry(Model):
    name: str
    path: str
    image_count: int | None


class FsBrowse(Model):
    path: str
    parent: str | None
    image_count: int
    entries: list[FsEntry]


# ---------------------------------------------------------------- requests


class SetupIn(Model):
    username: str
    display_name: str
    password: str
    setup_token: str | None = None

    _u = field_validator("username")(_username)
    _p = field_validator("password")(_password)
    _d = field_validator("display_name")(_display_name)


class LoginIn(Model):
    username: Annotated[str, StringConstraints(max_length=256)]
    password: Annotated[str, StringConstraints(max_length=1024)]


class MePatch(Model):
    display_name: str | None = None
    email: str | None = None
    avatar_color: Color | None = None

    _d = field_validator("display_name")(lambda v: None if v is None else _display_name(v))
    _e = field_validator("email")(_email)


class PasswordChange(Model):
    current_password: Annotated[str, StringConstraints(max_length=1024)]
    new_password: str

    _p = field_validator("new_password")(_password)


class UserCreate(Model):
    username: str
    display_name: str
    password: str
    email: str | None = None
    is_admin: bool = False

    _u = field_validator("username")(_username)
    _p = field_validator("password")(_password)
    _d = field_validator("display_name")(_display_name)
    _e = field_validator("email")(_email)


class UserPatch(Model):
    display_name: str | None = None
    email: str | None = None
    is_admin: bool | None = None
    is_active: bool | None = None

    _d = field_validator("display_name")(lambda v: None if v is None else _display_name(v))
    _e = field_validator("email")(_email)


class AdminPassword(Model):
    new_password: str

    _p = field_validator("new_password")(_password)


class MemberIn(Model):
    user_id: int
    role: Role


class MemberPatch(Model):
    role: Role


class ProjectCreate(Model):
    _n = field_validator("name")(_project_name)
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    description: Annotated[str, StringConstraints(max_length=4000)] = ""
    image_dir: Annotated[str, StringConstraints(min_length=1, max_length=4096)]
    label_dir: Annotated[str, StringConstraints(max_length=4096)] | None = None
    label_format: LabelFormat
    classes: Annotated[list[str], Field(max_length=1000)] | None = None
    settings: ProjectSettingsPatch | None = None
    members: Annotated[list[MemberIn], Field(max_length=1000)] | None = None


class ProjectPatch(Model):
    _n = field_validator("name")(_project_name)
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] | None = None
    description: Annotated[str, StringConstraints(max_length=4000)] | None = None
    label_dir: Annotated[str, StringConstraints(max_length=4096)] | None = None
    settings: ProjectSettingsPatch | None = None
    archived: bool | None = None


class ClassCreate(Model):
    name: str
    color: Color | None = None


class ClassPatch(Model):
    name: str | None = None
    color: Color | None = None


class ImagePatch(Model):
    flagged: bool | None = None
    assignee_id: int | None = None


class StatusActionIn(Model):
    action: Literal["submit", "approve", "reject", "reopen"]
    comment: Annotated[str, StringConstraints(max_length=MAX_BODY)] | None = None


class ImageFilterIn(Model):
    q: str | None = None
    status: str | Annotated[list[str], Field(max_length=len(STATUSES))] | None = None
    assignee: str | int | None = None
    flagged: bool | None = None
    class_id: int | None = None
    has_comments: Literal["open", "any"] | None = None
    sort: Literal["name", "updated"] = "name"


class BulkIn(Model):
    image_ids: Annotated[list[int], Field(max_length=MAX_IDS)] | None = None
    filter: ImageFilterIn | None = None
    action: Literal["assign", "unassign", "flag", "unflag", "set_status", "distribute"]
    assignee_id: int | None = None
    status: ImageStatus | None = None
    user_ids: Annotated[list[int], Field(max_length=MAX_IDS)] | None = None
    limit: Annotated[int, Field(ge=1)] | None = None


class BoxIn(Model):
    id: Annotated[str, StringConstraints(max_length=64)] | None = None
    class_id: int | None = None
    raw_label: Annotated[str, StringConstraints(max_length=200)] | None = None
    x1: FiniteFloat
    y1: FiniteFloat
    x2: FiniteFloat
    y2: FiniteFloat
    difficult: bool = False
    truncated: bool = False


class AnnotationPut(Model):
    base_version: str | None = None
    boxes: Annotated[list[BoxIn], Field(max_length=20000)]
    force: bool = False


class RestoreIn(Model):
    base_version: str | None = None


class CommentCreate(Model):
    body: str
    pin: Pin | None = None

    _b = field_validator("body")(_message_body)


class CommentPatch(Model):
    body: str | None = None
    resolved: bool | None = None

    _b = field_validator("body")(lambda v: None if v is None else _message_body(v))


class ChatCreate(Model):
    body: str
    image_id: int | None = None

    _b = field_validator("body")(_message_body)


class ChatPatch(Model):
    body: str

    _b = field_validator("body")(_message_body)


class ChatReadIn(Model):
    last_id: int


class DirectMessageCreate(Model):
    body: str

    _b = field_validator("body")(_message_body)


class NotificationsReadIn(Model):
    ids: Annotated[list[int], Field(max_length=MAX_IDS)] | None = None
    all: bool = False
