# Annotamate 2: HTTP and WebSocket API (v1)

Backend (`annotamate/server`) and frontend (`web/src/lib/types.ts`) both implement **exactly** these shapes.
Field names are `snake_case` on the wire. Shapes are written as TypeScript.

## Conventions

* Base path: `{base_url}api` (e.g. `/api`). JSON in, JSON out, UTF-8.
* Timestamps: ISO 8601 UTC strings ending in `Z`, e.g. `"2026-11-23T10:15:00Z"`.
* IDs are integers unless stated otherwise. Box ids are strings (UUID v4).
* Auth: session cookie `annotamate_session` (set by login/setup).
* CSRF: every `POST/PUT/PATCH/DELETE` must send header `X-Annotamate-Client: web`. Missing → `403 {code:"csrf"}`.
* Errors always have this body (status code carries the class of error):

```ts
interface ApiError {
  detail: string            // human readable, safe to show in a toast
  code: string              // machine readable, see list below
  [extra: string]: unknown  // e.g. `current` for conflicts, `holder` for locks, `errors` for validation
}
```

| Status | code | When | Extra fields |
| --- | --- | --- | --- |
| 400 | `bad_request` | Semantically invalid input (e.g. wrong current password, workflow transition not allowed, `subdir` upload into a non-recursive project) | |
| 401 | `unauthenticated`, `invalid_credentials` | No / expired session; wrong username or password on login | |
| 403 | `forbidden`, `csrf` | Role does not allow it (also: `force: true` on a save by someone who is neither reviewer+ nor the lock holder); missing CSRF header | |
| 404 | `not_found` | Unknown id or not a member of the project (also unknown `/api/...` paths) | |
| 409 | `conflict` | Annotation `base_version` ≠ current version | `current: AnnotationDoc` |
| 409 | `in_use` | Deleting a class (`strategy=forbid`) that labels still use | `images: number` (images using it) |
| 409 | `readonly`, `exists`, `setup_done` | Read-only label file (also: the image shares its label file with an earlier image, or is the reserved YOLO name `classes`); duplicate; setup already done | |
| 413 | `too_large` | Request body over its limit: 2 MB for ordinary routes (`ANNOTAMATE_MAX_BODY_MB`), 64 KB for `PUT /api/me/settings`, `ANNOTAMATE_MAX_UPLOAD_REQUEST_MB` (1024) for the upload route, `ANNOTAMATE_MAX_UPLOAD_MB` (50) per uploaded file. Checked against `Content-Length` and again while the body streams in | |
| 422 | `validation_error` | Body/query validation failed | `errors: {loc: string[], msg: string}[]` |
| 423 | `locked` | Another user holds the image's edit lock | `holder: UserBrief` |
| 429 | `rate_limited` | Too many failed sign-ins: 10 per address and user name, and 30 per public address in total (`ANNOTAMATE_LOGIN_IP_LIMIT`), in 10 minutes | `retry_after: number` (seconds, also in `Retry-After`) |
| 500 | `write_failed` | The label file could not be written (disk full, permissions); nothing was changed | |
| 500 | `migration_incomplete` | A class delete/merge failed half-way and restoring the original label files failed too | `files: string[]` (paths whose content may be wrong; their `.bak` backups are kept next to them) |
| 500 | `internal_error` | Unexpected server error | |

Pagination:

* **Message-like lists** (project chat, DMs, project-wide comments) return `{ items, has_more }` with items in
  **ascending** id order (oldest first). The first request (no `before_id`) returns the newest `limit` items;
  to load older ones pass `before_id = items[0].id` (the oldest item you have). `has_more` says whether older
  items exist.
* **Feeds** (notifications, activity) return items **newest first** (descending ids). Load older ones with
  `before_id = items[items.length - 1].id` (again the oldest item you have).
* Image comments (`GET .../images/{iid}/comments`) are not paginated (ascending).
* Image lists use `offset/limit` and return `total`.

## Shared types

```ts
type Role = 'viewer' | 'annotator' | 'reviewer' | 'manager'
type ImageStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'rejected'
type LabelFormat = 'yolo' | 'voc' | 'coco'

interface UserBrief {
  id: number
  username: string
  display_name: string
  avatar_color: string        // "#RRGGBB"
}

interface User extends UserBrief {
  email: string | null
  is_admin: boolean
  is_active: boolean
  created_at: string
  last_seen_at: string | null
}

interface ProjectSettings {
  require_review: boolean               // default false
  restrict_to_assigned: boolean         // default false
  annotators_can_add_classes: boolean   // default true
  exif_mode: 'apply' | 'ignore'         // default 'apply'
  recursive: boolean                    // scan sub-folders; default false
}

interface ProjectClass {
  id: number          // stable id, used by boxes
  index: number       // 0-based position = YOLO class id = line in classes.txt
  name: string
  color: string       // "#RRGGBB"
}

type StatusCounts = Record<ImageStatus, number>

interface Permissions {
  can_edit: boolean           // edit annotations
  can_review: boolean
  can_manage: boolean         // settings, members, assign, rescan, upload, export, class rename/delete
  can_add_classes: boolean
  can_delete: boolean         // delete project (admin)
}

interface ProjectSummary {
  id: number
  name: string
  description: string
  label_format: LabelFormat
  image_count: number          // images present on disk (missing ones are not counted)
  missing_count: number        // images whose file disappeared (kept hidden, see POST .../prune-missing)
  status_counts: StatusCounts
  member_count: number
  my_role: Role | null        // null for admins who are not members (they act as manager)
  my_assigned_todo: number    // images assigned to me that are not done
  unread_chat: number
  archived: boolean
  indexing: boolean
  created_at: string
  updated_at: string
  members_preview: UserBrief[] // up to 5 members for project cards: managers, reviewers, annotators, viewers, by name
}

interface Member {
  user: UserBrief
  role: Role
  joined_at: string
  assigned_count: number
  done_count: number          // images whose last status change to done/review was by this user
  last_seen_at: string | null // last authenticated request of the user (null = never signed in)
}

interface Project extends ProjectSummary {
  image_dir: string           // absolute path on the server (shown to managers only; others get "")
  label_dir: string | null    // null = same folder as images
  settings: ProjectSettings
  classes: ProjectClass[]     // ordered by index
  members: Member[]
  permissions: Permissions
}

interface ImageItem {
  id: number
  filename: string            // basename
  rel_path: string            // path relative to image_dir, "/" separators
  position: number            // 0-based position in natural sort order of the whole project
  status: ImageStatus
  box_count: number
  class_ids: number[]         // ProjectClass ids present (deduplicated)
  assignee: UserBrief | null
  flagged: boolean
  comment_count: number       // unresolved + resolved, not deleted
  open_comment_count: number  // unresolved
  last_editor: UserBrief | null
  updated_at: string | null   // last annotation save or status change
}

interface ImageDetail extends ImageItem {
  width: number | null        // after EXIF handling; null if the file is unreadable
  height: number | null
  error: string | null        // e.g. "Cannot decode image"
  label_path: string          // path relative to the label folder, for display
  file_url: string            // path relative to base_url, no leading slash, with cache-busting "?v=<mtime_ns>",
                              // e.g. "api/projects/1/images/5/file?v=1732350000000000000"
}

interface Box {
  id: string                  // uuid
  class_id: number | null     // ProjectClass.id; null = unknown label
  raw_label: string | null    // original label when class_id is null, else null
  x1: number; y1: number; x2: number; y2: number   // image pixels, floats
  difficult?: boolean         // VOC flags, default false
  truncated?: boolean
}

interface AnnotationDoc {
  version: string | null      // null when no label file exists
  boxes: Box[]
  readonly_reason: string | null  // also set when the image shares its label file with an earlier image
                                  // ("... shares its label file with a.jpg ...") or is a YOLO image named `classes`
  updated_at: string | null
  updated_by: UserBrief | null
}

interface ChatMessage {
  id: number
  project_id: number
  user: UserBrief
  body: string                // "" when deleted
  image: { id: number; filename: string } | null
  mentions: number[]          // user ids
  created_at: string
  edited_at: string | null
  deleted: boolean
}

interface Comment {
  id: number
  project_id: number
  image_id: number
  user: UserBrief
  body: string
  pin: { x: number; y: number } | null
  resolved: boolean
  mentions: number[]
  created_at: string
  edited_at: string | null
  deleted: boolean
}

interface DirectMessage {
  id: number
  sender_id: number
  recipient_id: number
  body: string
  created_at: string
  read_at: string | null
}

interface Conversation {
  user: UserBrief
  last_message: DirectMessage
  unread_count: number
}

type NotificationType =
  | 'mention' | 'assignment' | 'review_approved' | 'review_rejected' | 'review_requested'
  | 'comment' | 'dm' | 'project_added'

interface Notification {
  id: number
  type: NotificationType
  actor: UserBrief | null
  project: { id: number; name: string } | null
  image: { id: number; filename: string } | null
  text: string                // server-rendered one-line summary
  created_at: string
  read_at: string | null
}

type ActivityType =
  | 'annotation_saved' | 'status_changed' | 'assigned' | 'flagged' | 'comment_added'
  | 'class_added' | 'class_updated' | 'class_deleted' | 'member_added' | 'member_updated' | 'member_removed'
  | 'images_uploaded' | 'project_created' | 'project_updated' | 'rescanned' | 'revision_restored'

interface Activity {
  id: number
  type: ActivityType
  user: UserBrief | null          // null for system entries (rescans)
  image: { id: number; filename: string } | null
  data: Record<string, unknown>   // shape depends on `type`, see "Activity data" below
  created_at: string
}
```

### Activity data

`Activity.data` per type (`image` is set for single-image entries, `null` for bulk/project entries).
Clients must tolerate missing keys (older entries) and ignore unknown ones.

| `type` | `image` | `data` |
| --- | --- | --- |
| `annotation_saved` | ✓ | `{box_count: number, saves: number}` (saves by one user on one image within 10 min are coalesced; `saves` counts them) |
| `status_changed` | ✓ | `{from: ImageStatus, to: ImageStatus, action: 'submit'\|'approve'\|'reject'\|'reopen', comment?: string /* reject reason, ≤200 chars */}` |
| `status_changed` | – | bulk: `{to: ImageStatus, count: number, action: 'set_status'}` |
| `assigned` | ✓ | `{assignee: UserBrief \| null, claimed?: true}` (`claimed`: an annotator took an unassigned image by saving it) |
| `assigned` | – | bulk: `{count, assignee: UserBrief \| null}`; distribute: `{count, distribution: {user: UserBrief, count: number}[]}` |
| `flagged` | ✓ / – | `{flagged: boolean}`; bulk adds `count` |
| `comment_added` | ✓ | `{comment_id: number, preview: string}` |
| `class_added` | – | `{class_id, name, color}` |
| `class_updated` | – | `{class_id, name /* current */, old_name? /* when renamed */, color? /* when recoloured */}` |
| `class_deleted` | – | `{class_id, name, strategy: 'forbid'\|'delete_boxes'\|'merge', merge_into?: number, merge_into_name?: string, rewritten_files: number}` |
| `member_added` | – | `{member: UserBrief, role: Role}` |
| `member_updated` | – | `{member: UserBrief, role: Role, previous_role: Role}` |
| `member_removed` | – | `{member: UserBrief, role: Role}` |
| `images_uploaded` | – | `{count: number}` |
| `project_created` | – | `{name: string}` |
| `project_updated` | – | `{changes: string[] /* changed field names */, values: {name?, archived?, require_review?, restrict_to_assigned?, annotators_can_add_classes?, exif_mode?, recursive?}}` (new values; `description` and `label_dir` are listed in `changes` only) |
| `rescanned` | – | `{added: number, removed: number, total: number}` (`user` is null) |
| `revision_restored` | ✓ | `{revision_id: number, box_count: number}` |

## Endpoints

### Meta

| Method & path | Auth | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/health` | none | | `{status: "ok", version: string}` |
| `GET /api/meta` | none | | `{version: string, app_name: "Annotamate", max_upload_mb: number}` |

### Auth and current user

| Method & path | Auth | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/auth/state` | none | | `{setup_required: boolean, setup_token_required: boolean, user: User \| null}`. `setup_token_required` is true while setup is open, unless the request comes straight from the server machine (a loopback address and no proxy headers such as `X-Forwarded-For`, `Forwarded`, `X-Real-IP` or `Via`). |
| `POST /api/auth/setup` | none, only when 0 users | `{username, display_name, password, setup_token?}` | `User` + cookie. Else `409 setup_done`. Requests that do not come straight from the server machine (see above) need the one-time `setup_token` the server prints in its log and console at start-up (missing/wrong → `422` on `body.setup_token`). Setup is atomic: of several concurrent requests exactly one succeeds, the others get `409 setup_done`. |
| `POST /api/auth/login` | none | `{username, password}` | `User` + cookie. Bad creds → `401 {code:"invalid_credentials"}` |
| `POST /api/auth/logout` | user | | `204` (cookie cleared) |
| `GET /api/me` | user | | `User` |
| `PATCH /api/me` | user | `{display_name?, email?, avatar_color?}` | `User` |
| `POST /api/me/password` | user | `{current_password, new_password}` | `204`; wrong current → `400`. Other sessions are revoked. |
| `GET /api/me/settings` | user | | `object` (free-form JSON owned by the frontend, `{}` by default) |
| `PUT /api/me/settings` | user | `object` (≤ 64 KB; larger bodies are refused with `413` before they are parsed) | the stored object |

Username rules: 3–32 chars, `[a-z0-9_.-]`, stored lowercase, unique. Password ≥ 8 chars.

### Users

| Method & path | Auth | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/users` | user | `?include_inactive=true` (admin only) | Admins: `(User & {online: boolean})[]`. Everyone else: `(UserBrief & {online: boolean})[]` only (no email, admin flag, activity or timestamps). Sorted by display_name |
| `POST /api/users` | admin | `{username, display_name, password, email?, is_admin?}` | `User` (`409 exists`) |
| `PATCH /api/users/{id}` | admin | `{display_name?, email?, is_admin?, is_active?}` | `User`. Cannot deactivate or demote yourself → `400` |
| `POST /api/users/{id}/password` | admin | `{new_password}` | `204`, revokes that user's sessions |

### Folder browser (project creation)

| Method & path | Auth | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/fs/roots` | admin | | `{path: string, name: string}[]` |
| `GET /api/fs/browse` | admin | `?path=` (absolute, inside a root) | `{path, parent: string \| null, image_count: number, entries: {name, path, image_count: number \| null}[]}` (directories only, natural-sorted; `parent` null at a root) |

### Projects

| Method & path | Auth | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/projects` | user | `?archived=false` | `ProjectSummary[]` sorted by name (member projects; admins see all). `archived=false` (default) returns **only active** projects, `archived=true` **only archived** ones. |
| `POST /api/projects` | admin | `{name, description?, image_dir, label_dir?: string \| null, label_format, classes?: string[], settings?: Partial<ProjectSettings>, members?: {user_id, role}[]}` | `Project` (creator added as manager). Indexing starts in the background (`indexing: true`). If `classes` is omitted, they are read from an existing `classes.txt` (or discovered from VOC/COCO files). |
| `GET /api/projects/{pid}` | member | | `Project` |
| `PATCH /api/projects/{pid}` | manager | `{name?, description?, label_dir?, settings?: Partial<ProjectSettings>, archived?}` | `Project` |
| `DELETE /api/projects/{pid}` | admin | | `204` (DB rows only; files on disk untouched) |
| `POST /api/projects/{pid}/rescan` | manager | | `202 {started: true}`; progress over WS (`project.indexing`). Adds new images (a new image with a label file starts as `done`); never changes the status of existing images; images whose file is gone get `missing` (hidden from lists, neighbours, counts, stats, exports, bulk actions and filters; comments, revisions and status are kept) and are restored when the file returns |
| `POST /api/projects/{pid}/prune-missing` | manager | | `{removed: number}`: permanently deletes the missing images (with their comments and revisions) |
| `GET /api/projects/{pid}/stats` | member | `?tz_offset=` (viewer's UTC offset in minutes, east positive, −840…840; default 0): `daily` covers the last 30 days of the viewer's calendar | `{status_counts: StatusCounts, images_total, boxes_total, class_counts: {class_id: number, boxes: number, images: number}[], per_user: {user: UserBrief, saves: number, boxes: number, submitted: number, approved: number, rejected: number, reviewed: number}[], daily: {date: "YYYY-MM-DD", saves: number, done: number}[] /* last 30 days */}` |
| `POST /api/projects/{pid}/upload` | manager | multipart `files[]` (the field name `files` is accepted too; ≤ 1000 files per request), optional `subdir` (relative folder; only for projects with `settings.recursive`, else `400`) | `{added: ImageItem[], skipped: {filename, reason}[]}` |
| `GET /api/projects/{pid}/export` | manager | `?format=yolo\|voc\|coco&scope=all\|done&include_images=false` | `application/zip` download. YOLO: `labels/*.txt`, `classes.txt`, `data.yaml`. VOC: `Annotations/*.xml`. COCO: single `annotations.json` (dataset-level, ids 1-based). With images: `images/...` |

### Members

| Method & path | Auth | Body | Response |
| --- | --- | --- | --- |
| `GET /api/projects/{pid}/members` | member | | `Member[]` |
| `POST /api/projects/{pid}/members` | manager | `{user_id, role}` | `Member` (`409 exists`); notifies the user (`project_added`) |
| `PATCH /api/projects/{pid}/members/{uid}` | manager | `{role}` | `Member`; cannot remove the last manager → `400` |
| `DELETE /api/projects/{pid}/members/{uid}` | manager (or self = leave) | | `204`; their assignments are cleared |

### Classes

| Method & path | Auth | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/projects/{pid}/classes` | member | | `ProjectClass[]` |
| `POST /api/projects/{pid}/classes` | manager, or annotator+ if `annotators_can_add_classes` | `{name, color?}` | `ProjectClass` (`409 exists`) |
| `PATCH /api/projects/{pid}/classes/{cid}` | manager | `{name?, color?}` | `ProjectClass` (VOC/COCO renames rewrite label files in the background) |
| `DELETE /api/projects/{pid}/classes/{cid}` | manager | `?strategy=forbid\|delete_boxes\|merge&merge_into={cid}` | `200 {rewritten_files: number}`; `forbid` (default) → `409 in_use` with `{images: number}` when any label uses it |

Class changes keep `classes.txt` in sync and broadcast `classes.updated`.

### Images

Common filter query (images list, neighbours, bulk `filter`):
`q` (case-insensitive substring of rel_path), `status` (comma list), `assignee` (`me` \| `none` \| user id),
`flagged` (`true`/`false`), `class_id` (contains class), `has_comments` (`open` \| `any`).
`sort`: `name` (default, natural) \| `updated` (newest first).

| Method & path | Auth | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/projects/{pid}/images` | member | filters + `offset` (0) + `limit` (100, max 500) | `{total: number, offset: number, items: ImageItem[]}` |
| `GET /api/projects/{pid}/images/{iid}` | member | | `ImageDetail`. `404` for a missing image. `error` is set when the image cannot be read, including when it exceeds the pixel budget (`ANNOTAMATE_MAX_IMAGE_MEGAPIXELS`, default 150) |
| `GET /api/projects/{pid}/images/{iid}/neighbors` | member | filters | `{prev_id: number \| null, next_id: number \| null, index: number /* 0-based within filter, -1 if excluded */, total: number}` |
| `GET /api/projects/{pid}/images/{iid}/file` | member | `?v=` ignored | image bytes, browser-safe (JPEG/PNG/WebP/GIF/BMP as-is unless re-encoding needed); `Cache-Control: private, max-age=31536000, immutable` when `v` present |
| `GET /api/projects/{pid}/images/{iid}/thumb` | member | `?size=256` (64–512) | WebP thumbnail (cached on disk) |
| `PATCH /api/projects/{pid}/images/{iid}` | see rules | `{flagged?: boolean, assignee_id?: number \| null}` | `ImageItem`. Flag: `can_edit`. Assign others: manager. Annotators may set `assignee_id` to themselves when unassigned, or to null when it is themselves. Assigning notifies the assignee. |
| `POST /api/projects/{pid}/images/{iid}/status` | see §6 of architecture | `{action: 'submit'\|'approve'\|'reject'\|'reopen', comment?: string}` | `ImageItem`; `reject` requires `comment` (also stored as an image comment); notifications for review results / review requests |
| `POST /api/projects/{pid}/images/bulk` | manager | `{image_ids?: number[], filter?: {...filters}, action: 'assign'\|'unassign'\|'flag'\|'unflag'\|'set_status'\|'distribute', assignee_id?: number, status?: ImageStatus, user_ids?: number[], limit?: number}` | `{updated: number}`. `distribute` splits the matched images (in natural order, up to `limit`) evenly between `user_ids`. One notification per assignee summarising the count. |

### Annotations

| Method & path | Auth | Body | Response |
| --- | --- | --- | --- |
| `GET /api/projects/{pid}/images/{iid}/annotation` | member | | `AnnotationDoc` |
| `PUT /api/projects/{pid}/images/{iid}/annotation` | `can_edit` (+ assignment rule) | `{base_version: string \| null, boxes: Box[], force?: boolean}` | `{version: string, updated_at, box_count, image: ImageItem, boxes: Box[]}` where `boxes` are the boxes as stored (clamped, rounded to the file format, tiny ones dropped, ids kept): exactly what a following `GET` returns. `409 conflict` + `current: AnnotationDoc` if `base_version` ≠ current version and not `force` (`force` allowed for reviewer+ or the lock holder). `409 readonly` (broken/polygon label file, unreadable image, an image that shares its label file with an earlier image of the folder, or the YOLO name `classes`). `423 locked` + `holder`. VOC and COCO saves patch the existing file: boxes that came from it keep fields this tool does not model (VOC `pose`, `occluded`, custom elements, `source`; COCO `attributes`, `iscrowd`, `score`, ids, `info`, `licenses`); new boxes are written in the standard shape. Box coordinates are clamped/normalised server-side; boxes smaller than 1px are dropped; unknown `class_id` → `422`. An empty `boxes` list writes an empty label file (a "background" image). |
| `GET /api/projects/{pid}/images/{iid}/revisions` | member | | `{id, user: UserBrief \| null, created_at, box_count, version}[]` newest first (max 50) |
| `GET /api/projects/{pid}/images/{iid}/revisions/{rid}` | member | | `{id, user, created_at, boxes: Box[]}` |
| `POST /api/projects/{pid}/images/{iid}/revisions/{rid}/restore` | `can_edit` | `{base_version}` | same as PUT |

### Image comments

| Method & path | Auth | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/projects/{pid}/images/{iid}/comments` | member | | `Comment[]` ascending |
| `POST /api/projects/{pid}/images/{iid}/comments` | member | `{body (1–4000), pin?: {x, y}}` | `Comment` |
| `PATCH /api/projects/{pid}/comments/{cid}` | author (body); any `can_edit` member (resolved) | `{body?, resolved?}` | `Comment` |
| `DELETE /api/projects/{pid}/comments/{cid}` | author or manager | | `204` (soft delete) |
| `GET /api/projects/{pid}/comments` | member | `?resolved=false&before_id=&limit=50` | `{items: (Comment & {image: {id, filename}})[], has_more}` (project-wide threads view) |

### Project chat

| Method & path | Auth | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/projects/{pid}/chat` | member | `?before_id=&limit=50` | `{items: ChatMessage[], has_more}` |
| `POST /api/projects/{pid}/chat` | member | `{body (1–4000), image_id?}` | `ChatMessage` |
| `PATCH /api/projects/{pid}/chat/{mid}` | author | `{body}` | `ChatMessage` |
| `DELETE /api/projects/{pid}/chat/{mid}` | author or manager | | `204` (soft delete; broadcasts `chat.updated`) |
| `POST /api/projects/{pid}/chat/read` | member | `{last_id}` | `204` |

### Direct messages

| Method & path | Auth | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/dm` | user | | `Conversation[]` newest first |
| `GET /api/dm/{user_id}` | user | `?before_id=&limit=50` | `{items: DirectMessage[], has_more}` |
| `POST /api/dm/{user_id}` | user | `{body (1–4000)}` | `DirectMessage` (recipient must be active, not self) |
| `POST /api/dm/{user_id}/read` | user | | `204` |

### Notifications

| Method & path | Auth | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/notifications` | user | `?unread=true&before_id=&limit=30` | `{items: Notification[] /* newest first */, has_more, unread_count}` |
| `POST /api/notifications/read` | user | `{ids?: number[], all?: boolean}` | `{unread_count}` |

### Activity

| Method & path | Auth | Query | Response |
| --- | --- | --- | --- |
| `GET /api/projects/{pid}/activity` | member | `?before_id=&limit=50&user_id=&image_id=` | `{items: Activity[] /* newest first */, has_more}` |

## WebSocket `/api/ws`

One connection per browser tab, authenticated by the session cookie; `Origin` must match the host.
Frames are JSON objects with a `type`. Unknown types are ignored.

Connection lifecycle and close codes:

* `Origin` mismatch: the handshake is refused (close `1008`).
* No valid session: the socket is accepted, receives `{type:'error', code:'unauthenticated'}` and is closed with
  `4401`. The same close code is used when the user is deactivated, their password is reset or they sign out
  elsewhere. Clients re-check `GET /api/auth/state` on `4401`, `4403` and `1008` and show the sign-in page if the
  session is gone; any other close is retried with backoff.
* `1013`: the client could not keep up (its outgoing queue overflowed); `1001`: the server is shutting down.
* Errors for individual frames never close the socket; they come back as `{type:'error', code, detail}` with
  `code` one of `bad_request`, `forbidden`, `not_found`, `internal_error`.

### Client → server

```ts
{ type: 'subscribe', project_id: number }          // join a project room (leaves the previous one)
{ type: 'unsubscribe' }
{ type: 'presence', image_id: number | null }       // which image this tab shows (in the subscribed project;
                                                    // ids of other projects are reported as null)
{ type: 'lock.acquire', image_id: number, force?: boolean }   // force: manager/admin take-over
{ type: 'lock.release', image_id: number }
{ type: 'typing', scope: 'chat' } | { type: 'typing', scope: 'dm', user_id: number }
{ type: 'ping' }                                    // every 20 s; renews this connection's locks and re-validates the
                                                    // session (expired -> `error unauthenticated`, close 4401)
```

### Server → client

```ts
{ type: 'hello', user_id: number, online_user_ids: number[] }
{ type: 'pong' }
{ type: 'user.online', user_id: number } | { type: 'user.offline', user_id: number }

{ type: 'presence.snapshot', project_id: number,
  users: { user: UserBrief, image_id: number | null, image_filename: string | null }[] }
{ type: 'presence.update', project_id: number, user: UserBrief, image_id: number | null,
  image_filename: string | null, left?: boolean }

{ type: 'lock.granted', image_id: number }
{ type: 'lock.denied', image_id: number, holder: UserBrief }
{ type: 'lock.revoked', image_id: number, by: UserBrief }          // someone (or the same user in another tab) took over
{ type: 'lock.expired', image_id: number }                         // to the holder only: the server's sweep expired the lock
                                                                   // (no ping for 60 s); re-acquire it or drop to read-only
{ type: 'lock.state', project_id: number, image_id: number, holder: UserBrief | null }  // broadcast to the room

{ type: 'image.updated', project_id: number, image: ImageItem, version?: string, by?: UserBrief }  // saves, status, assign, flag
{ type: 'images.bulk_updated', project_id: number, count: number }
{ type: 'classes.updated', project_id: number, classes: ProjectClass[] }
{ type: 'project.updated', project_id: number }
{ type: 'project.indexing', project_id: number, done: number, total: number, finished: boolean }
{ type: 'members.updated', project_id: number }

{ type: 'chat.message', message: ChatMessage }
{ type: 'chat.updated', message: ChatMessage }
{ type: 'comment.created', comment: Comment }
{ type: 'comment.updated', comment: Comment }
{ type: 'dm.message', message: DirectMessage }                     // to recipient and to sender's other tabs
{ type: 'dm.read', reader_id: number, sender_id: number, read_at: string, unread_count?: number }
{ type: 'notification', notification: Notification, unread_count: number }
{ type: 'typing', scope: 'chat', project_id: number, user: UserBrief } | { type: 'typing', scope: 'dm', user: UserBrief }
{ type: 'error', code: string, detail: string }
```

Room rules: project events go to every socket subscribed to that project; `dm.message` and `notification`
go to all sockets of the target user(s); `user.online/offline` go to everyone.

Ordering and semantics:

* `subscribe` is answered with `presence.snapshot`, immediately followed by one `lock.state` frame per edit lock
  currently held in the project. A snapshot therefore starts a fresh view: clients drop the locks they knew
  (they may have been released while the client was disconnected) and rebuild them from those frames.
* **One edit lock per connection.** Acquiring a lock releases any other lock the same connection holds
  (the room gets `lock.state` with `holder: null` for the released image).
* Locks belong to a connection. A second tab of the **same user** that asks for a lock it already holds elsewhere
  takes it over without `force`; the old tab gets `lock.revoked` with `by` = that same user (and should stop
  re-requesting it until the new holder lets go). A manager/admin `force` take-over works the same way for
  another user's lock.
* `dm.read` is sent when `POST /api/dm/{user_id}/read` marked something read: to the sender (read receipt for
  their messages to `reader_id`) and to the reader's own sockets, the latter with the reader's new notification
  `unread_count` (DM notifications from that sender are cleared together with the messages).
* A new DM replaces the sender's previous **unread** DM notification for the recipient (one summary per sender:
  "Alice sent you 3 messages"); clients drop the older one when the new `notification` arrives.

## Single-page app serving

Every non-API `GET` under the base URL that is not a file of the built SPA returns `index.html` (so deep links
and hard reloads such as `/p/1/annotate/5` work), with:

* `<base href="{base_url}">` injected at the top of `<head>` (assets are referenced relatively, `./assets/…`),
* `<script>window.__ANNOTAMATE__={"baseUrl":"{base_url}"}</script>` at `<!--annotamate:config-->`,
* a `Content-Security-Policy` whose `script-src` is `'self'` plus the SHA-256 hash of each inline script
  (no `'unsafe-inline'` for scripts), `Cache-Control: no-cache`.

Missing files under `assets/` are `404` (never the SPA shell). With `--base-url /x/`, `/x` redirects (`308`) to
`/x/` and `/` redirects (`307`) to `/x/`; the API lives at `/x/api` and the WebSocket at `/x/api/ws`.
