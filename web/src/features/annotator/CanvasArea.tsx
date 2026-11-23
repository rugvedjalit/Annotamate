import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ImageOff, History, X } from 'lucide-react'
import { AnnotationCanvas, type BoxChangeMeta, type CanvasBox, type CanvasPin } from '@/canvas'
import { assetUrl } from '@/lib/config'
import { getComments } from '@/lib/endpoints'
import { qk } from '@/lib/queryKeys'
import { isValidBox, type EditorBox } from '@/lib/boxes'
import { useSettings } from '@/stores/settings'
import { useElementSize } from '@/hooks/useElementSize'
import { Button } from '@/components/ui/Button'
import { ErrorState, Spinner } from '@/components/ui/Feedback'
import { ClassPicker } from './ClassPicker'
import { FloatingBoxToolbar } from './FloatingBoxToolbar'
import { ZoomControl } from './ZoomControl'
import { BoxContextMenu } from './BoxContextMenu'
import { useDecodedImage } from './useDecodedImage'
import { useAnnotator } from './store'
import { useWorkspace } from './workspaceContext'

const EMPTY_PINS: CanvasPin[] = []

export function CanvasArea() {
  const ws = useWorkspace()
  const settings = useSettings((s) => s.settings)
  const containerRef = useRef<HTMLDivElement>(null)
  const size = useElementSize(containerRef)
  const createdIds = useRef(new Set<string>())

  const tool = useAnnotator((s) => s.tool)
  const spacePan = useAnnotator((s) => s.spacePan)
  const selectedIds = useAnnotator((s) => s.selectedIds)
  const hoverId = useAnnotator((s) => s.hoverId)
  const activeClassId = useAnnotator((s) => s.activeClassId)
  const picker = useAnnotator((s) => s.picker)
  const preview = useAnnotator((s) => s.preview)
  const placingPin = useAnnotator((s) => s.placingPin)
  const pendingPin = useAnnotator((s) => s.pendingPin)
  const showPins = useAnnotator((s) => s.showPins)

  const { projectId, imageId, image, doc, editable, classes, canvasRef, actions } = ws
  const allowCreate = ws.project.permissions.can_add_classes
  const url = image && !image.error && image.width ? assetUrl(image.file_url) : null
  const decoded = useDecodedImage(url)

  const comments = useQuery({
    queryKey: qk.comments(projectId, imageId),
    queryFn: ({ signal }) => getComments(projectId, imageId, { signal }),
    staleTime: 30_000,
  })

  const pins = useMemo<CanvasPin[]>(() => {
    if (!showPins && !pendingPin) return EMPTY_PINS
    const list: CanvasPin[] = []
    if (showPins) {
      let n = 0
      for (const c of comments.data ?? []) {
        if (!c.pin || c.deleted) continue
        n++
        list.push({ id: c.id, x: c.pin.x, y: c.pin.y, label: String(n), resolved: c.resolved })
      }
    }
    if (pendingPin) list.push({ id: 'pending', x: pendingPin.x, y: pendingPin.y, label: '+' })
    return list
  }, [showPins, pendingPin, comments.data])

  const classesForCanvas = useMemo(() => classes.map((c) => ({ id: c.id, name: c.name, color: c.color })), [classes])
  const activeValid = activeClassId !== null && classes.some((c) => c.id === activeClassId)
  const askClass = settings.ask_class_after_draw || !activeValid

  const canvasBoxes: CanvasBox[] = useMemo(() => {
    if (preview) return preview.boxes
    if (picker?.mode === 'new') return [...doc.boxes, picker.box]
    return doc.boxes
  }, [preview, picker, doc.boxes])

  // Close a pending picker when editing stops being possible (lock lost, image changed).
  useEffect(() => {
    if (!editable && picker) useAnnotator.getState().closePicker()
  }, [editable, picker])

  const toViewport = useCallback((p: { x: number; y: number }) => {
    const r = containerRef.current?.getBoundingClientRect()
    return { x: (r?.left ?? 0) + p.x, y: (r?.top ?? 0) + p.y }
  }, [])

  const anchorForBox = useCallback(
    (b: CanvasBox) => {
      const rect = canvasRef.current?.boxScreenRect(b.id)
      if (rect) return toViewport({ x: rect.x + rect.w, y: rect.y })
      const v = useAnnotator.getState().view ?? canvasRef.current?.getView() ?? { scale: 1, tx: 0, ty: 0 }
      return toViewport({ x: Math.max(b.x1, b.x2) * v.scale + v.tx, y: Math.min(b.y1, b.y2) * v.scale + v.ty })
    },
    [toViewport, canvasRef],
  )

  const afterCreate = useCallback(
    (id: string) => {
      const st = useAnnotator.getState()
      st.select([id])
      if (settings.tool_after_draw === 'select') st.setTool('select')
    },
    [settings.tool_after_draw],
  )

  /** A box was drawn: assign the active class, or ask with the picker (the box is not in the doc yet). */
  const handleCreated = useCallback(
    (box: CanvasBox, anchor: { x: number; y: number } | null) => {
      const st = useAnnotator.getState()
      if (createdIds.current.has(box.id)) {
        if (anchor && st.picker?.mode === 'new' && st.picker.box.id === box.id) {
          st.openPicker({ ...st.picker, anchor })
        }
        return
      }
      createdIds.current.add(box.id)
      if (createdIds.current.size > 100) createdIds.current.clear()
      if (!editable || !isValidBox(box)) return
      const newBox: EditorBox = {
        id: box.id,
        classId: askClass ? null : st.activeClassId,
        rawLabel: null,
        x1: Math.min(box.x1, box.x2),
        y1: Math.min(box.y1, box.y2),
        x2: Math.max(box.x1, box.x2),
        y2: Math.max(box.y1, box.y2),
      }
      if (askClass) {
        st.openPicker({ mode: 'new', box: newBox, anchor: anchor ?? anchorForBox(newBox) })
      } else {
        doc.commit([...doc.boxes, newBox])
        afterCreate(newBox.id)
      }
    },
    [editable, askClass, anchorForBox, doc, afterCreate],
  )

  const onBoxesChange = useCallback(
    (next: CanvasBox[], meta: BoxChangeMeta) => {
      if (!editable || preview) return
      const byId = new Map(doc.boxes.map((b) => [b.id, b]))
      if (meta.kind === 'create') {
        const created = next.find((b) => !byId.has(b.id) && b.id !== (picker?.mode === 'new' ? picker.box.id : ''))
        if (created) handleCreated(created, null)
        return
      }
      // Keep editor-only fields (VOC flags) that the canvas does not know about; ignore the pending box.
      const merged: EditorBox[] = []
      for (const b of next) {
        const orig = byId.get(b.id)
        if (orig) merged.push({ ...orig, ...b })
      }
      doc.commit(merged)
    },
    [editable, preview, doc, picker, handleCreated],
  )

  const onBoxCreated = useCallback(
    (box: CanvasBox, anchor: { x: number; y: number }) => handleCreated(box, toViewport(anchor)),
    [handleCreated, toViewport],
  )

  const onSelectionChange = useCallback(
    (ids: string[]) => {
      const p = useAnnotator.getState().picker
      const pendingId = p?.mode === 'new' ? p.box.id : null
      useAnnotator.getState().select(pendingId ? ids.filter((id) => id !== pendingId) : ids)
    },
    [],
  )

  const onContextMenu = useCallback((e: { clientX: number; clientY: number; boxId: string | null }) => {
    const st = useAnnotator.getState()
    if (st.preview) return
    if (e.boxId && !st.selectedIds.includes(e.boxId)) st.select([e.boxId])
    st.setContextMenu({ clientX: e.clientX, clientY: e.clientY, boxId: e.boxId })
  }, [])

  const onBoxDoubleClick = useCallback(
    (boxId: string, anchor: { x: number; y: number }) => {
      if (!editable) return
      const st = useAnnotator.getState()
      const ids = st.selectedIds.includes(boxId) ? st.selectedIds : [boxId]
      st.select(ids)
      st.openPicker({ mode: 'assign', ids, anchor: toViewport(anchor) })
    },
    [editable, toViewport],
  )

  const pickerBoxClass =
    picker?.mode === 'assign'
      ? doc.boxes.find((b) => b.id === picker.ids[0])?.classId ?? null
      : (activeClassId ?? null)

  const effectiveTool = spacePan ? 'pan' : !editable && tool === 'box' ? 'select' : tool
  const imageError = image?.error ?? (image && !image.width ? 'This image cannot be displayed.' : null) ?? decoded.error
  const loadingImage = !image || (!!url && decoded.loading)
  const docError = doc.state.key === `${projectId}:${imageId}` && doc.state.status === 'error'

  return (
    <div
      ref={containerRef}
      data-annotator-canvas
      className="relative min-h-0 flex-1 overflow-hidden canvas-backdrop"
    >
      <AnnotationCanvas
        ref={canvasRef}
        className="absolute inset-0"
        image={decoded.image}
        imageWidth={image?.width ?? 0}
        imageHeight={image?.height ?? 0}
        imageKey={imageId}
        boxes={canvasBoxes}
        classes={classesForCanvas}
        selectedIds={preview ? [] : selectedIds}
        tool={effectiveTool}
        readOnly={!editable || !!preview}
        defaultClassId={askClass ? null : activeClassId}
        highlightId={hoverId}
        showLabels={settings.show_labels}
        showCrosshair={settings.show_crosshair}
        fillOpacity={settings.fill_opacity}
        strokeWidth={settings.stroke_width}
        wheel={settings.wheel}
        pins={pins}
        placingPin={placingPin}
        onSelectionChange={onSelectionChange}
        onBoxesChange={onBoxesChange}
        onBoxCreated={onBoxCreated}
        onCursorMove={useAnnotator.getState().setCursor}
        onViewChange={useAnnotator.getState().setView}
        onPinClick={(pin) => {
          if (pin.id !== 'pending') useAnnotator.getState().focusComment(Number(pin.id))
        }}
        onPinPlace={(p) => {
          const st = useAnnotator.getState()
          st.setPendingPin({ x: Math.round(p.x), y: Math.round(p.y) })
          st.setPlacingPin(false)
          st.setInspectorTab('comments')
        }}
        onContextMenu={onContextMenu}
        onBoxDoubleClick={onBoxDoubleClick}
        onGestureChange={(g) => useAnnotator.getState().setGesture(g !== null)}
      />

      {preview && (
        <div className="absolute inset-x-0 top-0 z-20 flex animate-slide-down items-center gap-2 border-b border-accent/40 bg-accent-soft px-3 py-1.5 text-sm backdrop-blur-sm">
          <History className="size-4 text-accent-text" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-fg">
            Previewing {preview.label} · {preview.boxes.length} boxes (read-only)
          </span>
          <Button size="xs" variant="ghost" onClick={() => useAnnotator.getState().setPreview(null)}>
            <X />
            Exit preview
          </Button>
        </div>
      )}

      {placingPin && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 animate-slide-down rounded-full border border-line bg-elevated px-3 py-1 text-sm text-fg shadow-pop">
          Click on the image to place a comment pin · Esc to cancel
        </div>
      )}

      {(loadingImage || (doc.state.status === 'loading' && !docError)) && !imageError && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <div className="flex items-center gap-2 rounded-full border border-line bg-panel/90 px-3 py-1.5 text-sm text-muted shadow-pop">
            <Spinner className="size-3.5" />
            Loading image…
          </div>
        </div>
      )}

      {imageError && (
        <div className="absolute inset-0 z-10 grid place-items-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-2 rounded-xl border border-line bg-panel p-6 text-center shadow-pop">
            <ImageOff className="size-6 text-danger" aria-hidden />
            <div className="text-md font-semibold">This image cannot be displayed</div>
            <div className="text-sm text-muted">{imageError}</div>
            {decoded.error && (
              <Button size="sm" onClick={decoded.retry}>
                Retry
              </Button>
            )}
          </div>
        </div>
      )}

      {docError && (
        <div className="absolute inset-0 z-10 grid place-items-center p-6">
          <div className="rounded-xl border border-line bg-panel shadow-pop">
            <ErrorState title="Could not load the annotations" error={doc.state.loadError} onRetry={doc.reload} />
          </div>
        </div>
      )}

      <FloatingBoxToolbar containerWidth={size.width} containerHeight={size.height} />
      <ZoomControl />
      <BoxContextMenu />

      {picker && editable && (
        <ClassPicker
          key={picker.mode === 'new' ? picker.box.id : picker.ids.join(',')}
          anchor={picker.anchor}
          classes={classes}
          initialClassId={pickerBoxClass}
          allowCreate={allowCreate}
          title={picker.mode === 'new' ? 'Assign class' : 'Change class'}
          escapeHint={picker.mode === 'new' ? 'discard box' : 'cancel'}
          onCreate={actions.createClass}
          onPick={(classId) => {
            const st = useAnnotator.getState()
            const p = st.picker
            st.closePicker()
            st.setActiveClassId(classId)
            if (!p) return
            if (p.mode === 'new') {
              doc.commit([...doc.boxes, { ...p.box, classId, rawLabel: null }])
              afterCreate(p.box.id)
            } else {
              actions.assignClass(p.ids, classId)
            }
          }}
          onDismiss={() => useAnnotator.getState().closePicker()}
        />
      )}
    </div>
  )
}
