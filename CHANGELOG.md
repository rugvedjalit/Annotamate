# Changelog

All notable changes to Annotamate are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- First-run setup needs a one-time setup token (printed in the server log and the `annotamate serve`
  console) unless the request comes from the machine itself without proxy headers. Concurrent setups can no longer create
  two administrators. `docker-compose.yml` now publishes the port on `127.0.0.1` by default.
- `GET /api/users` returns only `id`, `username`, `display_name`, `avatar_color` and `online` to
  non-administrators (no email addresses or admin flags). Administrators keep the full record.
- Request bodies are limited (413 `too_large`): 2 MB for ordinary routes (`ANNOTAMATE_MAX_BODY_MB`),
  64 KB for user settings, and `ANNOTAMATE_MAX_UPLOAD_REQUEST_MB` (1024) for uploads. The nginx and
  Caddy examples allow large bodies on the upload path only.
- Dependency minimums exclude versions with published security advisories: Pillow 13.0,
  Starlette 1.3.1, h11 0.16 and python-multipart 0.0.34. Python 3.11 or newer is now required
  (3.10 reached its end of life in October 2026, and the patched Pillow and python-multipart
  releases no longer support it).
- Images above `ANNOTAMATE_MAX_IMAGE_MEGAPIXELS` (150) are refused when probed, uploaded or decoded;
  concurrent requests for the same thumbnail decode it once, and at most three full decodes run at
  the same time.
- Sign-in attempts are also limited per public address (30 failures in 10 minutes,
  `ANNOTAMATE_LOGIN_IP_LIMIT`; loopback and private addresses are exempt so a shared proxy address cannot
  lock everyone out), and password hashing
  runs at most four at a time.
- One edit lock per WebSocket connection, so a script cannot lock a whole project. The session is
  re-validated on every WebSocket `ping` (closed with 4401 when expired).
- `base_url` is validated at start-up and escaped where it is written into the page; the CSP
  `connect-src` is `'self'`; `classes.txt` is read and written with the same root confinement as
  label files; id lists in requests are bounded; restricted annotators can no longer flag images
  assigned to someone else; exports read label files under the project's label lock.

### Fixed

- Class delete/merge rewrites are all-or-nothing: every target is checked writable first (including
  the Windows read-only attribute), originals are backed up, already replaced files are restored if
  a later one fails, temporary files are always removed, and a journal in the data folder lets the
  server roll back an interrupted rewrite at the next start. If restoring fails too the API answers
  `500 migration_incomplete` with the affected files.
- Images that share a file stem (`a.jpg` and `a.png`; case is ignored on Windows and macOS) no longer overwrite
  each other's labels: the first owns the label file, the others are read-only with an explanation,
  uploads of colliding names are skipped, and in YOLO projects the name `classes` is reserved.
- A VOC/COCO class rename interrupted by a restart is resumed at start-up, and one that could not rewrite
  every file is retried; while it is pending, old
  names read as the renamed class and saves write the new name.
- VOC and COCO saves keep the fields the tool does not model (`pose`, `occluded`, custom elements,
  `source`, COCO `attributes`, `iscrowd`, `score`, ids, `info`, `licenses`). VOC `<path>` is the
  image name instead of the server's absolute path.
- A rescan no longer changes the status of images already in the project, and no longer deletes the
  history (comments, revisions, status) of files that are temporarily missing: they are hidden and
  come back with the file.

### Added

- `missing_count` on projects and `POST /api/projects/{id}/prune-missing`; project settings show the
  number of missing images and let managers remove them.
- WebSocket event `lock.expired`; the editor re-acquires an expired lock or becomes read-only.
- `setup_token_required` in `GET /api/auth/state`; the setup page asks for the token when needed.
- Settings `ANNOTAMATE_MAX_BODY_MB`, `ANNOTAMATE_MAX_UPLOAD_REQUEST_MB`,
  `ANNOTAMATE_MAX_IMAGE_MEGAPIXELS`, `ANNOTAMATE_LOGIN_IP_LIMIT`.
- Returning to an image whose save finished after leaving it no longer stalls autosave or reports a
  conflict with the user's own save.

## [2.0.0] - Unreleased

Annotamate 2 is a rewrite. The single-user desktop program becomes a self-hosted, multi-user web
application: a Python server that runs next to the datasets, and a browser interface for the whole
team. Label files keep the same formats and locations, so existing datasets and training pipelines
continue to work.

### Added

**Server and deployment**

- `annotamate serve`: a FastAPI server that provides the web interface, a REST API and a WebSocket
  in a single process. Runs on any headless machine; no Node.js is needed at run time.
- Projects are created on folders of the server, chosen with a folder browser that is limited to
  the configured dataset roots.
- SQLite database by default, PostgreSQL as an option (`annotamate[postgres]`); database migrations
  run automatically on start.
- Configuration through command-line flags and `ANNOTAMATE_*` environment variables, including
  hosting under a sub-path behind a reverse proxy (`ANNOTAMATE_BASE_URL`).
- Multi-architecture container image (`ghcr.io/rugvedjalit/annotamate`), Docker Compose file,
  hardened systemd unit, and Caddy and nginx examples.
- Health endpoint `GET /api/health`.
- The web interface works offline: fonts and icons are bundled, nothing is loaded from a CDN.

**Accounts and permissions**

- User accounts with passwords (argon2id), first-run administrator setup in the browser, and
  `annotamate user create | passwd | list` on the command line.
- Server administrators, and per-project roles: viewer, annotator, reviewer, manager.
- Project settings for the workflow: require review, restrict editing to assigned images, allow
  annotators to add classes.

**Annotating**

- A new annotator workspace: files panel, tool rail, canvas, inspector (labels, comments, history,
  info), review bar and status bar, with resizable and collapsible panels.
- A new canvas engine: zoom at the cursor, pan, crosshair, eight resize handles, multi-selection
  with marquee, nudging with the arrow keys, square and from-centre drawing, per-box lock and
  visibility.
- Class picker popover next to the new box; active class with `1`–`9` and `Q` / `E`.
- Copy and paste of boxes across images, duplicate, and *paste previous image's boxes*
  (`Mod+Shift+V`) for frame sequences.
- Autosave with a visible save state; navigation waits for the save to finish.
- Conflict detection: a save based on an outdated version of the label file is never applied
  silently.
- Revision history per image: the last 50 saves can be previewed and restored.
- Keyboard shortcuts for every action, rebindable per user, with conflict detection; command
  palette (`Mod+K`) and shortcut sheet (`?`).
- Dark and light themes, per-user preferences stored on the server.
- Lists and tables built for datasets with more than 100,000 images: virtualised rendering,
  server-side search, filters and paging.

**Teamwork**

- Image statuses (to do, in progress, review, done, rejected) and a review workflow: submit,
  approve, reject with a reason, reopen.
- Assignments: assign images to people, distribute them evenly, claim unassigned images; bulk
  actions on filtered images.
- Edit locks (one editor per image, with take-over for managers) and live presence (who is online,
  who is on which image).
- Project chat with image sharing, image comments with pins on the picture and resolve state,
  direct messages, `@mentions`, and notifications.
- Activity feed and statistics per project: status counts, class histogram, progress per member.
- Image upload from the browser (managers) and rescan of project folders.
- Export as a ZIP archive: YOLO with `data.yaml`, Pascal VOC, or a dataset-level COCO
  `annotations.json`; all images or only finished ones; with or without the images.

**Project**

- Continuous integration (lint, tests, wheel smoke test, end-to-end tests, container build and smoke test),
  release automation, and deployment, administrator and annotator guides.

### Changed

- **`annotamate` now starts the web application** on localhost and opens the browser. The desktop
  program is still available as `annotamate desktop` with the `desktop` extra
  (`pip install "annotamate[desktop]"`).
- Python 3.11 or newer is required.
- Packaging moved to `pyproject.toml`; the built web interface is shipped inside the wheel.
- Images are listed in natural order (`img2` before `img10`) instead of plain alphabetical order.
- EXIF orientation is a project setting and is **applied by default**, which matches OpenCV and
  Ultralytics. The desktop app ignored it; choose *ignore* for datasets that were annotated that way.
- Right-click no longer undoes.

### Fixed

Defects of the 1.x desktop app that the rewrite removes:

1. **Deleting a class no longer changes the meaning of other labels.** Classes have stable
   identities; deleting or merging a class rewrites the affected label files, and a class that is
   in use can only be deleted by merging it into another class or by explicitly deleting its boxes.
2. **Class colours are stored per class** from a 20-colour palette and can be edited, instead of
   being derived from the name (which made many classes share a colour and changed the colour on
   rename).
3. **No file operation can silently overwrite or orphan label files.** The server does not rename
   images, uploads never overwrite an existing file, and labels are always addressed through the
   project's label folder and format.
4. **Nothing is deleted from disk irrecoverably.** The web application does not delete images;
   deleting a project removes only its database records.
5. **Undo covers every change** (move, resize, class change, visibility, lock, paste and property
   edits, not only add and delete), and undo with an empty history does nothing.
6. **Boxes cannot leave the image.** Moving clamps the whole box and resizing clamps the edges,
   instead of the box being cut off silently on save.
7. **Small objects can be labelled.** The 5-pixel minimum is gone; any box of at least one image
   pixel is accepted, and clicks are told from drags in screen pixels.
8. **EXIF orientation is handled consistently**, so boxes on rotated phone photos line up at
   training time.
9. **Opening a file never changes the class list.** Labels with unknown classes are shown as such
   and written back unchanged, instead of being appended to `classes.txt` unnoticed.
10. **Label files are written atomically** (temporary file, flush to disk, rename), so a crash
    cannot leave a half-written file.
11. **Natural sort order** for file names in frame sequences.
12. **YOLO files with segmentation or oriented-box data are protected.** Such images open
    read-only with an explanation, instead of losing the extra columns on save.
13. **"No objects" and "not looked at" are different.** Every image has an explicit status, so an
    image that was submitted without boxes is distinguishable from one nobody has opened.

### Security

- Session cookies are `HttpOnly` and `SameSite=Lax` (and `Secure` when configured); only a hash of
  the session token is stored.
- Every state-changing API request requires a custom header (CSRF protection); no CORS; WebSocket
  origin check.
- Rate limiting of failed sign-ins.
- All file access is confined to the configured dataset roots, with symbolic links resolved.
- Strict Content-Security-Policy and related security headers.

### Upgrading from 1.x

There is nothing to convert. Create a project on the folder you annotated with the desktop app,
choose the same label format and label folder, and the existing labels and `classes.txt` are read
as they are. See the [deployment guide](docs/guides/deployment.md).

## [1.x]

The original Annotamate: a single-user desktop application built with Python and CustomTkinter.

- Bounding-box annotation with a rectangle tool and an edit tool (move and resize).
- Label files in YOLO (`.txt`), Pascal VOC (`.xml`) and COCO (`.json`) format, with `classes.txt`.
- Class manager with colour-coded classes; object list with per-box visibility.
- Zoom and pan, tuned for very large datasets.
- Undo and redo, bounding-box deletion, autosave.
- Configurable keyboard shortcuts, dark and light mode.
- Batch renaming of images.

This application is still shipped as `annotamate desktop` and receives no new features.

[Unreleased]: https://github.com/rugvedjalit/Annotamate/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/rugvedjalit/Annotamate/releases/tag/v2.0.0
