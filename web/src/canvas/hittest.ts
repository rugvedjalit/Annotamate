// Pure hit testing. Order: pins (drawn on top) -> handles of the single selected box -> the
// smallest visible box containing the point -> nothing.
import { boxArea, boxContains, boxesIntersect, HANDLES, isCornerHandle, type HandleId, type Rect } from './geometry'
import type { CanvasBox, CanvasPin, ViewState } from './types'

/** Drawn handle size (CSS px). */
export const HANDLE_SIZE = 8
/** Extra tolerance around a handle when hit testing (CSS px per side). */
export const HANDLE_HIT_SLOP = 2
/** Edge (non-corner) handles are only shown and hit on sides at least this long on screen. */
export const MIN_EDGE_HANDLE_SIDE = 24
/** Tolerance around box edges when hit testing (CSS px). */
export const BOX_HIT_SLOP = 3
/** Pin marker radius (CSS px). */
export const PIN_RADIUS = 10

export type HitTarget =
  | { kind: 'none' }
  | { kind: 'handle'; box: CanvasBox; handle: HandleId }
  | { kind: 'box'; box: CanvasBox }
  | { kind: 'pin'; pin: CanvasPin }

export const NO_HIT: HitTarget = Object.freeze({ kind: 'none' })

/**
 * The box whose handles are active: exactly one selected id that refers to an existing,
 * visible, unlocked box.
 */
export function handleBoxFor(boxes: readonly CanvasBox[], selectedIds: readonly string[]): CanvasBox | null {
  if (selectedIds.length !== 1) return null
  const id = selectedIds[0]
  for (const b of boxes) {
    if (b.id === id) return b.hidden || b.locked ? null : b
  }
  return null
}

/** Whether the edge handle on a side of the given screen length is active. */
export function edgeHandleActive(sideLength: number): boolean {
  return sideLength >= MIN_EDGE_HANDLE_SIDE
}

/** Handle of `box` under screen point (sx, sy), or null. The nearest wins; corners win ties. */
export function hitTestHandle(box: Rect, view: ViewState, sx: number, sy: number): HandleId | null {
  const s = view.scale
  const x1 = Math.min(box.x1, box.x2) * s + view.tx
  const x2 = Math.max(box.x1, box.x2) * s + view.tx
  const y1 = Math.min(box.y1, box.y2) * s + view.ty
  const y2 = Math.max(box.y1, box.y2) * s + view.ty
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  const r = HANDLE_SIZE / 2 + HANDLE_HIT_SLOP
  const showH = edgeHandleActive(x2 - x1)
  const showV = edgeHandleActive(y2 - y1)
  let best: HandleId | null = null
  let bestD = Infinity
  for (const h of HANDLES) {
    if (!isCornerHandle(h)) {
      if ((h === 'n' || h === 's') && !showH) continue
      if ((h === 'e' || h === 'w') && !showV) continue
    }
    const hx = h.includes('w') ? x1 : h.includes('e') ? x2 : cx
    const hy = h.includes('n') ? y1 : h.includes('s') ? y2 : cy
    const d = Math.max(Math.abs(sx - hx), Math.abs(sy - hy))
    if (d <= r && d < bestD) {
      best = h
      bestD = d
    }
  }
  return best
}

/**
 * Smallest visible box containing image point (ix, iy), grown by `slop` image px.
 * Hidden boxes are ignored; locked boxes are included. Equal areas: the topmost (last) wins.
 */
export function hitTestBoxes(boxes: readonly CanvasBox[], ix: number, iy: number, slop = 0): CanvasBox | null {
  let best: CanvasBox | null = null
  let bestArea = Infinity
  for (const b of boxes) {
    if (b.hidden) continue
    if (!boxContains(b, ix, iy, slop)) continue
    const a = boxArea(b)
    if (a <= bestArea) {
      best = b
      bestArea = a
    }
  }
  return best
}

/** Topmost pin within `radius` CSS px of screen point (sx, sy). */
export function hitTestPins(
  pins: readonly CanvasPin[],
  view: ViewState,
  sx: number,
  sy: number,
  radius = PIN_RADIUS + 2,
): CanvasPin | null {
  const r2 = radius * radius
  for (let i = pins.length - 1; i >= 0; i--) {
    const p = pins[i]!
    const dx = p.x * view.scale + view.tx - sx
    const dy = p.y * view.scale + view.ty - sy
    if (dx * dx + dy * dy <= r2) return p
  }
  return null
}

export interface HitTestOptions {
  boxes: readonly CanvasBox[]
  selectedIds: readonly string[]
  view: ViewState
  /** Pins to test first; null/undefined to skip. */
  pins?: readonly CanvasPin[] | null
  /** Whether resize handles are active (false in read-only mode). */
  handles: boolean
}

export function hitTest(o: HitTestOptions, sx: number, sy: number): HitTarget {
  if (o.pins && o.pins.length > 0) {
    const pin = hitTestPins(o.pins, o.view, sx, sy)
    if (pin) return { kind: 'pin', pin }
  }
  if (o.handles) {
    const hb = handleBoxFor(o.boxes, o.selectedIds)
    if (hb) {
      const handle = hitTestHandle(hb, o.view, sx, sy)
      if (handle) return { kind: 'handle', box: hb, handle }
    }
  }
  const ix = (sx - o.view.tx) / o.view.scale
  const iy = (sy - o.view.ty) / o.view.scale
  const box = hitTestBoxes(o.boxes, ix, iy, BOX_HIT_SLOP / o.view.scale)
  return box ? { kind: 'box', box } : NO_HIT
}

/** Ids of the visible boxes intersecting `rect` (marquee selection), in list order. */
export function boxesInRect(boxes: readonly CanvasBox[], rect: Rect): string[] {
  const out: string[] = []
  for (const b of boxes) {
    if (!b.hidden && boxesIntersect(b, rect)) out.push(b.id)
  }
  return out
}
