// Imperative glue between the DOM and the pure modules: owns the two canvases, the view, the
// active gesture, pointer/wheel/keyboard listeners, ResizeObserver and rAF scheduling.
// The React component only creates it, forwards props and exposes the imperative handle.
import { DEFAULT_ACCENT, DEFAULT_CANVAS, isLight } from './color'
import {
  boxAnchor,
  cancelGesture as cancelStep,
  cursorFor,
  hoverTarget,
  IDLE,
  isDragKind,
  pointerDown,
  pointerMove,
  pointerUp,
  type Effects,
  type Gesture,
  type GestureContext,
  type PointerSample,
} from './controller'
import { normalizeRect } from './geometry'
import { BOX_HIT_SLOP, handleBoxFor, hitTestBoxes, NO_HIT, type HitTarget } from './hittest'
import { newBoxId } from './ids'
import {
  buildStyles,
  createDotPattern,
  createScene,
  drawImageLayer,
  makeStyle,
  OverlayRenderer,
  unknownStyle,
  type BoxStyle,
  type ImageLayerParams,
  type OverlayScene,
} from './render'
import type {
  AnnotationCanvasProps,
  CanvasBox,
  CanvasClass,
  CanvasGestureKind,
  ScreenRect,
  ViewState,
} from './types'
import {
  actualSizeView,
  applyWheel,
  constrainView,
  fitView,
  IDENTITY_VIEW,
  imageToScreen,
  rectToScreen,
  revealRect,
  screenToImage,
  viewsEqual,
  wheelDeltaPx,
  zoomAt,
} from './view'

/** How long a committed result is shown while waiting for the new `boxes` prop. */
const OPTIMISTIC_MS = 300

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)

function get2d(canvas: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d', opts) ?? null
  } catch {
    return null
  }
}

function hoverBoxId(h: HitTarget): string | null {
  return h.kind === 'box' || h.kind === 'handle' ? h.box.id : null
}

type Raf = (cb: () => void) => number
type Caf = (id: number) => void

export class CanvasEngine {
  private props: AnnotationCanvasProps | null = null
  private readonly container: HTMLElement
  private readonly imageCanvas: HTMLCanvasElement
  private readonly overlay: HTMLCanvasElement
  private readonly win: Window & typeof globalThis
  private readonly imageCtx: CanvasRenderingContext2D | null
  private readonly renderer: OverlayRenderer | null
  private readonly scene: OverlayScene = createScene()
  private readonly imageParams: ImageLayerParams = {
    width: 0,
    height: 0,
    dpr: 1,
    view: IDENTITY_VIEW,
    image: null,
    imageWidth: 0,
    imageHeight: 0,
    backdrop: DEFAULT_CANVAS,
    pattern: null,
  }
  private readonly raf: Raf
  private readonly caf: Caf

  // View & size
  private view: ViewState = IDENTITY_VIEW
  private width = 0
  private height = 0
  private dpr = 1
  private needsFit = true
  /** The view is "fitted" and follows container resizes until the user pans/zooms. */
  private autoFit = true
  private clientLeft = 0
  private clientTop = 0

  // Interaction
  private gesture: Gesture = IDLE
  private activePointer: number | null = null
  private readonly ptr: PointerSample = { x: 0, y: 0, button: 0, shift: false, alt: false, ctrl: false, meta: false }
  private pointerInside = false
  private hover: HitTarget = NO_HIT
  private cursor = ''
  private lastUpWasClick = false
  private reportedDrag: CanvasGestureKind | null = null
  private cursorReported = false
  private lastCursorX = NaN
  private lastCursorY = NaN
  private keyListening = false
  private readonly gctx: GestureContext = {
    view: IDENTITY_VIEW,
    imageWidth: 0,
    imageHeight: 0,
    boxes: [],
    selectedIds: [],
    tool: 'select',
    readOnly: false,
    placingPin: false,
    pins: null,
    defaultClassId: null,
    createId: newBoxId,
  }

  // Derived render data
  private selectedSrc: readonly string[] | null = null
  private selectedSet: ReadonlySet<string> = new Set()
  private stylesSrc: readonly CanvasClass[] | null = null
  private stylesOpacity = NaN
  private styles = new Map<number, BoxStyle>()
  private unknown: BoxStyle = unknownStyle(0.16)
  private accentStyle: BoxStyle = makeStyle(DEFAULT_ACCENT, null, 0.16)
  private accentStyleColor = ''
  private accentStyleOpacity = NaN
  private accent = DEFAULT_ACCENT
  private backdrop = DEFAULT_CANVAS
  private colorsDirty = true
  private patternDpr = NaN
  private patternBackdrop = ''
  private optimistic: { base: readonly CanvasBox[]; next: CanvasBox[] } | null = null
  private optimisticTimer: ReturnType<typeof setTimeout> | null = null

  // Scheduling
  private rafId = 0
  private dirtyImage = true
  private dirtyOverlay = true
  private destroyed = false
  private readonly cleanups: Array<() => void> = []
  private imageLoadCleanup: (() => void) | null = null

  constructor(container: HTMLElement, imageCanvas: HTMLCanvasElement, overlay: HTMLCanvasElement) {
    this.container = container
    this.imageCanvas = imageCanvas
    this.overlay = overlay
    const win = window
    this.win = win
    this.raf =
      typeof win.requestAnimationFrame === 'function'
        ? (cb) => win.requestAnimationFrame(cb)
        : (cb) => win.setTimeout(cb, 16) as unknown as number
    this.caf =
      typeof win.cancelAnimationFrame === 'function'
        ? (id) => win.cancelAnimationFrame(id)
        : (id) => win.clearTimeout(id)
    this.imageCtx = get2d(imageCanvas, { alpha: false })
    const octx = get2d(overlay)
    this.renderer = octx ? new OverlayRenderer(octx) : null

    try {
      const pos = win.getComputedStyle(container).position
      if (pos === 'static' || pos === '') container.style.position = 'relative'
    } catch {
      // ignore: styling is best effort
    }
    this.attachListeners()
    this.observeSize()
    this.observeTheme()
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.rafId !== 0) this.caf(this.rafId)
    this.rafId = 0
    for (const c of this.cleanups.splice(0)) c()
    this.setKeyListening(false)
    this.imageLoadCleanup?.()
    this.imageLoadCleanup = null
    if (this.optimisticTimer !== null) clearTimeout(this.optimisticTimer)
    this.optimisticTimer = null
    this.props = null
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn, opts)
    this.cleanups.push(() => target.removeEventListener(type, fn, opts))
  }

  private attachListeners(): void {
    const o = this.overlay
    this.listen(o, 'pointerdown', this.onPointerDown)
    this.listen(o, 'pointermove', this.onPointerMove)
    this.listen(o, 'pointerup', this.onPointerUp)
    this.listen(o, 'pointercancel', this.onPointerCancel)
    this.listen(o, 'lostpointercapture', this.onLostCapture)
    this.listen(o, 'pointerenter', this.onPointerEnter)
    this.listen(o, 'pointerleave', this.onPointerLeave)
    this.listen(o, 'wheel', this.onWheel, { passive: false })
    this.listen(o, 'contextmenu', this.onContextMenu)
    this.listen(o, 'dblclick', this.onDoubleClick)
    this.listen(o, 'mousedown', this.onMouseDown)
    const onScroll = () => this.updateClientRect()
    this.win.addEventListener('scroll', onScroll, { capture: true, passive: true })
    this.cleanups.push(() => this.win.removeEventListener('scroll', onScroll, { capture: true }))
  }

  private observeSize(): void {
    const win = this.win
    if (typeof win.ResizeObserver === 'function') {
      const ro = new win.ResizeObserver((entries) => {
        const e = entries[entries.length - 1]
        if (!e) return
        const dp = e.devicePixelContentBoxSize?.[0]
        this.applySize(e.contentRect.width, e.contentRect.height, dp?.inlineSize, dp?.blockSize)
      })
      try {
        ro.observe(this.overlay, { box: 'device-pixel-content-box' })
      } catch {
        ro.observe(this.overlay)
      }
      this.cleanups.push(() => ro.disconnect())
    } else {
      const measure = () => {
        const r = this.overlay.getBoundingClientRect()
        this.applySize(r.width, r.height)
      }
      win.addEventListener('resize', measure)
      this.cleanups.push(() => win.removeEventListener('resize', measure))
      measure()
    }
    // devicePixelRatio changes without a CSS size change (window moved to another monitor).
    if (typeof win.matchMedia === 'function') {
      let mq: MediaQueryList | null = null
      const onChange = () => {
        this.applySize(this.width, this.height)
        watch()
      }
      const watch = () => {
        mq?.removeEventListener('change', onChange)
        mq = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`)
        mq.addEventListener('change', onChange)
      }
      watch()
      this.cleanups.push(() => mq?.removeEventListener('change', onChange))
    }
  }

  private observeTheme(): void {
    const win = this.win
    const markColors = () => {
      this.colorsDirty = true
      this.dirtyImage = true
      this.dirtyOverlay = true
      this.schedule()
    }
    if (typeof win.MutationObserver === 'function') {
      const mo = new win.MutationObserver(markColors)
      const doc = this.container.ownerDocument
      mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
      if (doc.body) mo.observe(doc.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
      this.cleanups.push(() => mo.disconnect())
    }
    if (typeof win.matchMedia === 'function') {
      const mq = win.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', markColors)
      this.cleanups.push(() => mq.removeEventListener('change', markColors))
    }
    const fonts = (this.container.ownerDocument as Document & { fonts?: FontFaceSet }).fonts
    if (fonts && typeof fonts.addEventListener === 'function') {
      const onFonts = () => {
        this.renderer?.invalidateText()
        this.requestOverlay()
      }
      fonts.addEventListener('loadingdone', onFonts)
      this.cleanups.push(() => fonts.removeEventListener('loadingdone', onFonts))
    }
  }

  // -------------------------------------------------------------------------------------------
  // Props

  setProps(p: AnnotationCanvasProps): void {
    if (this.destroyed) return
    const prev = this.props
    this.props = p
    const imageChanged = prev === null || prev.imageKey !== p.imageKey
    const dimsChanged = prev === null || prev.imageWidth !== p.imageWidth || prev.imageHeight !== p.imageHeight
    if (imageChanged && prev !== null) {
      this.abortGesture()
      this.clearOptimistic()
    }
    if (this.optimistic && p.boxes !== this.optimistic.base) this.clearOptimistic()
    if (imageChanged || dimsChanged) {
      this.needsFit = true
      this.tryFit()
    }
    if (prev === null || prev.image !== p.image) {
      this.watchImage(p.image)
      this.dirtyImage = true
    }
    if (p.selectedIds !== this.selectedSrc) {
      this.selectedSrc = p.selectedIds
      this.selectedSet = new Set(p.selectedIds)
    }
    if (p.readOnly && !(prev?.readOnly ?? false)) {
      const k = this.gesture.kind
      if (k === 'draw' || k === 'move' || k === 'resize' || k === 'pending') this.cancelGesture()
    }
    this.dirtyOverlay = true
    if (this.activePointer === null) this.updateHover()
    else this.updateCursor()
    this.schedule()
  }

  private watchImage(img: AnnotationCanvasProps['image']): void {
    this.imageLoadCleanup?.()
    this.imageLoadCleanup = null
    const HTMLImage = this.win.HTMLImageElement
    if (img && typeof HTMLImage === 'function' && img instanceof HTMLImage && !img.complete) {
      const onLoad = () => {
        this.dirtyImage = true
        this.schedule()
      }
      img.addEventListener('load', onLoad, { once: true })
      this.imageLoadCleanup = () => img.removeEventListener('load', onLoad)
    }
  }

  /** Boxes to draw and hit test: a just-committed result until the new prop arrives. */
  private boxes(): readonly CanvasBox[] {
    const p = this.props
    if (!p) return []
    if (this.optimistic && this.optimistic.base === p.boxes) return this.optimistic.next
    return p.boxes
  }

  private setOptimistic(next: CanvasBox[]): void {
    if (!this.props) return
    this.optimistic = { base: this.props.boxes, next }
    if (this.optimisticTimer !== null) clearTimeout(this.optimisticTimer)
    this.optimisticTimer = setTimeout(() => {
      this.optimisticTimer = null
      if (this.optimistic) {
        this.optimistic = null
        this.requestOverlay()
        if (this.activePointer === null) this.updateHover()
      }
    }, OPTIMISTIC_MS)
  }

  private clearOptimistic(): void {
    this.optimistic = null
    if (this.optimisticTimer !== null) clearTimeout(this.optimisticTimer)
    this.optimisticTimer = null
  }

  private context(): GestureContext {
    const p = this.props!
    const c = this.gctx
    c.view = this.view
    c.imageWidth = p.imageWidth
    c.imageHeight = p.imageHeight
    c.boxes = this.boxes()
    c.selectedIds = p.selectedIds
    c.tool = p.tool
    c.readOnly = p.readOnly ?? false
    c.placingPin = p.placingPin ?? false
    c.pins = p.pins ?? null
    c.defaultClassId = p.defaultClassId ?? null
    return c
  }

  // -------------------------------------------------------------------------------------------
  // View

  private setView(v: ViewState, user: boolean): void {
    const p = this.props
    const next = p ? constrainView(v, p.imageWidth, p.imageHeight, this.width, this.height) : v
    if (user) this.autoFit = false
    if (viewsEqual(next, this.view)) return
    this.view = next
    this.dirtyImage = true
    this.dirtyOverlay = true
    this.schedule()
    p?.onViewChange?.({ scale: next.scale, tx: next.tx, ty: next.ty })
  }

  private tryFit(): boolean {
    const p = this.props
    if (!p || this.width <= 0 || this.height <= 0 || p.imageWidth <= 0 || p.imageHeight <= 0) return false
    this.needsFit = false
    this.fit()
    return true
  }

  private fit(): void {
    const p = this.props
    if (!p || this.width <= 0 || this.height <= 0 || p.imageWidth <= 0 || p.imageHeight <= 0) return
    this.setView(fitView(p.imageWidth, p.imageHeight, this.width, this.height), false)
    this.autoFit = true
  }

  private applySize(cssW: number, cssH: number, devW?: number, devH?: number): void {
    if (this.destroyed) return
    const dpr = this.win.devicePixelRatio || 1
    const w = Math.max(0, cssW)
    const h = Math.max(0, cssH)
    const bw = Math.max(1, devW && devW > 0 ? devW : Math.round(w * dpr))
    const bh = Math.max(1, devH && devH > 0 ? devH : Math.round(h * dpr))
    for (const c of [this.imageCanvas, this.overlay]) {
      if (c.width !== bw) c.width = bw
      if (c.height !== bh) c.height = bh
    }
    const prevW = this.width
    const prevH = this.height
    this.width = w
    this.height = h
    this.dpr = w > 0 ? bw / w : dpr
    this.updateClientRect()
    if (w > 0 && h > 0) {
      if (this.needsFit) this.tryFit()
      else if (this.autoFit) this.fit()
      else if (prevW > 0 && prevH > 0 && (prevW !== w || prevH !== h)) {
        // Keep the image point at the centre where it was.
        const v = this.view
        this.setView({ scale: v.scale, tx: v.tx + (w - prevW) / 2, ty: v.ty + (h - prevH) / 2 }, false)
      }
    }
    // Resizing cleared the canvases: repaint now rather than on the next frame (no flicker).
    this.dirtyImage = true
    this.dirtyOverlay = true
    this.flush()
  }

  private updateClientRect(): void {
    const r = this.overlay.getBoundingClientRect()
    this.clientLeft = r.left
    this.clientTop = r.top
  }

  // -------------------------------------------------------------------------------------------
  // Drawing

  private schedule(): void {
    if (this.rafId !== 0 || this.destroyed) return
    if (!this.dirtyImage && !this.dirtyOverlay && !this.colorsDirty) return
    this.rafId = this.raf(this.frame)
  }

  private requestOverlay(): void {
    this.dirtyOverlay = true
    this.schedule()
  }

  private readonly frame = (): void => {
    this.rafId = 0
    if (!this.destroyed) this.render()
  }

  /** Draw synchronously (cancelling a pending frame). */
  private flush(): void {
    if (this.rafId !== 0) this.caf(this.rafId)
    this.rafId = 0
    this.render()
  }

  private readColors(): void {
    this.colorsDirty = false
    let accent = ''
    let backdrop = ''
    try {
      const cs = this.win.getComputedStyle(this.container)
      accent = cs.getPropertyValue('--accent').trim()
      backdrop = cs.getPropertyValue('--canvas').trim()
    } catch {
      // keep fallbacks
    }
    this.accent = accent || DEFAULT_ACCENT
    this.backdrop = backdrop || DEFAULT_CANVAS
  }

  private syncStyles(p: AnnotationCanvasProps): void {
    const fo = p.fillOpacity ?? 0.16
    if (p.classes !== this.stylesSrc || fo !== this.stylesOpacity) {
      this.stylesSrc = p.classes
      this.stylesOpacity = fo
      this.styles = buildStyles(p.classes, fo)
      this.unknown = unknownStyle(fo)
    }
    if (this.accent !== this.accentStyleColor || fo !== this.accentStyleOpacity) {
      this.accentStyleColor = this.accent
      this.accentStyleOpacity = fo
      this.accentStyle = makeStyle(this.accent, null, fo * 0.75)
    }
  }

  private render(): void {
    if (this.colorsDirty) this.readColors()
    const p = this.props
    if (!p || this.width <= 0 || this.height <= 0) return
    if (this.dirtyImage) {
      this.dirtyImage = false
      const ctx = this.imageCtx
      if (ctx) {
        const ip = this.imageParams
        ip.width = this.width
        ip.height = this.height
        ip.dpr = this.dpr
        ip.view = this.view
        ip.image = p.image
        ip.imageWidth = p.imageWidth
        ip.imageHeight = p.imageHeight
        ip.backdrop = this.backdrop
        if (this.dpr !== this.patternDpr || this.backdrop !== this.patternBackdrop) {
          this.patternDpr = this.dpr
          this.patternBackdrop = this.backdrop
          try {
            ip.pattern = createDotPattern(ctx, this.dpr, isLight(this.backdrop))
          } catch {
            ip.pattern = null
          }
        }
        drawImageLayer(ctx, ip)
      }
    }
    if (this.dirtyOverlay) {
      this.dirtyOverlay = false
      if (this.renderer) this.renderer.draw(this.fillScene(p))
    }
  }

  private fillScene(p: AnnotationCanvasProps): OverlayScene {
    this.syncStyles(p)
    const s = this.scene
    const g = this.gesture
    const boxes = this.boxes()
    s.width = this.width
    s.height = this.height
    s.dpr = this.dpr
    s.view = this.view
    s.boxes = boxes
    s.styles = this.styles
    s.unknown = this.unknown
    s.selected = this.selectedSet
    s.hoverId = isDragKind(g.kind) ? null : hoverBoxId(this.hover)
    s.highlightId = p.highlightId ?? null
    s.showLabels = p.showLabels ?? true
    s.strokeWidth = p.strokeWidth !== undefined && p.strokeWidth > 0 ? p.strokeWidth : 2
    s.accent = this.accent
    const editable = !(p.readOnly ?? false) && p.imageWidth > 0 && p.imageHeight > 0
    s.handleId = editable && g.kind !== 'marquee' ? (handleBoxFor(boxes, p.selectedIds)?.id ?? null) : null
    s.moveIds = g.kind === 'move' ? g.ids : null
    s.moveDx = g.kind === 'move' ? g.dx : 0
    s.moveDy = g.kind === 'move' ? g.dy : 0
    s.resizeId = g.kind === 'resize' ? g.boxId : null
    s.resizeRect = g.kind === 'resize' ? g.rect : null
    s.draft = g.kind === 'draw' ? g.rect : null
    if (s.draft !== null) {
      const dc = p.defaultClassId
      s.draftStyle = dc !== undefined && dc !== null ? (this.styles.get(dc) ?? this.accentStyle) : this.accentStyle
    }
    s.marquee = g.kind === 'marquee' ? g.rect : null
    s.marqueeAdditive = g.kind === 'marquee' && g.additive
    s.crosshair =
      (p.showCrosshair ?? true) && this.pointerInside && p.tool !== 'pan' && g.kind !== 'pan' && g.kind !== 'ignore'
    s.pointerX = this.ptr.x
    s.pointerY = this.ptr.y
    s.pins = p.pins ?? null
    return s
  }

  // -------------------------------------------------------------------------------------------
  // Gesture plumbing

  private setGesture(g: Gesture): void {
    const prev = this.gesture
    if (prev === g) return
    this.gesture = g
    if (prev.kind !== g.kind) {
      this.setKeyListening(g.kind !== 'idle')
      if (isDragKind(g.kind)) this.hover = NO_HIT
      const drag = isDragKind(g.kind) ? g.kind : null
      if (drag !== this.reportedDrag) {
        this.reportedDrag = drag
        this.props?.onGestureChange?.(drag)
      }
    }
    this.updateCursor()
    this.requestOverlay()
  }

  /** Drop the active gesture without any effect (image changed under it). */
  private abortGesture(): void {
    if (this.gesture.kind === 'idle') return
    this.setGesture(this.activePointer !== null ? cancelStep(this.gesture).gesture : IDLE)
  }

  private apply(e: Effects | null): void {
    const p = this.props
    if (!e || !p) return
    if (e.view) this.setView(e.view, true)
    if (e.selection) p.onSelectionChange(e.selection)
    if (e.commit) p.onBoxesChange(e.commit.next, e.commit.meta)
    if (e.created) p.onBoxCreated?.(e.created.box, e.created.anchor)
    if (e.pinPlace) p.onPinPlace?.({ x: e.pinPlace.x, y: e.pinPlace.y })
    if (e.pinClick) p.onPinClick?.(e.pinClick)
  }

  private setKeyListening(on: boolean): void {
    if (on === this.keyListening) return
    this.keyListening = on
    const win = this.win
    if (on) {
      win.addEventListener('keydown', this.onKeyDown, true)
      win.addEventListener('keyup', this.onKeyUp, true)
      win.addEventListener('blur', this.onWindowBlur)
    } else {
      win.removeEventListener('keydown', this.onKeyDown, true)
      win.removeEventListener('keyup', this.onKeyUp, true)
      win.removeEventListener('blur', this.onWindowBlur)
    }
  }

  private updateHover(): void {
    const p = this.props
    if (!p || this.activePointer !== null) return
    const h = this.pointerInside ? hoverTarget(this.context(), this.ptr.x, this.ptr.y) : NO_HIT
    const changed = hoverBoxId(h) !== hoverBoxId(this.hover)
    this.hover = h
    if (changed) this.requestOverlay()
    this.updateCursor()
  }

  private updateCursor(): void {
    if (!this.props) return
    const c = cursorFor(this.context(), this.gesture, this.hover)
    if (c !== this.cursor) {
      this.cursor = c
      this.overlay.style.cursor = c
    }
  }

  private reportCursor(): void {
    const cb = this.props?.onCursorMove
    if (!cb) return
    if (!this.pointerInside && this.activePointer === null) {
      if (this.cursorReported) {
        this.cursorReported = false
        cb(null)
      }
      return
    }
    const v = this.view
    const x = (this.ptr.x - v.tx) / v.scale
    const y = (this.ptr.y - v.ty) / v.scale
    if (this.cursorReported && x === this.lastCursorX && y === this.lastCursorY) return
    this.cursorReported = true
    this.lastCursorX = x
    this.lastCursorY = y
    cb({ x, y })
  }

  private readSample(e: MouseEvent): PointerSample {
    const s = this.ptr
    s.x = e.clientX - this.clientLeft
    s.y = e.clientY - this.clientTop
    s.button = e.button
    s.shift = e.shiftKey
    s.alt = e.altKey
    s.ctrl = e.ctrlKey
    s.meta = e.metaKey
    this.pointerInside = s.x >= 0 && s.y >= 0 && s.x < this.width && s.y < this.height
    return s
  }

  private runMove(): void {
    const r = pointerMove(this.gesture, this.ptr, this.context())
    this.setGesture(r.gesture)
    this.apply(r.effects)
  }

  private finishPointer(): void {
    const id = this.activePointer
    this.activePointer = null
    if (id !== null) {
      try {
        if (this.overlay.hasPointerCapture?.(id)) this.overlay.releasePointerCapture(id)
      } catch {
        // already released
      }
    }
    const r = pointerUp(this.gesture, this.ptr, this.context())
    this.lastUpWasClick = r.effects?.click === true
    this.setGesture(r.gesture)
    if (r.effects?.commit) this.setOptimistic(r.effects.commit.next)
    this.apply(r.effects)
    this.updateHover()
  }

  // -------------------------------------------------------------------------------------------
  // DOM event handlers

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.props || this.activePointer !== null) return
    if (e.button === 2) return
    if (e.button === 0 && e.ctrlKey && IS_MAC) return // macOS ctrl+click opens the context menu
    this.updateClientRect()
    const s = this.readSample(e)
    if (e.button === 1) e.preventDefault()
    const r = pointerDown(this.gesture, s, this.context())
    if (r.gesture.kind !== 'idle') {
      this.activePointer = e.pointerId
      try {
        this.overlay.setPointerCapture?.(e.pointerId)
      } catch {
        // capture is best effort (synthetic events, detached nodes)
      }
    }
    this.setGesture(r.gesture)
    this.apply(r.effects)
    this.reportCursor()
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.props) return
    const active = this.activePointer !== null
    if (active ? e.pointerId !== this.activePointer : !e.isPrimary) return
    this.readSample(e)
    if (active) {
      if (e.buttons === 0 && e.pointerType === 'mouse') {
        // The release happened somewhere we did not hear about.
        this.finishPointer()
        return
      }
      this.runMove()
    } else {
      this.updateHover()
    }
    this.reportCursor()
    if (this.props.showCrosshair ?? true) this.requestOverlay()
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (!this.props || e.pointerId !== this.activePointer) return
    this.readSample(e)
    this.finishPointer()
    this.reportCursor()
  }

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.activePointer) return
    this.cancelGesture()
    this.activePointer = null
    this.setGesture(IDLE)
    this.updateHover()
  }

  private readonly onLostCapture = (e: PointerEvent): void => {
    // Fires after pointerup too; only an unexpected loss (still active) cancels.
    if (e.pointerId !== this.activePointer) return
    this.onPointerCancel(e)
  }

  private readonly onPointerEnter = (): void => {
    this.updateClientRect()
  }

  private readonly onPointerLeave = (): void => {
    if (this.activePointer !== null) return
    this.pointerInside = false
    this.hover = NO_HIT
    this.updateCursor()
    this.reportCursor()
    this.requestOverlay()
  }

  private readonly onWheel = (e: WheelEvent): void => {
    const p = this.props
    if (!p) return
    e.preventDefault()
    const x = e.clientX - this.clientLeft
    const y = e.clientY - this.clientTop
    const d = wheelDeltaPx(e.deltaX, e.deltaY, e.deltaMode, this.height)
    const next = applyWheel(
      this.view,
      { dx: d.x, dy: d.y, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, x, y },
      p.wheel ?? 'zoom',
    )
    this.setView(next, true)
    if (isDragKind(this.gesture.kind)) this.runMove()
    else if (this.activePointer === null) this.updateHover()
    this.reportCursor()
  }

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    const p = this.props
    if (!p?.onContextMenu || this.activePointer !== null) return
    const x = e.clientX - this.clientLeft
    const y = e.clientY - this.clientTop
    const ip = screenToImage(this.view, x, y)
    const box = hitTestBoxes(this.boxes(), ip.x, ip.y, BOX_HIT_SLOP / this.view.scale)
    p.onContextMenu({ clientX: e.clientX, clientY: e.clientY, boxId: box?.id ?? null })
  }

  private readonly onDoubleClick = (e: MouseEvent): void => {
    const p = this.props
    if (!p?.onBoxDoubleClick || !this.lastUpWasClick || p.placingPin || p.tool === 'pan') return
    const x = e.clientX - this.clientLeft
    const y = e.clientY - this.clientTop
    const ip = screenToImage(this.view, x, y)
    const box = hitTestBoxes(this.boxes(), ip.x, ip.y, BOX_HIT_SLOP / this.view.scale)
    if (box) p.onBoxDoubleClick(box.id, boxAnchor(this.view, box))
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 1) e.preventDefault() // no middle-click autoscroll
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.gesture.kind === 'idle') return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      this.cancelGesture()
      return
    }
    this.onModifierKey(e)
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (this.gesture.kind === 'idle') return
    this.onModifierKey(e)
  }

  private onModifierKey(e: KeyboardEvent): void {
    if (e.key !== 'Shift' && e.key !== 'Alt' && e.key !== 'Control' && e.key !== 'Meta') return
    if (e.key === 'Alt') e.preventDefault() // keep the browser menu bar out of the way
    const s = this.ptr
    s.shift = e.shiftKey
    s.alt = e.altKey
    s.ctrl = e.ctrlKey
    s.meta = e.metaKey
    if (isDragKind(this.gesture.kind)) this.runMove()
  }

  private readonly onWindowBlur = (): void => {
    this.cancelGesture()
  }

  // -------------------------------------------------------------------------------------------
  // Imperative handle

  cancelGesture(): void {
    if (this.gesture.kind === 'idle' || this.gesture.kind === 'ignore') return
    const r = cancelStep(this.gesture)
    this.setGesture(this.activePointer !== null ? r.gesture : IDLE)
    this.apply(r.effects)
  }

  isGestureActive(): boolean {
    return this.activePointer !== null
  }

  zoomToFit(): void {
    this.fit()
  }

  zoomToActual(): void {
    if (this.width <= 0 || this.height <= 0) return
    this.setView(actualSizeView(this.view, this.width, this.height), true)
  }

  zoomBy(factor: number): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return
    this.setView(zoomAt(this.view, factor, this.width / 2, this.height / 2), true)
  }

  revealBox(boxId: string): void {
    const b = this.findBox(boxId)
    if (!b || this.width <= 0 || this.height <= 0) return
    this.setView(revealRect(this.view, normalizeRect(b), this.width, this.height), true)
  }

  getView(): ViewState {
    return { scale: this.view.scale, tx: this.view.tx, ty: this.view.ty }
  }

  boxScreenRect(boxId: string): ScreenRect | null {
    const b = this.findBox(boxId)
    return b ? rectToScreen(this.view, b) : null
  }

  screenToImage(p: { x: number; y: number }): { x: number; y: number } {
    return screenToImage(this.view, p.x, p.y)
  }

  imageToScreen(p: { x: number; y: number }): { x: number; y: number } {
    return imageToScreen(this.view, p.x, p.y)
  }

  private findBox(id: string): CanvasBox | undefined {
    for (const b of this.boxes()) if (b.id === id) return b
    return undefined
  }
}
