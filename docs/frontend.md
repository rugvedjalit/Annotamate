# Annotamate 2: frontend specification

Stack, already installed in `web/package.json` (do not add heavy dependencies without a reason):
React 19, TypeScript (strict, `noUncheckedIndexedAccess`), Vite 8, Tailwind CSS 4 (`@tailwindcss/vite`),
`radix-ui` (unified Radix primitives package), `lucide-react`, `@tanstack/react-query`, `@tanstack/react-virtual`,
`zustand`, `react-router` (v8), `sonner`, `cmdk`, `clsx` + `tailwind-merge` + `class-variance-authority`,
`@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`, Vitest + Testing Library, Playwright.

Path alias: `@/` → `web/src/`. Build output goes to `annotamate/server/static` (served by the Python server).
Dev: `npm run dev` (port 5173) proxies `/api` (HTTP + WS) to `http://127.0.0.1:8765`.

## 1. Source layout

```
web/src/
  main.tsx                    bootstraps fonts, CSS, QueryClient, Router, Toaster
  app/                        router.tsx, providers.tsx, RequireAuth, layouts
  styles/index.css            Tailwind import + design tokens (CSS variables) for dark and light
  lib/
    types.ts                  API types, copied 1:1 from docs/api.md
    api.ts                    fetch wrapper: base URL, credentials, CSRF header, ApiError class, JSON
    endpoints.ts              typed functions per endpoint (getProjects(), saveAnnotation(), ...)
    queryKeys.ts              TanStack Query keys
    realtime.ts               WebSocket client: auto-reconnect with backoff, ping every 20 s, typed events, resubscribe
    imageCache.ts             fetch → createImageBitmap, LRU (8 entries), prefetch neighbours, abort on navigation
    keymap.ts                 shortcut definitions, parsing ("Mod+Shift+V"), matching, conflict detection
    settings.ts               user preferences schema + defaults, persisted via /api/me/settings (debounced)
    format.ts                 relative time, numbers, file sizes
    utils.ts                  cn() (clsx + tailwind-merge), misc
  stores/
    session.ts                current user, setup state
    realtime.ts               online users, project presence, image locks, indexing and class-migration progress,
                              typing indicators
    ui.ts                     theme, panel sizes/visibility, chat drawer open, command palette open
  components/
    ui/                       design-system primitives (Button, IconButton, Input, Textarea, Select, Switch, Checkbox,
                              Dialog, AlertDialog, Popover, DropdownMenu, ContextMenu, Tooltip, Tabs, Badge, Avatar,
                              AvatarStack, Kbd, Spinner, Skeleton, ScrollArea, Progress, EmptyState, Field/Label)
    brand/Logo.tsx            wordmark/mark using /brand assets, picks dark/light variant
    AppShell.tsx, TopBar.tsx, UserMenu.tsx, NotificationsMenu.tsx, CommandPalette.tsx, PresenceAvatars.tsx,
    ConfirmDialog.tsx, ErrorBoundary.tsx, MentionTextarea.tsx (@username autocomplete), MessageBody.tsx (renders mentions/links)
  features/
    auth/                     LoginPage, SetupPage
    projects/                 ProjectsPage, NewProjectDialog (+ FolderBrowser), ProjectPage (overview dashboard),
                              ProjectSettingsPage (General, Classes, Members, Workflow, Danger zone; the latter offers removing `missing_count` images), ImagesTable (bulk assign)
    annotator/                AnnotatorPage, FilesPanel, ToolRail, Inspector (Classes, Objects, Properties, Comments, History),
                              ClassPicker, FloatingBoxToolbar, ZoomControl, StatusBar, ReviewBar, useAnnotationDoc,
                              useImageLock, useAnnotatorKeys
    chat/                     ChatPanel (project chat drawer), MessageList, Composer
    messages/                 MessagesPage (direct messages: conversation list + thread)
    notifications/            NotificationList
    activity/                 ActivityFeed
    admin/                    UsersPage (create, edit, deactivate, reset password)
    account/                  AccountPage (profile, avatar colour, password, preferences, keyboard shortcuts editor)
  canvas/                     annotation canvas engine (separate module, see §6). Import only from "@/canvas".
```

## 2. Routes

| Path | Page | Notes |
| --- | --- | --- |
| `/setup` | SetupPage | only when `setup_required`; asks for the setup token when `setup_token_required` |
| `/login` | LoginPage | `?next=` redirect |
| `/` | ProjectsPage | cards: progress bar by status, my assigned count, unread chat, members, format badge; admin "New project" |
| `/p/:projectId` | ProjectPage | overview: stats, per-member progress, class histogram, activity feed, members with presence, "Continue annotating" |
| `/p/:projectId/images` | ImagesTable | virtualised table with filters, multi-select, bulk assign/distribute/flag/status (managers) |
| `/p/:projectId/annotate/:imageId?` | AnnotatorPage | the workspace (mockup); without imageId → first image matching "assigned to me & not done", else first todo |
| `/p/:projectId/settings/:tab?` | ProjectSettingsPage | managers |
| `/messages/:userId?` | MessagesPage | DMs |
| `/admin/users` | UsersPage | admins |
| `/account/:tab?` | AccountPage | everyone |

`RequireAuth` loads `/api/auth/state`; redirects to `/setup` or `/login`. A `401` from any request clears the session and
redirects to `/login?next=…`. Router basename = `window.__ANNOTAMATE__?.baseUrl ?? '/'` (the server injects
`<script>window.__ANNOTAMATE__={"baseUrl":"/x/"}</script>` at `<!--annotamate:config-->` in index.html).

## 3. Design system

Brand colours come from the logo (`web/public/brand/*`): blue `#2B6CA3`, bright blue `#3D8FD6`, orange `#F28A2E`,
green `#5FB37F`. The UI is neutral greys + **brand blue as the accent**, orange for attention (unread badges,
"needs review"), green for success.

Tokens (CSS variables on `:root` for light and `.dark` for dark; Tailwind v4 `@theme inline` maps them to utilities
such as `bg-panel`, `text-muted`, `border-line`, `bg-accent`):

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg` | `#0e1014` | `#f4f6f9` | app background |
| `--canvas` | `#090b0e` | `#e9edf2` | annotation canvas backdrop |
| `--panel` | `#14171c` | `#ffffff` | panels, top bar |
| `--panel-2` | `#1a1e24` | `#f6f8fa` | inputs, cards on panels |
| `--hover` | `#20252d` | `#eef1f5` | hover rows |
| `--line` | `#252a32` | `#e2e6ec` | borders |
| `--fg` | `#e7e9ee` | `#16181d` | text |
| `--muted` | `#8a93a3` | `#5b6472` | secondary text |
| `--dim` | `#5c6472` | `#8a93a3` | tertiary text, placeholders |
| `--accent` | `#3d8fd6` | `#2b6ca3` | primary actions, selection, focus ring |
| `--accent-fg` | `#ffffff` | `#ffffff` | text on accent |
| `--accent-soft` | `rgba(61,143,214,.16)` | `rgba(43,108,163,.10)` | selected rows, chips |
| `--warn` | `#f28a2e` | `#d9731a` | attention |
| `--ok` | `#22c55e` | `#15803d` | success |
| `--danger` | `#ef4444` | `#dc2626` | destructive |

Status colours: todo `--dim`, in_progress `#3d8fd6`, review `#f28a2e`, done `#22c55e`, rejected `#ef4444`.
Typography: Inter Variable 13px base (dense pro tool), JetBrains Mono Variable for numbers/file names. Radius 6–10 px.
Focus: 2px `--accent` ring on `:focus-visible` everywhere. Motion 120–160 ms; respect `prefers-reduced-motion`.
Default theme: dark; `system` and `light` available (stored in settings and `localStorage` for first paint).
Class palette (20 colours, used when a class is created without a colour):
`#3b82f6 #f97316 #22c55e #eab308 #a855f7 #ec4899 #14b8a6 #ef4444 #84cc16 #06b6d4 #f59e0b #8b5cf6 #10b981 #e11d48 #0ea5e9 #d946ef #65a30d #fb7185 #6366f1 #facc15`.

## 4. Annotator workspace (see docs/mockups/annotator.html, recoloured to the brand palette)

* **Top bar**: logo · project switcher (name + format badge) · image navigator (prev / "filename" / "n / total" in the
  current filter / next; click to type a number or name) · save-state pill · presence avatars · chat toggle (unread badge)
  · notifications bell · command palette button · user menu.
* **Files panel** (left, resizable 220–420, collapsible): search, filter chips (All, Mine, Todo, In progress, Review,
  Rejected, Done, Flagged, Has open comments), sort, virtualised rows (status icon, name, box count, assignee avatar,
  avatars of people currently on that image, comment badge), footer progress. Rows load in pages of 200 via
  `useInfiniteQuery`-like windowing keyed by offset.
* **Tool rail**: Select (V), Box (W), Pan (H / hold Space), Fit (F), labels toggle (L), crosshair toggle (C),
  comments pins toggle, undo/redo.
* **Canvas** (from `@/canvas`): image, boxes, label chips, crosshair, handles, floating box toolbar (class, duplicate,
  lock, delete) positioned from `boxScreenRect`, zoom control (−, %, +, Fit, 1:1), class picker popover after drawing.
* **Inspector** (right, resizable 260–420, collapsible), tabs: **Labels** (Classes with colour, per-image count,
  1–9 hotkeys, active class, "Ask for class after drawing" switch; Objects list with show/hide, lock, delete, hover
  highlight, click select; Properties of selection: class select, X/Y/W/H numeric inputs in px, VOC difficult/truncated)
  · **Comments** (image thread, add with optional pin placed by clicking the canvas, resolve) · **History**
  (revisions list with author/time/box count, preview + restore) · **Info** (path, size, label path, assignee
  with assign/claim, status, flag, activity for this image).
* **Review bar** (bottom of canvas when relevant): status badge, `Submit` (Mod+Enter) / `Approve` / `Reject…`
  (dialog with required reason) / `Reopen`, depending on permissions and status.
* **Status bar**: cursor px, image size, objects count, label path, autosave state, who else is here.
* **Lock banner**: "Alice is editing this image. You can view and comment." (+ "Take over" for managers).
* **Chat drawer** (right overlay, 360 px) usable from every project page. In the annotator it takes the inspector's
  place, so the canvas and the review bar are never covered.

## 5. Behaviour rules (non-negotiable, these are the "bug-free" guarantees)

1. **Saving.** `useAnnotationDoc(projectId, imageId)` owns boxes, version, dirty flag, undo/redo and the save state
   machine: `saved → dirty → saving → saved | error | conflict`. Autosave 800 ms after the last change
   (configurable; can be turned off in preferences, then Mod+S saves). Navigation (next/prev/jump/route change)
   **awaits** the pending save; if it fails, navigation is cancelled and an error toast offers Retry.
   `beforeunload` warns only while dirty or saving.
2. **Conflicts.** `409 conflict` opens a dialog: "Someone else saved this image" → *Load theirs* (discard mine) /
   *Keep mine* (re-save with `force: true` when allowed) — never silently overwrite.
3. **Undo/redo.** Snapshot-based history per image (max 200 snapshots), covering every change: create, move,
   resize, nudge, class change, delete, duplicate, paste, visibility/lock, property edits. History is kept for the
   last 20 visited images (in memory). Ctrl+Z with empty history does nothing.
4. **Locks.** On open: if `permissions.can_edit` → `lock.acquire`. Until granted the editor is read-only. Denied →
   read-only + banner. `lock.revoked` → read-only + toast (with `by: null` the toast shows the server's `reason`, e.g. the image was reassigned); unsaved changes are kept locally and the user can copy them;
   the lock is no longer re-requested on reconnect (it is requested again when the new holder leaves). Revoked by the
   same user (another tab) → "You are editing this image in another tab" with *Edit here*. Release on image
   change/unmount. A `presence.snapshot` resets the known locks (the server follows it with `lock.state` frames).
   The server allows one lock per connection, so opening another image releases the previous one. `lock.expired`
   (swept for inactivity) and a `lock.state` with `holder: null` for an image the client believes it holds both
   trigger a re-acquire; if someone else got it meanwhile the editor drops to read-only (rules in `lockLogic.ts`).
   A label file shared with another image (same stem) or an unreadable/over-budget image is read-only, with the
   server's `readonly_reason` / `error` shown in the banner; a `409 readonly` on save keeps the editor read-only
   and stops autosave retries. A save that finishes after the workspace unmounted updates the per-image history
   cache, so returning to the image starts from the saved version.
5. **Keyboard.** One keymap service; ignores events whose target is an input, textarea, select or contenteditable
   (except Escape). Scopes: global, annotator, class picker, dialogs (Radix handles dialog focus). Browser-reserved
   combos (Mod+W/T/N/Tab, Mod+Shift+T, F5 without modifier is allowed to reload) cannot be bound.
6. **Selection & arrows.** With boxes selected, arrows nudge 1 px (Shift = 10 px); without a selection, Left/Right
   navigate images.
7. **Class picker.** After drawing (unless "ask" is off and an active class exists): popover anchored at the new box,
   autofocus filter input, Enter assigns the highlighted class, 1–9 picks, Up/Down moves, "Create class" when
   permitted, Esc discards the new box (no history entry left behind).
8. **Realtime cache updates.** WS events update TanStack Query caches (`setQueryData` / `invalidateQueries`): file list rows,
   project stats, chat, comments, notifications, DMs (`dm.read` → "Seen" receipts, conversation and bell badges).
   Invalidations caused by bursty events (saves, bulk changes, class and member updates) are collected and applied
   once per 5 s window (`app/throttledInvalidator.ts`), and only queries that are on screen are refetched
   (`refetchType: 'active'`); the others are marked stale and load when they are next used.
   Reconnects resubscribe and refetch active queries. Composers (chat, DM) clear on send and restore the draft if
   sending fails. Notifications about a thread (comment, rejection, mention on an image) open the annotator on the
   Comments tab.
9. **Errors.** Every query has loading (skeleton), empty (EmptyState) and error (inline retry) states. Error boundaries per
   panel. Toasts via sonner for mutations.
10. **Accessibility.** All icon buttons have `aria-label` + tooltip with shortcut; dialogs trap focus; lists are keyboard
    navigable; colour is never the only signal (status icons have shapes + text in tooltips). Form labels contain only
    the label text (the required asterisk is decorative, the control gets `aria-required`); switch rows are labelled by
    their title and described by their description. Tooltips never intercept clicks and open on focus only for
    keyboard focus (not when a menu returns focus to its trigger).

11. **Class delete / merge.** `DELETE …/classes/{id}` answers `202 {started}` and the label files are rewritten by a
    background job. `DeleteClassDialog` then shows "Removing class… N%" / "Merging class… N%" with a progress bar; it
    can be closed, the job continues. Progress comes from `classes.migration` events (`app/classMigrationEvents.ts`:
    realtime store `classMigration[projectId]`, and `class_migration` patched into the cached project and project
    list). The result toast (`Deleted class “x”` / `Merged “x” into “y”`, "N label files rewritten.", or `Could not
    delete the class` with the server's `error`) is shown by the realtime bridge for a change started in this tab
    (`classMigrationStarted` in the store), so it appears with the dialog closed too. A refusal with `code: 'in_use'`
    (synchronous `409`, or in the final event when the label files disagree with the index) shows the "still used
    in N images" warning inside the open dialog and switches the strategy. If no event arrives (connection lost),
    the dialog polls the project every 2 s until `class_migration` is `null` again; the class still being listed
    then means failure. On the final event the project, stats, image lists, neighbours, activity and every
    annotation document of the project are invalidated. A reconnect drops the live progress, the refetched project
    is the truth.
12. **Read-only during a class change.** While `class_migration` is set (project query or realtime store,
    `useClassMigration`): the project pages show a non-blocking banner "Class change in progress – editing is
    paused" (with the percentage when known); the annotator is read-only through the normal mechanism
    (`ReadOnlyInfo.kind = 'migrating'`, banner in `LockBanner`, `canSave: false` so neither autosave nor its retries
    fire; the edit lock is kept); adding/renaming classes, upload and export are disabled, and the submit button of
    the delete dialog is disabled with a hint. Unsaved boxes stay in memory and are saved when the change ends (a
    label file rewritten meanwhile gives the usual conflict dialog); a clean document is reloaded. A `409 migrating`
    on save (the client did not know yet) is not a conflict: toast with the server's `detail`, boxes stay dirty, the
    project is refetched, and saving resumes afterwards.

### Default shortcuts (all rebindable in Account → Keyboard shortcuts; stored in user settings)

| Action id | Default | | Action id | Default |
| --- | --- | --- | --- | --- |
| `tool.select` | `V` | | `image.prev` | `A`, `ArrowLeft` |
| `tool.box` | `W` | | `image.next` | `D`, `ArrowRight` |
| `tool.pan` | `H` (Space = hold to pan) | | `image.submit` | `Mod+Enter` |
| `view.fit` | `F` | | `image.flag` | `G` |
| `view.actual` | `0` | | `save` | `Mod+S` |
| `view.labels` | `L` | | `undo` | `Mod+Z` |
| `view.crosshair` | `C` | | `redo` | `Mod+Y`, `Mod+Shift+Z` |
| `view.panels` | `\` | | `box.delete` | `Delete`, `Backspace` |
| `class.pick` | `X` | | `box.duplicate` | `Mod+D` |
| `class.prev` | `Q` | | `box.copy` | `Mod+C` |
| `class.next` | `E` | | `box.paste` | `Mod+V` |
| `class.1` … `class.9` | `1` … `9` | | `box.pastePrevious` | `Mod+Shift+V` |
| `select.all` | `Mod+A` | | `select.none` | `Escape` |
| `select.cycle` | `Tab` | | `palette` | `Mod+K` |
| `help` | `?` | | `chat.toggle` | `Mod+/` |

`Mod` = Ctrl on Windows/Linux, ⌘ on macOS.

### User settings object (`/api/me/settings`)

```ts
interface UserSettings {
  theme: 'dark' | 'light' | 'system'
  shortcuts: Partial<Record<ActionId, string[]>>   // overrides only
  autosave: boolean; autosave_delay_ms: number      // true, 800
  ask_class_after_draw: boolean                     // true
  tool_after_draw: 'box' | 'select'                 // 'box'
  wheel: 'zoom' | 'scroll'                          // 'zoom' (scroll = pan; Ctrl/⌘+wheel zooms)
  fill_opacity: number; stroke_width: number        // 0.16, 2
  show_labels: boolean; show_crosshair: boolean     // true, true
  files_panel_width: number; inspector_width: number
  notify_sound: boolean                             // false
}
```

## 6. Canvas module (`web/src/canvas`)

Self-contained (no imports from outside `src/canvas` except React). Public API = `src/canvas/index.ts`:
the types in `src/canvas/types.ts` (frozen contract) plus `AnnotationCanvas` (forwardRef component) and the
geometry helpers. Requirements:

* Two stacked `<canvas>` elements (image layer redrawn only when view/image changes; overlay for boxes, handles,
  crosshair, labels, pins, marquee), `devicePixelRatio`-aware, `ResizeObserver`, all drawing batched in
  `requestAnimationFrame`.
* View: `screen = image * scale + (tx, ty)`. Fit on new image (`image` identity change) with 24 px padding.
  Zoom range 0.02–40, wheel zoom anchored at the cursor (`wheel` prop: `zoom` = plain wheel zooms; `scroll` = wheel
  pans, Ctrl/⌘+wheel and trackpad pinch zoom). Middle-button drag and the `pan` tool pan. `imageSmoothingEnabled`
  false when scale > 1.5 (pixel-exact).
* Pointer Events + `setPointerCapture`; 3 px click/drag threshold; Escape cancels the active gesture (restores state).
* Hit test order: handles of the single selected box (8 handles, 8 screen px, with matching resize cursors) → the
  **smallest** visible, unlocked box containing the point → empty. Locked boxes are selectable but not movable.
* Box tool: drag to draw (Shift = square, Alt = from centre); release creates a box only if ≥ 1 image px in both
  dimensions; boxes clamp to the image. Click without drag on an existing box selects it.
* Select tool: click selects, Shift/Mod-click toggles, drag on empty space = marquee (selects intersecting boxes),
  drag on a box moves the whole selection (clamped as a group), handles resize (normalised, clamped, ≥ 1 px).
* Commits: exactly one `onBoxesChange` call per completed gesture (never during the drag). Live preview while dragging.
* Rendering: class colour stroke (`strokeWidth`), fill (`fillOpacity`), label chip above the box (inside when at the
  top edge) with contrasting text, selected = white stroke + accent halo + handles, hovered = brighter stroke,
  `classId: null` = grey dashed + `raw_label` chip, hidden boxes not drawn, locked boxes dashed.
  Crosshair lines across the canvas when the pointer is over it (`showCrosshair`). Pins as numbered markers.
* Performance: 1000 boxes at 60 fps on a laptop; no allocations per frame in the hot path where avoidable.
* Tests (Vitest, pure functions): view math (fit, zoom-at-point, screen↔image), hit testing, handle resize, clamp,
  normalise, marquee intersection, gesture reducers.
