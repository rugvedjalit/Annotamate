"""SQLAlchemy ORM models. Label files on disk stay the source of truth for annotations."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy import (
    false as sa_false,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


def utcnow() -> datetime:
    """Naive UTC timestamp (what every DateTime column stores)."""
    return datetime.now(UTC).replace(tzinfo=None)


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(32), unique=True)
    display_name: Mapped[str] = mapped_column(String(64))
    email: Mapped[str | None] = mapped_column(String(254))
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    avatar_color: Mapped[str] = mapped_column(String(7))
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime)


class UserSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    last_used_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(255))


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text, default="")
    image_dir: Mapped[str] = mapped_column(Text)
    label_dir: Mapped[str | None] = mapped_column(Text)
    label_format: Mapped[str] = mapped_column(String(8))
    require_review: Mapped[bool] = mapped_column(Boolean, default=False)
    restrict_to_assigned: Mapped[bool] = mapped_column(Boolean, default=False)
    annotators_can_add_classes: Mapped[bool] = mapped_column(Boolean, default=True)
    exif_mode: Mapped[str] = mapped_column(String(8), default="apply")
    recursive: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    #: Set when an index pass completed; ``None`` makes the server index the project again at start-up.
    indexed_at: Mapped[datetime | None] = mapped_column(DateTime)


class ProjectMember(Base):
    __tablename__ = "project_members"

    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    role: Mapped[str] = mapped_column(String(16))
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ProjectClass(Base):
    __tablename__ = "project_classes"
    __table_args__ = (
        UniqueConstraint("project_id", "name"),
        Index("ix_project_classes_project_position", "project_id", "position"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str] = mapped_column(String(7))


class Image(Base):
    __tablename__ = "images"
    __table_args__ = (
        UniqueConstraint("project_id", "rel_path"),
        Index("ix_images_project_sort", "project_id", "sort_index"),
        # Visible images of a project by status / by assignee, in list order (filters and per-project counts).
        Index("ix_images_project_missing_status_sort", "project_id", "missing", "status", "sort_index"),
        Index("ix_images_project_missing_assignee_sort", "project_id", "missing", "assignee_id", "sort_index"),
        Index("ix_images_project_updated", "project_id", "updated_at"),
        Index("ix_images_project_label_key", "project_id", "label_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    rel_path: Mapped[str] = mapped_column(Text)
    filename: Mapped[str] = mapped_column(String(255))
    #: Casefolded path without extension: images with the same key share one label file.
    label_key: Mapped[str] = mapped_column(Text, default="", server_default="")
    #: The file disappeared from disk; kept (soft-deleted) so comments, revisions and status survive.
    missing: Mapped[bool] = mapped_column(Boolean, default=False, server_default=sa_false())
    sort_index: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="todo")
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    flagged: Mapped[bool] = mapped_column(Boolean, default=False)
    has_label: Mapped[bool] = mapped_column(Boolean, default=False)
    box_count: Mapped[int] = mapped_column(Integer, default=0)
    #: Boxes whose label matches no project class (re-counted when classes are added).
    unknown_count: Mapped[int] = mapped_column(Integer, default=0)
    last_editor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    #: Who last moved the image to ``review``/``done`` by submitting it (credited in member stats).
    done_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_at: Mapped[datetime | None] = mapped_column(DateTime)
    comment_count: Mapped[int] = mapped_column(Integer, default=0)
    open_comment_count: Mapped[int] = mapped_column(Integer, default=0)


class PendingRename(Base):
    """A VOC/COCO class rename whose label-file rewrite has not finished (resumed at start-up).

    Until it is cleared, label files may still hold ``old_name``; readers map it onto the renamed class.
    """

    __tablename__ = "pending_renames"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    old_name: Mapped[str] = mapped_column(String(100))
    new_name: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ImageClassCount(Base):
    """How many boxes of each class an image has (drives class filters and statistics)."""

    __tablename__ = "image_class_counts"

    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"), primary_key=True)
    class_id: Mapped[int] = mapped_column(
        ForeignKey("project_classes.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    count: Mapped[int] = mapped_column(Integer)


class Revision(Base):
    __tablename__ = "revisions"
    __table_args__ = (Index("ix_revisions_image_id_id", "image_id", "id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    version: Mapped[str] = mapped_column(String(16))
    box_count: Mapped[int] = mapped_column(Integer)
    #: Boxes as saved: ``[{id, class_id, raw_label, label, x1, y1, x2, y2, difficult, truncated}]``.
    boxes: Mapped[list[dict[str, Any]]] = mapped_column(JSON)


class Comment(Base):
    __tablename__ = "comments"
    __table_args__ = (
        Index("ix_comments_image_id_id", "image_id", "id"),
        Index("ix_comments_project_id_id", "project_id", "id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    image_id: Mapped[int] = mapped_column(ForeignKey("images.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    body: Mapped[str] = mapped_column(Text)
    pin_x: Mapped[float | None] = mapped_column(Float)
    pin_y: Mapped[float | None] = mapped_column(Float)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    mentions: Mapped[list[int]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        Index("ix_chat_messages_project_id_id", "project_id", "id"),
        Index("ix_chat_messages_image_id", "image_id"),  # deleting an image clears its references
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    body: Mapped[str] = mapped_column(Text)
    image_id: Mapped[int | None] = mapped_column(ForeignKey("images.id", ondelete="SET NULL"))
    mentions: Mapped[list[int]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)


class ChatRead(Base):
    """Read marker per project and user (also works for admins who are not members)."""

    __tablename__ = "chat_reads"

    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    last_read_id: Mapped[int] = mapped_column(Integer, default=0)


class DirectMessage(Base):
    __tablename__ = "direct_messages"
    __table_args__ = (
        Index("ix_direct_messages_pair", "sender_id", "recipient_id", "id"),
        Index("ix_direct_messages_inbox", "recipient_id", "read_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    recipient_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    read_at: Mapped[datetime | None] = mapped_column(DateTime)


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_user_id_id", "user_id", "id"),
        Index("ix_notifications_user_read", "user_id", "read_at"),
        Index("ix_notifications_image_id", "image_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(32))
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    image_id: Mapped[int | None] = mapped_column(ForeignKey("images.id", ondelete="SET NULL"))
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    read_at: Mapped[datetime | None] = mapped_column(DateTime)


class Activity(Base):
    __tablename__ = "activity"
    __table_args__ = (
        Index("ix_activity_project_id_id", "project_id", "id"),
        Index("ix_activity_project_user", "project_id", "user_id", "id"),
        Index("ix_activity_project_image", "project_id", "image_id", "id"),
        Index("ix_activity_project_type", "project_id", "type", "created_at"),
        Index("ix_activity_image_id", "image_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(32))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    image_id: Mapped[int | None] = mapped_column(ForeignKey("images.id", ondelete="SET NULL"))
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    #: Aggregation helpers for statistics (not part of the API shape).
    action: Mapped[str | None] = mapped_column(String(16))
    subject_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    count: Mapped[int] = mapped_column(Integer, default=1)
