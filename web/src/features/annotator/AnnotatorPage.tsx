import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useBlocker, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Flag, FolderSearch, PanelLeftOpen, PanelRightOpen } from 'lucide-react'
import { toast } from 'sonner'
import type { AnnotationCanvasHandle } from '@/canvas'
import { getImage, getImages, getNeighbors, setImageStatus, updateImage } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { filtersFromParams, type ImageFilters } from '@/lib/filters'
import { qk } from '@/lib/queryKeys'
import { upsertImageItem } from '@/lib/cacheUpdates'
import { SETTINGS_LIMITS } from '@/lib/settings'
import type { Project, StatusAction } from '@/lib/types'
import { useProjectContext } from '@/app/projectContext'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useBindings } from '@/hooks/useBindings'
import { useSession } from '@/stores/session'
import { useSettings } from '@/stores/settings'
import { useUi, type PaletteCommand } from '@/stores/ui'
import { realtime, useRealtime } from '@/stores/realtime'
import { TopBar } from '@/components/TopBar'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import { ProjectSwitcher } from '@/components/ProjectSwitcher'
import { PresenceAvatars } from '@/components/PresenceAvatars'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback'
import { IconButton } from '@/components/ui/IconButton'
import { CanvasArea } from './CanvasArea'
import { ConflictDialog } from './ConflictDialog'
import { FilesPanel } from './FilesPanel'
import { ImageNavigator } from './ImageNavigator'
import { Inspector } from './Inspector'
import { LockBanner } from './LockBanner'
import { ResizeHandle } from './ResizeHandle'
import { ReviewBar } from './ReviewBar'
import { SavePill } from './SavePill'
import { StatusBar } from './StatusBar'
import { ToolRail } from './ToolRail'
import { setLastVisited } from './lastVisited'
import { useAnnotationDoc } from './useAnnotationDoc'
import { useAnnotatorKeys } from './useAnnotatorKeys'
import { useBoxActions } from './useBoxActions'
import { useImageLock } from './useImageLock'
import { useImagePrefetch } from './useImagePrefetch'
import { useAnnotator } from './store'
import { WorkspaceContext, type ReadOnlyInfo, type Workspace } from './workspaceContext'
import type { AnnotatorLinkState } from '@/features/notifications/notificationUtils'
import { classMigrationPercent, useClassMigration } from '@/features/projects/useClassMigration'

const STATUS_TOASTS: Record<StatusAction, string> = {
  submit: 'Submitted',
  approve: 'Approved',
  reject: 'Rejected. The annotator was notified.',
  reopen: 'Reopened',
}

function useFiltersFromUrl(): ImageFilters {
  const [params] = useSearchParams()
  const key = params.toString()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the serialised params are the identity
  return useMemo(() => filtersFromParams(params), [key])
}

/** /p/:pid/annotate without an image: open the first "assigned to me & not done", else the first to-do. */
function ResolveFirstImage({ project }: { project: Project }) {
  const navigate = useNavigate()
  const location = useLocation()
  const filters = useFiltersFromUrl()
  const hasFilter = location.search.length > 1
  const query = useQuery({
    queryKey: ['project', project.id, 'first-image', location.search],
    queryFn: async ({ signal }) => {
      if (hasFilter) return (await getImages(project.id, filters, 0, 1, { signal })).items[0]?.id ?? null
      const mine = await getImages(project.id, { assignee: 'me', status: ['todo', 'in_progress', 'rejected'] }, 0, 1, { signal })
      if (mine.items[0]) return mine.items[0].id
      const todo = await getImages(project.id, { status: ['todo'] }, 0, 1, { signal })
      if (todo.items[0]) return todo.items[0].id
      return (await getImages(project.id, {}, 0, 1, { signal })).items[0]?.id ?? null
    },
    staleTime: 0,
    gcTime: 0,
  })

  useEffect(() => {
    if (query.data != null) navigate({ pathname: `/p/${project.id}/annotate/${query.data}`, search: location.search }, { replace: true })
  }, [query.data, navigate, project.id, location.search])

  return (
    <div className="flex h-full flex-col">
      <TopBar left={<ProjectSwitcher project={project} target="annotate" />} />
      {query.isError ? (
        <ErrorState className="flex-1" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data === null ? (
        <EmptyState
          className="flex-1"
          icon={<FolderSearch />}
          title={hasFilter ? 'No images match this filter' : project.indexing ? 'Indexing images…' : 'No images in this project'}
          description={
            hasFilter
              ? 'Try another filter, or open the full list.'
              : project.indexing
                ? 'The folder is being scanned. Images appear here as soon as they are indexed.'
                : 'Add images to the project folder (or upload them), then rescan.'
          }
          action={
            <Button asChild variant="secondary">
              <Link to={hasFilter ? `/p/${project.id}/annotate` : `/p/${project.id}`}>{hasFilter ? 'Clear filter' : 'Project overview'}</Link>
            </Button>
          }
        />
      ) : (
        <LoadingBlock className="flex-1" label="Finding your next image…" />
      )}
    </div>
  )
}

function CollapsedPanel({ side, onOpen }: { side: 'left' | 'right'; onOpen: () => void }) {
  return (
    <div className={`flex w-8 shrink-0 flex-col items-center bg-panel py-2 ${side === 'left' ? 'border-r' : 'border-l'} border-line`}>
      <IconButton
        size="sm"
        label={side === 'left' ? 'Show files panel' : 'Show inspector'}
        tooltipSide={side === 'left' ? 'right' : 'left'}
        icon={side === 'left' ? <PanelLeftOpen /> : <PanelRightOpen />}
        onClick={onOpen}
      />
    </div>
  )
}

function AnnotatorWorkspace({ project, imageId }: { project: Project; imageId: number }) {
  const projectId = project.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const filters = useFiltersFromUrl()
  const me = useSession((s) => s.user)
  const settings = useSettings((s) => s.settings)
  const updateSettings = useSettings((s) => s.update)
  const bindings = useBindings()
  const smallScreen = useMediaQuery('(max-width: 1023px), (hover: none) and (pointer: coarse)')
  const canvasRef = useRef<AnnotationCanvasHandle | null>(null)
  const preview = useAnnotator((s) => s.preview)
  const filesOpen = useUi((s) => s.filesPanelOpen)
  const chatOpen = useUi((s) => s.chatOpen)
  const inspectorOpen = useUi((s) => s.inspectorOpen)
  const setFilesOpen = useUi((s) => s.setFilesPanelOpen)
  const setInspectorOpen = useUi((s) => s.setInspectorOpen)
  const [filesWidth, setFilesWidth] = useState(settings.files_panel_width)
  const [inspectorWidth, setInspectorWidth] = useState(settings.inspector_width)
  const [syncedWidths, setSyncedWidths] = useState([settings.files_panel_width, settings.inspector_width])
  if (syncedWidths[0] !== settings.files_panel_width || syncedWidths[1] !== settings.inspector_width) {
    setSyncedWidths([settings.files_panel_width, settings.inspector_width])
    setFilesWidth(settings.files_panel_width)
    setInspectorWidth(settings.inspector_width)
  }

  const imageQuery = useQuery({
    queryKey: qk.image(projectId, imageId),
    queryFn: ({ signal }) => getImage(projectId, imageId, { signal }),
    staleTime: 60_000,
  })
  const image = imageQuery.data
  const neighborsQuery = useQuery({
    queryKey: qk.neighbors(projectId, imageId, filters),
    queryFn: ({ signal }) => getNeighbors(projectId, imageId, filters, { signal }),
    staleTime: 10_000,
  })
  const neighbors = neighborsQuery.data
  useImagePrefetch(projectId, image, neighbors, filters)

  // ---------------------------------------------------------------- permissions, lock, document
  const perms = project.permissions
  const assignedElsewhere =
    project.settings.restrict_to_assigned &&
    project.my_role === 'annotator' &&
    !!image?.assignee &&
    image.assignee.id !== me?.id
  const imageBroken = !!image && (!!image.error || !image.width || !image.height)
  const baseEditable = perms.can_edit && !!image && !assignedElsewhere && !smallScreen && !imageBroken
  const lock = useImageLock(imageId, baseEditable)
  const lockOk = lock.status === 'held' || lock.status === 'unavailable'
  // A class delete/merge is rewriting label files: the lock is kept, but nothing is edited or saved until it
  // ends (unsaved boxes stay in memory and are saved afterwards).
  const migration = useClassMigration(project)
  const doc = useAnnotationDoc(projectId, imageId, {
    canSave: baseEditable && lockOk && !migration,
    forceAllowed: lock.status === 'held' || perms.can_review,
    autosave: settings.autosave,
    autosaveDelayMs: settings.autosave_delay_ms,
    onLocked: lock.markDenied,
  })
  const editable =
    baseEditable && lockOk && !migration && doc.ready && !doc.state.readonlyReason && !preview && doc.state.save !== 'conflict'

  const readOnly: ReadOnlyInfo | null = (() => {
    if (smallScreen) return { kind: 'device', message: 'Editing needs a larger screen with a mouse. This device is view-only: you can browse, comment and chat.' }
    if (imageBroken) return { kind: 'image', message: image?.error ?? 'This image cannot be decoded.' }
    if (!perms.can_edit) return { kind: 'permission', message: 'You have view-only access to this project. You can comment and chat.' }
    if (assignedElsewhere) return { kind: 'assigned', message: `Assigned to ${image?.assignee?.display_name}. Only the assignee can edit it in this project.` }
    if (migration) {
      const percent = classMigrationPercent(migration)
      return { kind: 'migrating', message: `Class change in progress – editing is paused${percent ? ` (${percent})` : ''}. You can view and comment.` }
    }
    if (doc.state.readonlyReason) return { kind: 'file', message: `This label file is read-only: ${doc.state.readonlyReason}` }
    if (lock.status === 'revoked' && lock.holder && lock.holder.id === me?.id)
      return { kind: 'revoked', message: 'You are editing this image in another tab. This tab is read-only.', holder: lock.holder }
    if (lock.status === 'revoked') return { kind: 'revoked', message: `${lock.holder?.display_name ?? 'A manager'} took over editing. Your unsaved changes are kept in this tab.`, holder: lock.holder }
    if (lock.status === 'denied') return { kind: 'locked', message: `${lock.holder?.display_name ?? 'Someone'} is editing this image. You can view and comment.`, holder: lock.holder }
    if (lock.status === 'acquiring' && image) return { kind: 'acquiring', message: 'Requesting the edit lock…' }
    if (preview) return { kind: 'preview', message: 'Previewing a revision' }
    return null
  })()

  // ---------------------------------------------------------------- navigation
  const docRef = useRef(doc)
  useEffect(() => {
    docRef.current = doc
  })
  /** Set while a navigation is in flight, until the target image has rendered (keys never act on stale state). */
  const navigating = useRef<number | null>(null)
  useEffect(() => {
    navigating.current = null
  }, [imageId])

  const goTo = useCallback(
    async (id: number): Promise<boolean> => {
      if (id === imageId) return false
      if (navigating.current !== null && Date.now() - navigating.current < 1500) return false
      // Key repeat can fire between the URL change and React rendering the new image: never push the
      // image that is already in the address bar twice.
      if (window.location.pathname.endsWith(`/annotate/${id}`)) return false
      navigating.current = Date.now()
      let navigated = false
      try {
        const d = docRef.current
        const ok = await d.flush()
        if (!ok) {
          const conflict = d.state.save === 'conflict'
          toast.error(conflict ? 'Resolve the save conflict first' : 'Your changes could not be saved', {
            description: conflict ? undefined : 'Navigation was cancelled so nothing is lost.',
            action: conflict ? undefined : { label: 'Retry', onClick: () => void goTo(id) },
          })
          return false
        }
        if (docRef.current.state.dirty) toast.warning('Unsaved changes were kept in this tab (the image is read-only).')
        navigate({ pathname: `/p/${projectId}/annotate/${id}`, search: location.search })
        navigated = true
        return true
      } finally {
        // On success the guard is released when the new image renders (effect above).
        if (!navigated) navigating.current = null
      }
    },
    [imageId, navigate, projectId, location.search],
  )

  // Any other navigation (links, back/forward) waits for the pending save too.
  const unsavedRef = useRef(false)
  useEffect(() => {
    unsavedRef.current = doc.state.dirty || doc.state.save === 'saving'
  })
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => unsavedRef.current && currentLocation.pathname !== nextLocation.pathname,
  )
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    let cancelled = false
    void docRef.current.flush().then((ok) => {
      if (cancelled) return
      if (ok) {
        blocker.proceed()
      } else {
        blocker.reset()
        toast.error('Your changes could not be saved', {
          description: 'Navigation was cancelled so nothing is lost.',
          action: { label: 'Retry', onClick: () => void docRef.current.save() },
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [blocker])

  // ---------------------------------------------------------------- per-image / per-project effects
  useEffect(() => {
    useAnnotator.getState().resetForImage()
    realtime.setPresence(imageId)
    return () => setLastVisited(projectId, imageId)
  }, [projectId, imageId])

  // Links from notifications about a thread (comment, rejection, mention) open the Comments tab.
  const linkState = location.state as AnnotatorLinkState | null
  const openTab = linkState?.inspectorTab
  useEffect(() => {
    if (openTab !== 'comments') return
    useAnnotator.getState().setInspectorTab('comments')
    useUi.getState().setInspectorOpen(true)
  }, [openTab, location.key])

  useEffect(() => {
    useAnnotator.getState().resetForProject()
    return () => {
      realtime.setPresence(null)
      useUi.getState().setCurrentImage(null)
    }
  }, [projectId])

  // Default active class: keep a valid one, else the first class.
  const classes = project.classes
  useEffect(() => {
    const st = useAnnotator.getState()
    if (st.activeClassId === null || !classes.some((c) => c.id === st.activeClassId)) {
      st.setActiveClassId(classes[0]?.id ?? null)
    }
  }, [classes])

  useEffect(() => {
    if (!image) return
    useUi.getState().setCurrentImage({ id: image.id, filename: image.filename })
    document.title = `${image.filename} · ${project.name} · Annotamate`
    return () => {
      document.title = 'Annotamate'
    }
  }, [image, project.name])

  // ---------------------------------------------------------------- workflow actions
  const changeStatus = useCallback(
    async (action: StatusAction, comment?: string) => {
      if (action === 'submit' && !(await docRef.current.flush())) {
        toast.error('Save your changes before submitting.')
        return false
      }
      try {
        const item = await setImageStatus(projectId, imageId, action, comment)
        upsertImageItem(qc, projectId, item)
        for (const k of [qk.stats(projectId), qk.project(projectId), qk.projectsAll, qk.neighborsAll(projectId), qk.activityAll(projectId)]) {
          void qc.invalidateQueries({ queryKey: k })
        }
        if (action === 'reject') void qc.invalidateQueries({ queryKey: qk.comments(projectId, imageId) })
        const label =
          action === 'submit' ? (item.status === 'review' ? 'Submitted for review' : 'Marked as done') : STATUS_TOASTS[action]
        const nextId = neighbors?.next_id ?? null
        toast.success(label, { description: action !== 'reopen' && nextId !== null ? 'Moved to the next image.' : undefined })
        if (action !== 'reopen' && nextId !== null) void goTo(nextId)
        return true
      } catch (err) {
        toast.error('Could not change the status', { description: errorMessage(err) })
        return false
      }
    },
    [projectId, imageId, qc, neighbors, goTo],
  )

  const toggleFlag = useCallback(() => {
    if (!image) return
    updateImage(projectId, imageId, { flagged: !image.flagged })
      .then((item) => {
        upsertImageItem(qc, projectId, item)
        toast(item.flagged ? 'Image flagged' : 'Flag removed', { icon: <Flag className="size-4 text-warn" />, duration: 1800 })
      })
      .catch((err: unknown) => toast.error('Could not change the flag', { description: errorMessage(err) }))
  }, [image, projectId, imageId, qc])

  const actions = useBoxActions({
    projectId,
    imageId,
    image,
    doc,
    editable,
    classes,
    prevId: neighbors?.prev_id ?? null,
    revealBox: (id) => canvasRef.current?.revealBox(id),
  })

  /** Prev/next, also right after a navigation (neighbours are fetched on demand if not loaded yet). */
  const step = (dir: 'prev' | 'next') => {
    const pick = (n: { prev_id: number | null; next_id: number | null }) => (dir === 'prev' ? n.prev_id : n.next_id)
    if (neighbors) {
      const id = pick(neighbors)
      if (id !== null) void goTo(id)
      return
    }
    qc.fetchQuery({
      queryKey: qk.neighbors(projectId, imageId, filters),
      queryFn: ({ signal }) => getNeighbors(projectId, imageId, filters, { signal }),
      staleTime: 10_000,
    })
      .then((n) => {
        const id = pick(n)
        if (id !== null) void goTo(id)
      })
      .catch((err: unknown) => toast.error('Could not find the next image', { description: errorMessage(err) }))
  }

  const nav = {
    prevId: neighbors?.prev_id ?? null,
    nextId: neighbors?.next_id ?? null,
    index: neighbors?.index ?? -1,
    total: neighbors?.total ?? null,
    goTo,
    goPrev: () => step('prev'),
    goNext: () => step('next'),
  }

  const classById = useMemo(() => new Map(classes.map((c) => [c.id, c])), [classes])

  const ws: Workspace = {
    projectId,
    project,
    imageId,
    image,
    filters,
    neighbors,
    doc,
    lock,
    editable,
    readOnly,
    canvasRef,
    classes,
    classById,
    actions,
    nav,
    changeStatus,
    toggleFlag,
  }

  useAnnotatorKeys(ws)

  // Command palette entries for the workspace.
  const wsRef = useRef(ws)
  useEffect(() => {
    wsRef.current = ws
  })
  useEffect(() => {
    const w = () => wsRef.current
    const commands: PaletteCommand[] = [
      { id: 'ann.save', group: 'Annotator', label: 'Save now', shortcut: bindings.save, run: () => void w().doc.save() },
      { id: 'ann.next', group: 'Annotator', label: 'Next image', shortcut: bindings['image.next'], run: () => w().nav.goNext() },
      { id: 'ann.prev', group: 'Annotator', label: 'Previous image', shortcut: bindings['image.prev'], run: () => w().nav.goPrev() },
      { id: 'ann.submit', group: 'Annotator', label: 'Submit image', shortcut: bindings['image.submit'], run: () => void w().changeStatus('submit') },
      { id: 'ann.flag', group: 'Annotator', label: 'Flag / unflag image', shortcut: bindings['image.flag'], run: () => w().toggleFlag() },
      { id: 'ann.fit', group: 'Annotator', label: 'Zoom to fit', shortcut: bindings['view.fit'], run: () => w().canvasRef.current?.zoomToFit() },
      { id: 'ann.actual', group: 'Annotator', label: 'Actual size (1:1)', shortcut: bindings['view.actual'], run: () => w().canvasRef.current?.zoomToActual() },
      { id: 'ann.labels', group: 'Annotator', label: 'Toggle box labels', shortcut: bindings['view.labels'], run: () => updateSettings({ show_labels: !useSettings.getState().settings.show_labels }) },
      { id: 'ann.crosshair', group: 'Annotator', label: 'Toggle crosshair', shortcut: bindings['view.crosshair'], run: () => updateSettings({ show_crosshair: !useSettings.getState().settings.show_crosshair }) },
      { id: 'ann.panels', group: 'Annotator', label: 'Toggle side panels', shortcut: bindings['view.panels'], run: () => useUi.getState().togglePanels() },
      { id: 'ann.pastePrev', group: 'Annotator', label: "Paste previous image's boxes", shortcut: bindings['box.pastePrevious'], run: () => void w().actions.pastePrevious() },
      { id: 'ann.selectTool', group: 'Annotator', label: 'Select tool', shortcut: bindings['tool.select'], run: () => useAnnotator.getState().setTool('select') },
      { id: 'ann.boxTool', group: 'Annotator', label: 'Box tool', shortcut: bindings['tool.box'], run: () => useAnnotator.getState().setTool('box') },
      { id: 'ann.undo', group: 'Annotator', label: 'Undo', shortcut: bindings.undo, run: () => w().editable && w().doc.undo() },
      { id: 'ann.redo', group: 'Annotator', label: 'Redo', shortcut: bindings.redo, run: () => w().editable && w().doc.redo() },
      { id: 'ann.comments', group: 'Annotator', label: 'Open comments', run: () => useAnnotator.getState().setInspectorTab('comments') },
      { id: 'ann.history', group: 'Annotator', label: 'Open revision history', run: () => useAnnotator.getState().setInspectorTab('history') },
    ]
    useUi.getState().setCommands('annotator', commands)
    return () => useUi.getState().setCommands('annotator', null)
  }, [bindings, updateSettings])

  const presenceCount = useRealtime((s) => (s.presenceProjectId === projectId ? Object.keys(s.presence).length : 0))

  if (imageQuery.isError) {
    return (
      <div className="flex h-full flex-col">
        <TopBar left={<ProjectSwitcher project={project} target="annotate" />} />
        <ErrorState
          className="flex-1"
          title="Could not open this image"
          error={imageQuery.error}
          onRetry={() => void imageQuery.refetch()}
        />
      </div>
    )
  }

  const filesMin = SETTINGS_LIMITS.files_panel_width[0]
  const filesMax = SETTINGS_LIMITS.files_panel_width[1]
  const inspMin = SETTINGS_LIMITS.inspector_width[0]
  const inspMax = SETTINGS_LIMITS.inspector_width[1]

  return (
    <WorkspaceContext.Provider value={ws}>
      <div className="flex h-full flex-col bg-bg">
        <TopBar
          left={<ProjectSwitcher project={project} target="annotate" />}
          center={<ImageNavigator />}
          right={
            <>
              <SavePill />
              {presenceCount > 0 && <PresenceAvatars projectId={projectId} className="ml-1 hidden lg:flex" />}
            </>
          }
        />
        <ConnectionBanner />
        <div className="flex min-h-0 flex-1">
          {filesOpen ? (
            <div className="relative shrink-0 border-r border-line" style={{ width: filesWidth }}>
              <ErrorBoundary name="Files panel">
                <FilesPanel project={project} imageId={imageId} filters={filters} currentIndex={nav.index} onOpen={(id) => void goTo(id)} />
              </ErrorBoundary>
              <ResizeHandle
                edge="right"
                label="Resize files panel"
                width={filesWidth}
                min={filesMin}
                max={filesMax}
                onResize={setFilesWidth}
                onCommit={(w) => updateSettings({ files_panel_width: w })}
              />
            </div>
          ) : (
            <CollapsedPanel side="left" onOpen={() => setFilesOpen(true)} />
          )}
          <ToolRail />
          <div className="flex min-w-0 flex-1 flex-col">
            <LockBanner />
            <ErrorBoundary name="Canvas" resetKey={imageId} className="flex-1">
              <CanvasArea />
            </ErrorBoundary>
            <ReviewBar />
          </div>
          {chatOpen ? (
            // The chat drawer (fixed, 360 px) sits here: keep the canvas and the review bar out from under it.
            <div className="w-[360px] shrink-0" aria-hidden />
          ) : inspectorOpen ? (
            <div className="relative shrink-0 border-l border-line" style={{ width: inspectorWidth }}>
              <ResizeHandle
                edge="left"
                label="Resize inspector"
                width={inspectorWidth}
                min={inspMin}
                max={inspMax}
                onResize={setInspectorWidth}
                onCommit={(w) => updateSettings({ inspector_width: w })}
              />
              <ErrorBoundary name="Inspector">
                <Inspector />
              </ErrorBoundary>
            </div>
          ) : (
            <CollapsedPanel side="right" onOpen={() => setInspectorOpen(true)} />
          )}
        </div>
        <StatusBar />
        <ConflictDialog />
      </div>
    </WorkspaceContext.Provider>
  )
}

/** /p/:projectId/annotate/:imageId? — the annotation workspace. */
export function AnnotatorPage() {
  const { project } = useProjectContext()
  const params = useParams()
  const imageId = params.imageId !== undefined ? Number(params.imageId) : null
  if (imageId === null || !Number.isInteger(imageId) || imageId < 0) return <ResolveFirstImage project={project} />
  return <AnnotatorWorkspace project={project} imageId={imageId} />
}
