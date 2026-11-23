"""Project roles and the permission matrix (architecture.md section 5)."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from annotamate.server.errors import forbidden, not_found
from annotamate.server.models import Project, ProjectMember, User

EDIT_ROLES = ("annotator", "reviewer", "manager")
REVIEW_ROLES = ("reviewer", "manager")


@dataclass
class ProjectAccess:
    project: Project
    user: User
    role: str | None  # membership role; None for admins who are not members

    @property
    def effective_role(self) -> str:
        """Admins act as managers in every project."""
        return "manager" if self.user.is_admin else (self.role or "viewer")

    @property
    def can_edit(self) -> bool:
        return self.effective_role in EDIT_ROLES

    @property
    def can_review(self) -> bool:
        return self.effective_role in REVIEW_ROLES

    @property
    def can_manage(self) -> bool:
        return self.effective_role == "manager"

    @property
    def can_add_classes(self) -> bool:
        role = self.effective_role
        return role in REVIEW_ROLES or (role == "annotator" and self.project.annotators_can_add_classes)

    @property
    def can_delete(self) -> bool:
        return self.user.is_admin

    @property
    def restricted_annotator(self) -> bool:
        """Annotators limited to their own (or unassigned) images by ``restrict_to_assigned``."""
        return self.project.restrict_to_assigned and self.effective_role == "annotator"

    def permissions(self) -> dict[str, bool]:
        return {
            "can_edit": self.can_edit,
            "can_review": self.can_review,
            "can_manage": self.can_manage,
            "can_add_classes": self.can_add_classes,
            "can_delete": self.can_delete,
        }

    def require_edit(self) -> None:
        if not self.can_edit:
            raise forbidden("Your role in this project cannot edit annotations.")

    def require_review(self) -> None:
        if not self.can_review:
            raise forbidden("Only reviewers and managers can review images.")

    def require_manage(self) -> None:
        if not self.can_manage:
            raise forbidden("Only project managers can do this.")


def load_access(session: Session, user: User, project_id: int) -> ProjectAccess:
    """Project + the user's role; 404 for unknown projects and for non-members (admins see everything)."""
    project = session.get(Project, project_id)
    if project is None:
        raise not_found("Project not found.")
    role = session.scalar(
        select(ProjectMember.role).where(ProjectMember.project_id == project_id, ProjectMember.user_id == user.id)
    )
    if role is None and not user.is_admin:
        raise not_found("Project not found.")
    return ProjectAccess(project, user, role)
