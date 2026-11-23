// Canvas 2D drawing. Everything here takes a context plus plain data; no React, no events.
// The overlay renderer keeps reusable typed-array buffers so a frame allocates (almost) nothing.
import { brighten, contrastText, isLight, parseColor, rgba, toHex, UNKNOWN_CLASS_COLOR, type RGB } from './color'
import type { Rect } from './geometry'
import { edgeHandleActive, HANDLE_SIZE, PIN_RADIUS } from './hittest'
import type { CanvasBox, CanvasClass, CanvasPin, ViewState } from './types'
import { imageSmoothingFor } from './view'

export const CHIP_FONT = '600 11px "Inter Variable", Inter, "Segoe UI", system-ui, sans-serif'
export const PIN_FONT = '700 11px "Inter Variable", Inter, "Segoe UI", system-ui, sans-serif'
export const SIZE_FONT = '500 11px "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Consolas, monospace'
export const CHIP_HEIGHT = 16
const CHIP_PAD = 5
const CHIP_MAX_CHARS = 28
const LOCK_GLYPH_W = 10
/** Boxes smaller than this on screen (CSS px, either side) get no chip unless emphasised. */
export const CHIP_MIN_BOX = 8
export const PIN_COLOR = '#F28A2E'
const PIN_RESOLVED_COLOR = '#5c6472'
const SELECTED_STROKE = '#ffffff'

const NO_DASH: number[] = []
const LOCKED_DASH: number[] = [6, 4]
const UNKNOWN_DASH: number[] = [4, 3]
const DRAFT_DASH: number[] = [5, 4]
const MARQUEE_DASH: number[] = [4, 3]
const CROSS_DASH: number[] = [4, 4]
const DASHES: readonly number[][] = [NO_DASH, LOCKED_DASH, UNKNOWN_DASH]
const CHIP_RADII_ABOVE: number[] = [3, 3, 0, 0]
const CHIP_RADII_INSIDE: number[] = [0, 0, 3, 0]

// ---------------------------------------------------------------------------------------------
// Styles

export interface BoxStyle {
  /** Class name, or null for the shared "unknown class" style. */
  name: string | null
  stroke: string
  /** Brighter stroke for hover/highlight. */
  hover: string
  fill: string
  /** Stronger fill for the highlighted box. */
  fillStrong: string
  chip: string
  chipText: string
  /** Dashed outline (unknown class). */
  dashed: boolean
}

export type StyleMap = ReadonlyMap<number, BoxStyle>

const FALLBACK_RGB: RGB = { r: 138, g: 147, b: 163 }

export function makeStyle(color: string, name: string | null, fillOpacity: number, dashed = false): BoxStyle {
  const c = parseColor(color) ?? FALLBACK_RGB
  const a = Math.max(0, Math.min(1, fillOpacity))
  return {
    name,
    stroke: toHex(c),
    hover: toHex(brighten(c, 0.35)),
    fill: rgba(c, a),
    fillStrong: rgba(c, Math.min(1, Math.max(a * 2, a + 0.12))),
    chip: toHex(c),
    chipText: contrastText(c),
    dashed,
  }
}

export function buildStyles(classes: readonly CanvasClass[], fillOpacity: number): Map<number, BoxStyle> {
  const m = new Map<number, BoxStyle>()
  for (const c of classes) m.set(c.id, makeStyle(c.color, c.name, fillOpacity))
  return m
}

export function unknownStyle(fillOpacity: number): BoxStyle {
  return makeStyle(UNKNOWN_CLASS_COLOR, null, fillOpacity * 0.75, true)
}

export function styleOf(b: CanvasBox, styles: StyleMap, unknown: BoxStyle): BoxStyle {
  if (b.classId === null) return unknown
  return styles.get(b.classId) ?? unknown
}

/** Chip text: class name; for unknown classes the raw label, else "?" (no class) or "#id". */
export function labelFor(b: CanvasBox, styles: StyleMap): string {
  if (b.classId !== null) {
    const st = styles.get(b.classId)
    if (st && st.name !== null) return st.name
  }
  if (b.rawLabel) return b.rawLabel
  return b.classId === null ? '?' : `#${b.classId}`
}

// ---------------------------------------------------------------------------------------------
// Image layer

export type CanvasImage = ImageBitmap | HTMLImageElement | HTMLCanvasElement

export interface ImageLayerParams {
  /** CSS px */
  width: number
  height: number
  dpr: number
  view: ViewState
  image: CanvasImage | null
  imageWidth: number
  imageHeight: number
  backdrop: string
  pattern: CanvasPattern | null
}

/** Natural pixel size of a drawable, or [0, 0] when it cannot be drawn (not loaded, closed). */
export function sourceSize(img: CanvasImage): [number, number] {
  if ('naturalWidth' in img) {
    if (!img.complete) return [0, 0]
    return [img.naturalWidth, img.naturalHeight]
  }
  return [img.width, img.height]
}

/** Subtle dot grid for the backdrop, in device px. */
export function createDotPattern(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  lightBackdrop: boolean,
): CanvasPattern | null {
  const doc = ctx.canvas.ownerDocument
  if (!doc) return null
  const size = Math.max(1, Math.round(16 * dpr))
  const tile = doc.createElement('canvas')
  tile.width = size
  tile.height = size
  const t = tile.getContext('2d')
  if (!t) return null
  t.fillStyle = lightBackdrop ? 'rgba(15, 23, 42, 0.06)' : 'rgba(255, 255, 255, 0.035)'
  t.beginPath()
  t.arc(dpr, dpr, Math.max(0.5, dpr), 0, Math.PI * 2)
  t.fill()
  return ctx.createPattern(tile, 'repeat')
}

export function drawImageLayer(ctx: CanvasRenderingContext2D, p: ImageLayerParams): void {
  const { width, height, dpr, view } = p
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = p.backdrop
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  if (p.pattern) {
    ctx.fillStyle = p.pattern
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const img = p.image
  const iw = p.imageWidth
  const ih = p.imageHeight
  if (!img || iw <= 0 || ih <= 0) return
  const [srcW, srcH] = sourceSize(img)
  if (srcW <= 0 || srcH <= 0) return

  const s = view.scale
  const x0 = view.tx
  const y0 = view.ty
  const x1 = x0 + iw * s
  const y1 = y0 + ih * s
  if (x1 <= 0 || y1 <= 0 || x0 >= width || y0 >= height) return
  const light = isLight(p.backdrop)

  // Drop shadow, only when some backdrop is visible; the rect is limited to the viewport so the
  // blur cost does not grow with the zoom level.
  if (x0 > 0 || y0 > 0 || x1 < width || y1 < height) {
    const m = 64
    const rx0 = Math.max(x0, -m)
    const ry0 = Math.max(y0, -m)
    const rx1 = Math.min(x1, width + m)
    const ry1 = Math.min(y1, height + m)
    ctx.save()
    ctx.shadowColor = light ? 'rgba(15, 23, 42, 0.22)' : 'rgba(0, 0, 0, 0.55)'
    ctx.shadowBlur = 28 * dpr
    ctx.shadowOffsetY = 8 * dpr
    ctx.fillStyle = light ? '#ffffff' : '#000000'
    ctx.fillRect(rx0, ry0, rx1 - rx0, ry1 - ry0)
    ctx.restore()
  }

  // Only the visible part of the source, snapped to whole image pixels (pixel-exact when zoomed).
  const kx = srcW / iw
  const ky = srcH / ih
  const ix0 = Math.max(0, Math.floor(-x0 / s))
  const iy0 = Math.max(0, Math.floor(-y0 / s))
  const ix1 = Math.min(iw, Math.ceil((width - x0) / s))
  const iy1 = Math.min(ih, Math.ceil((height - y0) / s))
  if (ix1 > ix0 && iy1 > iy0) {
    const smooth = imageSmoothingFor(s / Math.min(kx, ky))
    ctx.imageSmoothingEnabled = smooth
    if (smooth) ctx.imageSmoothingQuality = s < 1 ? 'medium' : 'low'
    try {
      ctx.drawImage(
        img,
        ix0 * kx,
        iy0 * ky,
        (ix1 - ix0) * kx,
        (iy1 - iy0) * ky,
        x0 + ix0 * s,
        y0 + iy0 * s,
        (ix1 - ix0) * s,
        (iy1 - iy0) * s,
      )
    } catch {
      // A bitmap closed by the image cache or a broken image: keep the backdrop.
    }
  }

  ctx.lineWidth = 1
  ctx.strokeStyle = light ? 'rgba(15, 23, 42, 0.12)' : 'rgba(255, 255, 255, 0.07)'
  const off = 0.5 / dpr
  ctx.strokeRect(Math.round(x0 * dpr) / dpr - off, Math.round(y0 * dpr) / dpr - off, iw * s + 2 * off, ih * s + 2 * off)
}

// ---------------------------------------------------------------------------------------------
// Overlay

export interface OverlayScene {
  /** CSS px */
  width: number
  height: number
  dpr: number
  view: ViewState
  boxes: readonly CanvasBox[]
  styles: StyleMap
  unknown: BoxStyle
  selected: ReadonlySet<string>
  hoverId: string | null
  highlightId: string | null
  /** Box whose resize handles are drawn (single editable selection). */
  handleId: string | null
  showLabels: boolean
  strokeWidth: number
  accent: string
  /** Move preview: these ids are drawn offset by (moveDx, moveDy) image px. */
  moveIds: ReadonlySet<string> | null
  moveDx: number
  moveDy: number
  /** Resize preview. */
  resizeId: string | null
  resizeRect: Rect | null
  /** Box being drawn (image px). */
  draft: Rect | null
  draftStyle: BoxStyle | null
  /** Marquee (image px, normalised). */
  marquee: Rect | null
  marqueeAdditive: boolean
  crosshair: boolean
  pointerX: number
  pointerY: number
  pins: readonly CanvasPin[] | null
}

const EMPTY_SET: ReadonlySet<string> = new Set()
const EMPTY_STYLES: StyleMap = new Map()

export function createScene(): OverlayScene {
  const unknown = unknownStyle(0.16)
  return {
    width: 0,
    height: 0,
    dpr: 1,
    view: { scale: 1, tx: 0, ty: 0 },
    boxes: [],
    styles: EMPTY_STYLES,
    unknown,
    selected: EMPTY_SET,
    hoverId: null,
    highlightId: null,
    handleId: null,
    showLabels: true,
    strokeWidth: 2,
    accent: '#3D8FD6',
    moveIds: null,
    moveDx: 0,
    moveDy: 0,
    resizeId: null,
    resizeRect: null,
    draft: null,
    draftStyle: null,
    marquee: null,
    marqueeAdditive: false,
    crosshair: false,
    pointerX: 0,
    pointerY: 0,
    pins: null,
  }
}

const F_VISIBLE = 1
const F_SELECTED = 2
const F_HOVER = 4
const F_HIGHLIGHT = 8
const CULL_MARGIN = 24

interface ChipText {
  text: string
  width: number
}

function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr
}

/** Offset that puts an odd-device-pixel-wide line on pixel centres. */
function halfPixel(lineWidth: number, dpr: number): number {
  return (Math.round(lineWidth * dpr) & 1) === 1 ? 0.5 / dpr : 0
}

export class OverlayRenderer {
  private rects = new Float64Array(0)
  private flags = new Uint8Array(0)
  private texts = new Map<string, ChipText>()
  private readonly ctx: CanvasRenderingContext2D
  private readonly hasRoundRect: boolean

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx
    this.hasRoundRect = typeof (ctx as { roundRect?: unknown }).roundRect === 'function'
  }

  /** Forget measured label widths (call after web fonts finish loading). */
  invalidateText(): void {
    this.texts.clear()
  }

  private ensureCapacity(n: number): void {
    if (this.flags.length >= n) return
    const cap = Math.max(n, this.flags.length * 2, 256)
    this.rects = new Float64Array(cap * 4)
    this.flags = new Uint8Array(cap)
  }

  /** Truncated label and its width under CHIP_FONT (ctx.font must already be CHIP_FONT). */
  private chipText(label: string): ChipText {
    let t = this.texts.get(label)
    if (!t) {
      const text = label.length > CHIP_MAX_CHARS ? `${label.slice(0, CHIP_MAX_CHARS - 1)}…` : label
      t = { text, width: this.ctx.measureText(text).width }
      if (this.texts.size > 4000) this.texts.clear()
      this.texts.set(label, t)
    }
    return t
  }

  draw(s: OverlayScene): void {
    const ctx = this.ctx
    const dpr = s.dpr
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.lineJoin = 'miter'
    ctx.setLineDash(NO_DASH)

    const boxes = s.boxes
    const n = boxes.length
    this.ensureCapacity(n)
    const R = this.rects
    const F = this.flags
    const { scale, tx, ty } = s.view
    const W = s.width
    const H = s.height
    const marquee = s.marquee
    const moveIds = s.moveIds
    const resizeRect = s.resizeRect
    let emphasised = 0
    let handleIdx = -1

    // Pass 0: screen rects, culling and state flags.
    for (let i = 0; i < n; i++) {
      const b = boxes[i]!
      if (b.hidden) {
        F[i] = 0
        continue
      }
      let x1 = b.x1
      let y1 = b.y1
      let x2 = b.x2
      let y2 = b.y2
      let moving = false
      if (moveIds !== null && moveIds.has(b.id)) {
        x1 += s.moveDx
        x2 += s.moveDx
        y1 += s.moveDy
        y2 += s.moveDy
        moving = true
      } else if (resizeRect !== null && b.id === s.resizeId) {
        x1 = resizeRect.x1
        y1 = resizeRect.y1
        x2 = resizeRect.x2
        y2 = resizeRect.y2
      }
      const sx1 = snap((x1 < x2 ? x1 : x2) * scale + tx, dpr)
      const sx2 = snap((x1 < x2 ? x2 : x1) * scale + tx, dpr)
      const sy1 = snap((y1 < y2 ? y1 : y2) * scale + ty, dpr)
      const sy2 = snap((y1 < y2 ? y2 : y1) * scale + ty, dpr)
      const k = i * 4
      R[k] = sx1
      R[k + 1] = sy1
      R[k + 2] = sx2
      R[k + 3] = sy2
      if (sx2 < -CULL_MARGIN || sx1 > W + CULL_MARGIN || sy2 < -CULL_MARGIN || sy1 > H + CULL_MARGIN) {
        F[i] = 0
        continue
      }
      let f = F_VISIBLE
      let sel: boolean
      if (marquee !== null) {
        sel =
          (s.marqueeAdditive && s.selected.has(b.id)) ||
          (Math.min(b.x1, b.x2) < marquee.x2 &&
            Math.max(b.x1, b.x2) > marquee.x1 &&
            Math.min(b.y1, b.y2) < marquee.y2 &&
            Math.max(b.y1, b.y2) > marquee.y1)
      } else {
        sel = moving || s.selected.has(b.id)
      }
      if (sel) f |= F_SELECTED
      if (b.id === s.hoverId) f |= F_HOVER
      if (b.id === s.highlightId) f |= F_HIGHLIGHT
      if (f !== F_VISIBLE) emphasised++
      if (b.id === s.handleId) handleIdx = i
      F[i] = f
    }

    const sw = s.strokeWidth
    const half = halfPixel(sw, dpr)

    // Pass 1: plain boxes, minimising state changes.
    ctx.lineWidth = sw
    let curFill = ''
    let curStroke = ''
    let curDash = 0
    for (let i = 0; i < n; i++) {
      if (F[i] !== F_VISIBLE) continue
      const b = boxes[i]!
      const st = styleOf(b, s.styles, s.unknown)
      const k = i * 4
      const x = R[k]!
      const y = R[k + 1]!
      const w = R[k + 2]! - x
      const h = R[k + 3]! - y
      if (st.fill !== curFill) {
        ctx.fillStyle = st.fill
        curFill = st.fill
      }
      ctx.fillRect(x, y, w, h)
      const dash = b.locked ? 1 : st.dashed ? 2 : 0
      if (dash !== curDash) {
        ctx.setLineDash(DASHES[dash]!)
        curDash = dash
      }
      if (st.stroke !== curStroke) {
        ctx.strokeStyle = st.stroke
        curStroke = st.stroke
      }
      ctx.strokeRect(x + half, y + half, w, h)
    }
    if (curDash !== 0) ctx.setLineDash(NO_DASH)

    // Pass 2: hovered / highlighted, then selected on top.
    if (emphasised > 0) {
      for (let i = 0; i < n; i++) {
        const f = F[i]!
        if (f === 0 || f === F_VISIBLE || (f & F_SELECTED) !== 0) continue
        this.drawEmphasised(s, boxes[i]!, i, (f & F_HIGHLIGHT) !== 0, half)
      }
      for (let i = 0; i < n; i++) {
        const f = F[i]!
        if ((f & F_SELECTED) === 0) continue
        this.drawSelected(s, boxes[i]!, i, (f & (F_HOVER | F_HIGHLIGHT)) !== 0, half)
      }
    }

    if (s.draft !== null) this.drawDraft(s)
    if (marquee !== null) this.drawMarquee(s, marquee)
    if (s.crosshair) this.drawCrosshair(s)

    if (s.showLabels) {
      ctx.font = CHIP_FONT
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      for (let i = 0; i < n; i++) {
        if (F[i] !== F_VISIBLE) continue
        const k = i * 4
        if (R[k + 2]! - R[k]! < CHIP_MIN_BOX || R[k + 3]! - R[k + 1]! < CHIP_MIN_BOX) continue
        this.drawChip(s, boxes[i]!, i)
      }
      if (emphasised > 0) {
        for (let i = 0; i < n; i++) {
          const f = F[i]!
          if (f !== 0 && f !== F_VISIBLE) this.drawChip(s, boxes[i]!, i)
        }
      }
    }

    if (handleIdx >= 0 && F[handleIdx] !== 0) this.drawHandles(s, handleIdx)
    if (s.draft !== null) this.drawDraftSize(s, s.draft)
    if (s.pins !== null && s.pins.length > 0) this.drawPins(s, s.pins)
    ctx.globalAlpha = 1
  }

  private rectAt(i: number): [number, number, number, number] {
    const R = this.rects
    const k = i * 4
    return [R[k]!, R[k + 1]!, R[k + 2]! - R[k]!, R[k + 3]! - R[k + 1]!]
  }

  private drawEmphasised(s: OverlayScene, b: CanvasBox, i: number, highlight: boolean, half: number): void {
    const ctx = this.ctx
    const st = styleOf(b, s.styles, s.unknown)
    const k = i * 4
    const R = this.rects
    const x = R[k]!
    const y = R[k + 1]!
    const w = R[k + 2]! - x
    const h = R[k + 3]! - y
    const sw = s.strokeWidth
    if (highlight) {
      ctx.setLineDash(NO_DASH)
      ctx.globalAlpha = 0.4
      ctx.strokeStyle = st.stroke
      ctx.lineWidth = sw + 6
      ctx.strokeRect(x, y, w, h)
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = highlight ? st.fillStrong : st.fill
    ctx.fillRect(x, y, w, h)
    ctx.setLineDash(b.locked ? LOCKED_DASH : st.dashed ? UNKNOWN_DASH : NO_DASH)
    ctx.strokeStyle = st.hover
    ctx.lineWidth = sw + 1
    ctx.strokeRect(x + half, y + half, w, h)
    ctx.setLineDash(NO_DASH)
  }

  private drawSelected(s: OverlayScene, b: CanvasBox, i: number, emphasised: boolean, half: number): void {
    const ctx = this.ctx
    const st = styleOf(b, s.styles, s.unknown)
    const k = i * 4
    const R = this.rects
    const x = R[k]!
    const y = R[k + 1]!
    const w = R[k + 2]! - x
    const h = R[k + 3]! - y
    const sw = s.strokeWidth
    ctx.fillStyle = emphasised ? st.fillStrong : st.fill
    ctx.fillRect(x, y, w, h)
    ctx.setLineDash(NO_DASH)
    ctx.globalAlpha = 0.4
    ctx.strokeStyle = s.accent
    ctx.lineWidth = sw + 4
    ctx.strokeRect(x, y, w, h)
    ctx.globalAlpha = 1
    if (b.locked) ctx.setLineDash(LOCKED_DASH)
    ctx.strokeStyle = SELECTED_STROKE
    ctx.lineWidth = emphasised ? sw + 0.5 : sw
    ctx.strokeRect(x + half, y + half, w, h)
    ctx.setLineDash(NO_DASH)
  }

  private drawChip(s: OverlayScene, b: CanvasBox, i: number): void {
    const ctx = this.ctx
    const st = styleOf(b, s.styles, s.unknown)
    const k = i * 4
    const R = this.rects
    const x = R[k]!
    const y = R[k + 1]!
    const t = this.chipText(labelFor(b, s.styles))
    const out = s.strokeWidth / 2
    const cw = Math.ceil(t.width) + CHIP_PAD * 2 + (b.locked ? LOCK_GLYPH_W : 0)
    const cx = x - out
    let cy = y - out - CHIP_HEIGHT
    let inside = false
    // At the top edge of the image (or of the viewport) the chip goes inside the box.
    if (cy < Math.max(0, s.view.ty)) {
      cy = y + out
      inside = true
    }
    if (cx > s.width || cx + cw < 0 || cy > s.height || cy + CHIP_HEIGHT < 0) return
    ctx.fillStyle = st.chip
    if (this.hasRoundRect) {
      ctx.beginPath()
      ctx.roundRect(cx, cy, cw, CHIP_HEIGHT, inside ? CHIP_RADII_INSIDE : CHIP_RADII_ABOVE)
      ctx.fill()
    } else {
      ctx.fillRect(cx, cy, cw, CHIP_HEIGHT)
    }
    ctx.fillStyle = st.chipText
    ctx.fillText(t.text, cx + CHIP_PAD, cy + CHIP_HEIGHT / 2 + 0.5)
    if (b.locked) this.drawLockGlyph(cx + CHIP_PAD + Math.ceil(t.width) + 3, cy + CHIP_HEIGHT / 2, st.chipText)
  }

  private drawLockGlyph(x: number, cy: number, color: string): void {
    const ctx = this.ctx
    ctx.fillStyle = color
    ctx.fillRect(x, cy - 1, 7, 5)
    ctx.strokeStyle = color
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.arc(x + 3.5, cy - 1, 2.2, Math.PI, 0)
    ctx.stroke()
  }

  private drawHandles(s: OverlayScene, i: number): void {
    const ctx = this.ctx
    const dpr = s.dpr
    const [x, y, w, h] = this.rectAt(i)
    const hs = HANDLE_SIZE
    const hh = hs / 2
    const cx = x + w / 2
    const cy = y + h / 2
    const showH = edgeHandleActive(w)
    const showV = edgeHandleActive(h)
    ctx.setLineDash(NO_DASH)
    ctx.beginPath()
    const add = (px: number, py: number) => ctx.rect(snap(px - hh, dpr), snap(py - hh, dpr), hs, hs)
    add(x, y)
    add(x + w, y)
    add(x + w, y + h)
    add(x, y + h)
    if (showH) {
      add(cx, y)
      add(cx, y + h)
    }
    if (showV) {
      add(x, cy)
      add(x + w, cy)
    }
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = s.accent
    ctx.stroke()
  }

  private drawDraft(s: OverlayScene): void {
    const ctx = this.ctx
    const d = s.draft!
    const st = s.draftStyle ?? s.unknown
    const { scale, tx, ty } = s.view
    const x = snap(d.x1 * scale + tx, s.dpr)
    const y = snap(d.y1 * scale + ty, s.dpr)
    const w = snap(d.x2 * scale + tx, s.dpr) - x
    const h = snap(d.y2 * scale + ty, s.dpr) - y
    ctx.fillStyle = st.fill
    ctx.fillRect(x, y, w, h)
    ctx.setLineDash(DRAFT_DASH)
    ctx.lineWidth = s.strokeWidth
    ctx.strokeStyle = st.hover
    ctx.strokeRect(x + halfPixel(s.strokeWidth, s.dpr), y + halfPixel(s.strokeWidth, s.dpr), w, h)
    ctx.setLineDash(NO_DASH)
  }

  private drawDraftSize(s: OverlayScene, d: Rect): void {
    const ctx = this.ctx
    const text = `${Math.round(d.x2 - d.x1)} × ${Math.round(d.y2 - d.y1)}`
    ctx.font = SIZE_FONT
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    const tw = Math.ceil(ctx.measureText(text).width) + 10
    const th = 18
    const { scale, tx, ty } = s.view
    let x = d.x2 * scale + tx + 8
    let y = d.y2 * scale + ty + 8
    if (x + tw > s.width - 4) x = s.width - 4 - tw
    if (y + th > s.height - 4) y = s.height - 4 - th
    x = Math.max(4, x)
    y = Math.max(4, y)
    ctx.fillStyle = 'rgba(12, 14, 18, 0.85)'
    if (this.hasRoundRect) {
      ctx.beginPath()
      ctx.roundRect(x, y, tw, th, 4)
      ctx.fill()
    } else {
      ctx.fillRect(x, y, tw, th)
    }
    ctx.fillStyle = '#e7e9ee'
    ctx.fillText(text, x + 5, y + th / 2 + 0.5)
  }

  private drawMarquee(s: OverlayScene, m: Rect): void {
    const ctx = this.ctx
    const { scale, tx, ty } = s.view
    const x = snap(m.x1 * scale + tx, s.dpr)
    const y = snap(m.y1 * scale + ty, s.dpr)
    const w = snap(m.x2 * scale + tx, s.dpr) - x
    const h = snap(m.y2 * scale + ty, s.dpr) - y
    ctx.globalAlpha = 0.1
    ctx.fillStyle = s.accent
    ctx.fillRect(x, y, w, h)
    ctx.globalAlpha = 1
    ctx.setLineDash(MARQUEE_DASH)
    ctx.lineWidth = 1
    ctx.strokeStyle = s.accent
    const o = halfPixel(1, s.dpr)
    ctx.strokeRect(x + o, y + o, w, h)
    ctx.setLineDash(NO_DASH)
  }

  private drawCrosshair(s: OverlayScene): void {
    const ctx = this.ctx
    const dpr = s.dpr
    const o = halfPixel(1, dpr)
    const px = Math.floor(s.pointerX * dpr) / dpr + o
    const py = Math.floor(s.pointerY * dpr) / dpr + o
    ctx.beginPath()
    ctx.moveTo(0, py)
    ctx.lineTo(s.width, py)
    ctx.moveTo(px, 0)
    ctx.lineTo(px, s.height)
    ctx.setLineDash(NO_DASH)
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)'
    ctx.stroke()
    ctx.setLineDash(CROSS_DASH)
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)'
    ctx.stroke()
    ctx.setLineDash(NO_DASH)
  }

  private drawPins(s: OverlayScene, pins: readonly CanvasPin[]): void {
    const ctx = this.ctx
    const { scale, tx, ty } = s.view
    const r = PIN_RADIUS
    ctx.font = PIN_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.setLineDash(NO_DASH)
    // Resolved pins first so open ones stay on top.
    for (let pass = 0; pass < 2; pass++) {
      const resolvedPass = pass === 0
      for (let i = 0; i < pins.length; i++) {
        const p = pins[i]!
        if (Boolean(p.resolved) !== resolvedPass) continue
        const x = p.x * scale + tx
        const y = p.y * scale + ty
        if (x < -r || y < -r || x > s.width + r || y > s.height + r) continue
        ctx.globalAlpha = resolvedPass ? 0.55 : 1
        ctx.beginPath()
        ctx.arc(x, y, r + 2, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'
        ctx.fill()
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fillStyle = resolvedPass ? PIN_RESOLVED_COLOR : PIN_COLOR
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.fillText(p.label ?? String(i + 1), x, y + 0.5)
      }
    }
    ctx.globalAlpha = 1
    ctx.textAlign = 'left'
  }
}
