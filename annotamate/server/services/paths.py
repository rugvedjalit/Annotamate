"""Where a project's images, label files and ``classes.txt`` live, with every path checked against the roots."""

from __future__ import annotations

import os
import posixpath

from annotamate.core.classes import CLASSES_FILENAME
from annotamate.core.formats import EXTENSIONS
from annotamate.core.fsutil import OutsideRootError, is_inside, resolve_inside
from annotamate.server.config import Settings
from annotamate.server.errors import ApiError, bad_request
from annotamate.server.models import Project


def inside_roots(settings: Settings, path: str) -> bool:
    return any(is_inside(root, path) for root in settings.roots)


def resolve_in_roots(settings: Settings, path: str, *, what: str = "Folder") -> str:
    """Real path of a client-supplied absolute folder, which must lie inside one of the configured roots."""
    if not path or "\x00" in path:
        raise bad_request(f"{what} path is required.")
    path = os.path.expanduser(path.strip())
    if not os.path.isabs(path):
        raise bad_request(f"{what} must be an absolute path.")
    for root in settings.roots:
        try:
            return resolve_inside(root, path)
        except OutsideRootError:
            continue
    raise bad_request(f"{what} is outside the folders this server may access.")


class ProjectPaths:
    """Resolves files of one project. All results are real paths inside the project's folders."""

    def __init__(self, settings: Settings, project: Project) -> None:
        self.settings = settings
        self.project = project
        self.image_root = project.image_dir
        self.label_root = project.label_dir or project.image_dir
        self.extension = EXTENSIONS[project.label_format]

    def check(self) -> None:
        """The project's folders must still be inside the configured roots (roots can change between runs)."""
        for folder in {self.image_root, self.label_root}:
            if not inside_roots(self.settings, folder):
                raise ApiError(403, "forbidden", "The project folder is outside the folders this server may access.")

    def image_file(self, rel_path: str) -> str:
        try:
            return resolve_inside(self.image_root, rel_path)
        except OutsideRootError:
            raise ApiError(403, "forbidden", "The image resolves outside the project folder.") from None

    def label_rel(self, rel_path: str) -> str:
        """Label path relative to the label folder: same sub-folder and stem as the image."""
        stem = posixpath.splitext(rel_path)[0]
        return stem + self.extension

    def label_file(self, rel_path: str) -> str:
        """Real path of the label file; raises ``OutsideRootError`` when it resolves outside the label folder."""
        return resolve_inside(self.label_root, self.label_rel(rel_path))

    def classes_file(self) -> str:
        return os.path.join(self.label_root, CLASSES_FILENAME)
