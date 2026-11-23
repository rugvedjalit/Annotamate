# Annotamate Web: plan

Status: accepted (2026-11-23). Implemented in Annotamate 2.0; the specifications that superseded the sketches
below are [`architecture.md`](architecture.md), [`api.md`](api.md) and [`frontend.md`](frontend.md).
UI mockup: [`docs/mockups/annotator.html`](mockups/annotator.html). Open it in a browser.

---

## 1. Goal

Turn Annotamate from a Tkinter desktop app into a **browser app served by a headless server**
(a GPU box, NAS, cloud VM or container). Images and label files stay on the server. People open a URL from any
machine to browse, view and annotate. Labels are written as the same files in the same places
(YOLO `.txt`, Pascal VOC `.xml`, COCO `.json` plus `classes.txt`), so training pipelines keep working and
labels made with the current desktop app still open.

**Not in v1** (the design leaves room for them): polygons/segmentation, keypoints, video, model-assisted
pre-labelling, S3/object storage.

---

## 2. What we must match (from `annotamate/main.py`)

| Area | Current behaviour |
| --- | --- |
| Dataset | Pick image dir + optional separate label dir; jump to most recently modified label file |
| Formats | YOLO / VOC / COCO (one JSON per image) read + write; `classes.txt` |
| Drawing & editing | Rect tool, edit tool (move, 4 corner handles), duplicate, delete, undo/redo, right-click undo |
| Classes | Add / delete / select, "use selected as default", Q/E cycle, modal class picker after drawing |
| Objects | Per-image object list, per-box visibility, show all |
| Files | Virtualised list (100k+), search, "unlabelled only", ✓ marks |
| View | Ctrl+wheel zoom at cursor, scroll pan, fit, viewport-only rendering |
| Saving | Autosave toggle, unsaved-changes prompt |
| File ops | Rename current image, batch rename, delete image |
| Settings | Configurable shortcuts (persisted), dark/light theme, closable/minimisable panels, usage guide |

---

## 3. Defects in the current app that the rewrite must not carry over

These came from reading the code. Each one is a "bugless" requirement for the web version.

| # | Current defect | Effect | Web version |
| --- | --- | --- | --- |
| 1 | Deleting a class shifts the IDs of every later class; boxes and label files on disk keep the old IDs | Labels silently change meaning | Class changes become dataset-level migrations. Rename and recolour are free. Reorder, merge and delete rewrite label files in a background job, after a preview. Deleting a class that is in use requires "merge into…" or "delete its boxes". |
| 2 | Class colour = `sum(ord(name)) % 10` | Many classes share colours; renaming changes the colour | Each class stores its colour. A 20-colour palette chosen to stay distinct on photos. Users can edit colours. |
| 3 | Rename / batch rename only move `<image>.txt` next to the image. They ignore the label dir and `.xml`/`.json`. On Linux `os.rename` silently overwrites an existing target partway through a batch. | Orphaned labels; **data loss on Linux** | Rename planner: dry-run table, collision detection, two-phase rename through temporary names, moves every label format in the label dir, journaled so an interrupted run can be rolled back. |
| 4 | Delete image is permanent and only removes the label in the current format | Unrecoverable; leftover label files | Image and all its labels move to `.annotamate/trash/` and can be restored. Admin only. |
| 5 | Undo only covers add/delete. Move, resize, class change and visibility can't be undone. With empty history, Ctrl+Z deletes the last loaded box. Right-click = undo. | Lost edits; accidental deletions | Command history covering every change. Right-click opens a context menu. |
| 6 | Boxes can be dragged past the image edge, then are clipped on save | Box silently shrinks | Moving clamps the whole box inside the image; resizing clamps edges. |
| 7 | Boxes smaller than 5 image px are rejected | Small objects can't be labelled | Click-vs-drag threshold measured in screen px; any box ≥ 1 image px is allowed. |
| 8 | EXIF orientation is ignored (PIL raw pixels). OpenCV-based loaders such as Ultralytics apply it. | Boxes are misaligned on rotated phone photos at training time | Per-dataset setting, default "apply" (matches the training loaders). Reported width/height are after orientation. |
| 9 | Loading VOC/COCO quietly appends unknown class names to the class list, and the next save rewrites `classes.txt` | Class list grows and reorders without anyone noticing | Unknown classes are shown in the UI ("3 boxes use unknown class 'truck': add / map to…"). |
| 10 | Label files are written in place, not atomically | A crash mid-write corrupts the file | Temp file + fsync + `os.replace`. |
| 11 | Lexicographic sort (`img10` before `img2`) | Confusing order for frame sequences | Natural sort by default; sort by modified time as an option. |
| 12 | YOLO lines with extra columns (segmentation polygons) are dropped on save | Data loss on YOLO-seg datasets | Unsupported content is detected; the image opens read-only with a banner explaining why. |
| 13 | An empty label file ("background image") looks the same as a labelled one | Can't tell "no objects" from "done" | Explicit status per image: unlabelled / done / background / flagged. |

---

## 4. Architecture

```
 Any laptop / browser                          Headless server
┌──────────────────────────┐  HTTPS + WSS  ┌──────────────────────────────────────────────┐
│ React SPA (static files) │◄────────────► │ optional reverse proxy (Caddy / nginx, TLS)  │
│  • canvas engine         │  or SSH tunnel│                     │                        │
│  • virtual file list     │               │ annotamate serve  (FastAPI + Uvicorn)        │
│  • image prefetch (LRU)  │               │  ├─ REST API   /api/…                        │
│  • history, keymap,      │               │  ├─ WebSocket  /api/ws  (presence, jobs)     │
│    save state machine    │               │  ├─ static SPA (bundled inside the wheel)    │
└──────────────────────────┘               │  ├─ auth & roles                             │
                                           │  └─ background jobs (index, export, rename,  │
                                           │     class migrations)                        │
                                           │  core/ (pure Python, no web deps)            │
                                           │  ├─ formats: YOLO · VOC · COCO               │
                                           │  ├─ dataset scanner / index                  │
                                           │  ├─ image service: size, EXIF, thumbs,       │
                                           │  │   transcode, tiles                        │
                                           │  └─ rename planner, atomic writer, trash     │
                                           │        │                      │              │
                                           │  Dataset folders        App state (disposable)│
                                           │  images + label files   SQLite + disk cache  │
                                           │  = SOURCE OF TRUTH      users, index, status │
                                           └──────────────────────────────────────────────┘
```

### Key decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Backend | **Python ≥ 3.10, FastAPI + Uvicorn** | ML servers already run Python. Reuses Pillow and the existing format logic. `pip install` needs no Node on the server. OpenAPI comes for free. |
| Frontend | **React + TypeScript (strict) + Vite** | Mature, large ecosystem, easy to hire for. |
| UI primitives | **Radix UI** (shadcn/ui-style components in the repo) + **Tailwind CSS** + **lucide** icons | Focus traps, menus, popovers and dialogs are where UI bugs usually come from; Radix handles them and is accessible. |
| State | **Zustand** (editor state), **TanStack Query** (server state), **TanStack Virtual** (100k-row lists), **Immer patches** (undo history) | Small and predictable; keeps editor state separate from cached server data. |
| Canvas | **Custom Canvas 2D engine** (~1.5k LOC). Not Konva or Fabric. | Annotation needs exact control of coordinate transforms, hit-testing and redraw scheduling. A small engine of pure functions is easier to test exhaustively than a scene-graph library. Two stacked canvases: image layer (redrawn only when the camera moves) and overlay (boxes, handles, crosshair; batched with `requestAnimationFrame`). Aware of `devicePixelRatio`. Images are decoded with `createImageBitmap`. |
| Source of truth | **Label files on disk**, same paths and formats as today | Existing pipelines and labels keep working. SQLite (in the server data dir, never inside the dataset) only holds the dataset registry, index cache, image status, users, sessions, settings and the activity log. Deleting it loses no annotations. |
| Image identity | The client only ever sends **integer IDs from the index**, never paths | Removes the path-traversal attack surface. |
| API contract | FastAPI OpenAPI → `openapi-typescript` types; CI fails if they're stale | Frontend and backend can't drift apart. |
| Offline | **No CDNs**. Fonts (Inter, JetBrains Mono) and icons are bundled. | Many headless servers are air-gapped. |

---

## 5. Deploying on a headless server

```bash
# A. Single user over SSH (no Node needed on the server)
pip install annotamate
annotamate serve --root /data/datasets           # binds 127.0.0.1:8765, prints a URL with a token
ssh -L 8765:localhost:8765 me@gpu-box             # on the laptop, then open the printed URL

# B. Team on a LAN / VPN
annotamate serve --root /data/datasets --host 0.0.0.0 --auth password
annotamate user add alice --role annotator

# C. Docker (image name illustrative)
docker run -d -p 8765:8765 \
  -v /data/datasets:/data -v annotamate-state:/var/lib/annotamate \
  -e PUID=$(id -u) -e PGID=$(id -g) annotamate/annotamate

# D. Local laptop: replaces the desktop app
annotamate                                        # serve on localhost and open the browser
```

- **Config precedence**: CLI flags > `ANNOTAMATE_*` env vars > `annotamate.toml`.
- **Safe defaults**: binds to loopback. Refuses to start on a non-loopback host with `--auth none`.
  Jupyter-style token URL by default. `--base-url /annotamate` for reverse proxies on a subpath.
  `--read-only` for review-only deployments. `--allow-file-ops` gates rename and delete.
- **Docker**: multi-stage build (Node LTS builds the SPA → `python:3.12-slim` runtime), runs as non-root.
  `PUID`/`PGID` make written label files belong to the host user (a common container bug otherwise).
  `HEALTHCHECK` on `/api/health`.
- **`deploy/`**: systemd unit, docker-compose, Caddy (automatic HTTPS) and nginx examples (WebSocket upgrade
  headers, timeouts).

---

## 6. Security

- **Auth modes**: `none` (loopback only) · `token` (default) · `password` (argon2id hashes, per-user accounts,
  HttpOnly `SameSite=Strict` session cookie, rate-limited login).
- **Roles**: `viewer` (browse and watch, read-only) · `annotator` (edit labels, add classes) ·
  `admin` (dataset config, class migrations, rename/delete, users).
- **Filesystem**: every path is resolved under the configured `--root` dirs with a `realpath` check, so
  symlink escapes are blocked. The server-side folder browser is admin-only and limited to those roots.
- **Web**: a custom header is required on every mutating request (CSRF), strict CSP with no inline scripts,
  no CORS by default, security headers.
- Browser uploads of images: Phase 3, admin-only, size-limited, written only inside a dataset root.

---

## 7. API (v1 sketch)

```
GET    /api/health
POST   /api/auth/login · POST /api/auth/logout · GET /api/me · GET|PUT /api/me/settings

GET    /api/datasets                       POST /api/datasets (admin)     PATCH|DELETE /api/datasets/{ds}
GET    /api/fs/browse?path=                (admin, limited to the roots)
GET    /api/datasets/{ds}/stats            progress, class histogram, per-user counts

GET    /api/datasets/{ds}/images?offset&limit&q&status&class&sort   → { total, items:[{id,name,status,n_boxes}] }
GET    /api/datasets/{ds}/images/{id}               metadata (w, h, orientation, label path, prev/next ids)
GET    /api/datasets/{ds}/images/{id}/file          original bytes or transcoded (ETag, long cache)
GET    /api/datasets/{ds}/images/{id}/thumb?s=256   WebP thumbnail (disk cache)
GET    /api/datasets/{ds}/images/{id}/annotation    → { version, boxes:[…], readonly_reason? }
PUT    /api/datasets/{ds}/images/{id}/annotation    If-Match: version → 200 {version} | 409 {current}
PATCH  /api/datasets/{ds}/images/{id}/status        background / flagged / reviewed

GET    /api/datasets/{ds}/classes
POST   /api/datasets/{ds}/classes                   add
PATCH  /api/datasets/{ds}/classes/{cid}             rename / recolour
POST   /api/datasets/{ds}/classes/migrate           reorder / merge / delete → job (with dry run)

POST   /api/datasets/{ds}/ops/rename                {id, new_name, dry_run}
POST   /api/datasets/{ds}/ops/batch-rename          {pattern, start, digits, dry_run} → plan | job
POST   /api/datasets/{ds}/ops/trash · /restore
POST   /api/datasets/{ds}/export                    {format: coco|yolo|voc, split?} → job → download

WS     /api/ws                                      presence, image status changes, job progress
```

Canonical box (client and server): `{ id: uuid, class_id, x1, y1, x2, y2 (float, image px), attrs: {difficult?, truncated?} }`.
Format conversion happens only on the server.

---

## 8. Data handling

- **Indexing**: `os.scandir`, natural sort, optional recursion. Cached in SQLite and invalidated by
  directory mtime; incremental rescans. Optional `watchfiles` watcher picks up images dropped in by other
  pipelines. Target: 100k files indexed in under 3 s on local SSD, with streamed progress on NFS.
- **Label status** comes from one listing of the label dir (as the desktop app does today) and is stored in the index.
- **Image dimensions** are read from the file header only (no decode) and cached.
- **Browser-incompatible images** (TIFF, 16-bit, CMYK) are transcoded on demand to PNG or WebP, with an
  LRU-capped disk cache. Supported inputs: png, jpg/jpeg, bmp, webp, tif/tiff.
- **Huge images** (configurable, default > 8k px on a side) are served as a tile pyramid (Phase 3).
- **Writes** are atomic. Optimistic concurrency: `version` = content hash. A stale `PUT` gets `409` plus the
  current content, and the UI offers "Reload theirs / Keep mine / Compare".
- **Formats**: YOLO keeps 6 decimals as today. VOC writes the real image depth. COCO keeps one JSON per image
  for compatibility, and "Export" builds a proper dataset-level `annotations.json`. YOLO export writes `data.yaml`.

---

## 9. The new UI

### Principles
1. **Canvas first.** Panels are resizable and collapsible; `\` toggles focus mode.
2. **Keyboard first.** Every action has a rebindable shortcut and shows up in the command palette.
3. **Never lose work.** Autosave by default, a visible save state, a conflict UI, and a `beforeunload`
   guard only while there are unsaved changes.
4. **No modals in the hot loop.** The class picker is a popover next to the new box.
5. **Accessible and consistent.** Radix primitives, visible focus rings, WCAG AA contrast,
   respects `prefers-reduced-motion`.
6. Dark theme by default (less glare during long sessions), light theme available. Desktop ≥ 1280 px is the
   main target; tablets get review/view mode.

### Screens
1. **Sign in.** Only shown in password mode; token links sign in automatically.
2. **Datasets home.** Cards with progress bar, image count, % done, class count, format badge, last
   activity and who's online. "New dataset" wizard: folder picker (limited to roots) → label folder
   (same / separate / create) → format → classes (import `classes.txt` / `data.yaml` / type them) → review.
3. **Annotator workspace.** See the mockup.
   - **Top bar**: dataset switcher with format badge · image navigator (‹ name · 4,213 / 102,480 ›, type to jump)
     · save-state pill · teammate avatars · command palette (Ctrl K) · theme · settings · account.
   - **Files panel** (left): virtualised list or thumbnail grid, server-side search, filter chips
     (All / Unlabelled / Done / Flagged / has class X), natural sort, status icons, teammate avatars on rows,
     progress footer.
   - **Tool rail**: Select (V), Box (W), Pan (H / hold Space), Fit (F), label and crosshair toggles, undo/redo.
   - **Canvas**: boxes with class-colour stroke and light fill, label chips, crosshair, floating toolbar
     on the selected box, class-picker popover, floating zoom control (−, %, +, Fit, 1:1), minimap when zoomed in.
   - **Inspector** (right): Classes (colour, name, per-image count, 1–9 hotkey, "ask for class after drawing"
     switch) · Objects (show/hide, lock, delete, hover to highlight on canvas, multi-select) · Properties
     (class, X/Y/W/H in image px, VOC difficult/truncated).
   - **Status bar**: cursor position in image px · image size · object count · label file path · autosave ·
     teammate locations · `?` shortcuts.
4. **Dataset dashboard.** Class histogram, progress per person, unlabelled count, export.
5. **Settings.** Shortcuts (press-to-capture, conflict detection, browser-reserved keys rejected, reset) ·
   Appearance (theme, fill opacity, stroke width, label size, crosshair) · Behaviour (autosave delay, ask
   for class vs use the active class, tool after drawing, wheel = zoom vs pan). Stored per user on the server.
6. **Admin.** Users and roles, tokens, dataset config.
7. **Command palette and shortcut sheet** (`?`).

### Interaction spec (this is what makes it bug-free)
- **Pointer Events with `setPointerCapture`**: drags keep working outside the canvas and never get stuck.
- **Click vs drag**: a 3 screen-px threshold.
- **Hit-test order**: handles of the selected box → the *smallest* box under the cursor (so nested boxes can be
  selected) → empty space. 8 handles (corners and edges), always 8 screen px, with a matching resize cursor.
- **Draw**: drag. Shift = square, Alt = from centre, Esc cancels. On release the class picker opens, unless
  "use active class" is on. Esc in the picker discards the box. Either way it's one undo step.
- **Edit**: moving is clamped inside the image; resizing clamps and normalises (x1 < x2). Arrow keys nudge by
  1 px (Shift = 10). Ctrl+D duplicates. Ctrl+C / Ctrl+V copy boxes across images. **Ctrl+Shift+V pastes the
  previous image's boxes**, a big time-saver for video frames.
- **Classes**: 1–9 sets the active class, or reassigns the selected boxes. Q/E cycle. X with a selection opens
  the picker (same muscle memory as today).
- **View**: wheel zooms at the cursor (configurable). Shift+wheel pans horizontally. Trackpad pinch and two-finger
  pan. Space-drag or middle-drag pans. F = fit, 0 = 100 %. Zoom range 5 %–4000 %. Above 100 % the image renders
  pixelated so edges are exact.
- **Navigation**: A/D and ←/→. Pending autosave is **awaited** before moving on; if saving fails, navigation is
  blocked with a toast and a retry button. The next/previous 3 images are prefetched and decoded. The URL
  tracks dataset and image (`/d/street-cams/i/4213`), so links can be shared and browser back/forward works.
- **History**: per-image command stack (Immer patches) covering create, move, resize, class, visibility, delete
  and paste. 200 steps, kept for the last 20 visited images.
- **Save state machine**: Saved → Unsaved → Saving (800 ms debounce, or on navigation / Ctrl+S) →
  Saved | Error (retry with backoff) | Conflict.
- **Keyboard**: one keymap service with scopes (canvas, picker, dialogs). It ignores events coming from inputs and
  contenteditable. Shortcuts the browser reserves (Ctrl+W/T/N/Tab) can't be bound.
- **Network**: offline banner. Edits stay in memory and IndexedDB until the server confirms them.
- **Error boundaries per panel**: a crash in the inspector never loses canvas edits.

### Visual system
- Tokens: neutral greys, one accent (violet `#7C6CFF`), semantic success/warning/danger colours, 4/8-pt spacing,
  6–10 px radii, Inter for UI text and JetBrains Mono for numbers and file names, 12.5–13 px base size
  (a dense pro tool).
- Boxes: 2 px stroke (configurable), ~16 % fill, label chip above the box (moves inside at the top edge).
  Selected = white stroke + accent halo + handles. Locked = dashed. Hidden = not drawn.
- Motion: 120–160 ms, turned off under reduced motion.

---

## 10. Repository layout

```
annotamate/                 Python package (pip install annotamate)
  cli.py                    annotamate [serve|user|desktop]
  core/                     pure logic, fully unit-tested, no web or Tk imports
    formats/{base,yolo,voc,coco}.py
    classes.py  dataset.py  images.py  fsutil.py  rename.py  natsort.py
  server/
    app.py  config.py  auth.py  db.py  jobs.py  ws.py
    routes/{datasets,images,annotations,classes,ops,export,fs,auth,me}.py
    static/                 built SPA (generated, git-ignored, shipped in the wheel)
  desktop/main.py           current Tk app, kept on top of core/ until the web app reaches parity
web/                        React + TS + Vite
  src/app/                  routes, providers, layout
  src/canvas/               camera.ts  renderer.ts  hittest.ts  geometry.ts  tools/{select,box,pan}.ts
  src/features/             annotator/ files/ classes/ inspector/ datasets/ settings/ auth/ palette/
  src/lib/                  api (generated types), keymap, history, save-machine, prefetch
  src/ui/                   design-system components (Radix + Tailwind)
tests/                      pytest (core, server, security)
web/tests/                  vitest (unit), playwright (e2e)
deploy/                     Dockerfile, docker-compose.yml, systemd, Caddyfile, nginx.conf
pyproject.toml              replaces setup.py; hatch build hook runs the SPA build
```

---

## 11. Quality and testing

- **Python**: ruff, pyright (strict on `core/` and `server/`), pytest.
  - Property tests (hypothesis): `load(save(boxes)) ≈ boxes` for every format.
  - Golden files, including labels written by the current desktop app.
  - Security suite: path traversal (`..`, encoded, symlinks), auth required off-loopback, role checks.
  - Rename planner: collisions, swap cycles (a→b, b→a), interrupted runs.
- **TypeScript**: strict mode, ESLint, Vitest on the pure modules: camera math, hit-testing, clamping,
  history, keymap, save state machine.
- **End-to-end (Playwright, Chromium + Firefox + WebKit)** against a real server and fixture datasets:
  draw → pick class → autosave → reload still shows it; move/resize/undo/redo; navigation waits for the save;
  two-browser conflict; viewer can't edit; keyboard-only flow; 100k-image list scroll; visual snapshots in both
  themes.
- **Performance budgets in CI**: index time for 100k files, list scroll frame time, first paint on image switch
  (< 100 ms with prefetch), 60 fps interaction with 500 boxes.
- **CI (GitHub Actions)**: lint → unit → build the wheel with the SPA → install the wheel in a clean container and
  smoke-test `annotamate serve` → e2e → build the Docker image.

---

## 12. Roadmap

Effort estimates assume one experienced developer. Parallel agents shorten Phase 1 noticeably.

**Phase 0: Foundations (~3–4 days)**
- Pull `core/` out of `main.py` (formats, classes, scanning, natural sort) with tests. The Tk app imports it and
  keeps working.
- `pyproject.toml`, `web/` scaffold, CI skeleton, OpenAPI → TS type generation.
- *Done when:* the format round-trip suite passes and the desktop app behaves as before.

**Phase 1: Web MVP, one user, parity plus fixes (~2–3 weeks)**
- Server: `serve`, token auth, config, dataset from CLI/config, index, image and thumbnail endpoints,
  versioned annotation GET/PUT, classes (add / rename / recolour), atomic writes, per-user settings.
- UI: app shell, annotator workspace (files panel, canvas engine, tools, inspector, status bar), class picker,
  autosave state machine, shortcut editor, themes, deep links, prefetch.
- Packaging: wheel with the bundled SPA, Dockerfile, SSH-tunnel quick start.
- *Done when:* everything in §2 except rename/delete works in the browser; defects 2, 5, 6, 7, 8, 10, 11
  and 12 are fixed; e2e passes.

**Phase 2: Multiple users and dataset operations (~2 weeks)**
- Password auth, roles, user admin; WebSocket presence and live status; conflict UI.
- Datasets home, setup wizard with server folder browser, dataset dashboard.
- Class migrations as jobs; rename and batch-rename planner; trash and restore; export (COCO dataset JSON,
  YOLO + `data.yaml`, VOC zip); image statuses (background / flagged / reviewed); command palette; thumbnail grid; copy/paste and
  paste-from-previous.
- *Done when:* every item in §3 is fixed and the two-user e2e scenarios pass.

**Phase 3: Scale and polish (~2 weeks)**
- Tile pyramid for huge images plus minimap; recursive datasets and train/val splits; review mode
  (approve / reject with a comment); activity log; admin image upload; installable PWA; performance hardening.

**Later**: polygons/keypoints, pre-labelling on the server GPU (YOLO / SAM), S3 storage.

---

## 13. Implementing with parallel agents

Contract first. Phase 0 and the OpenAPI schema and shared types are done by one agent. After that, the streams
below run in parallel in separate git worktrees:

| Stream | Scope | Model |
| --- | --- | --- |
| A. Core and formats | `core/`, format adapters, rename planner, property tests | Sonnet |
| B. Server and security | FastAPI app, auth/roles, jobs, WebSocket, packaging | Opus |
| C. Canvas engine | camera, renderer, hit-testing, tools, history | Opus |
| D. UI shell and panels | layout, files panel, inspector, dialogs, settings, theming | Sonnet |
| E. QA | Playwright e2e, fixture datasets, performance budgets | Sonnet |
| Review | independent correctness/security review of each stream before merge | Opus |

Merge order: A → B → C and D → E. The orchestrator integrates and owns any change to the contract.

---

## 14. Decisions

1. **Desktop app**: the web app is the primary product; `annotamate` with no arguments opens it locally.
   The Tk app stays available as `annotamate desktop` (optional `[desktop]` extra) for now.
2. **Who uses a server**: teams. Accounts, roles, edit locks, presence and messaging ship in 2.0
   (the original Phase 1 and Phase 2 were built together).
3. **EXIF orientation**: applied by default, as a per-project setting (`apply` / `ignore`).
4. **COCO storage**: one `.json` per image (compatible with existing labels) plus a dataset-level export.
5. **File operations over the web**: image rename and trash are not in 2.0; managers can upload images.
