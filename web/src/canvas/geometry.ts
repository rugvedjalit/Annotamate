// Pure box math in image pixels. No DOM, no allocations beyond the returned values.
import type { CanvasBox } from './types'

export interface Point {
  x: number
  y: number
}

/** Axis-aligned rectangle in image pixels (not necessarily normalised). */
export interface Rect {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Resize handle of a box: corners and edge midpoints, named by compass direction. */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** All handles, corners first (corners win ties in hit testing). */
export const HANDLES: readonly HandleId[] = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w']

/** Minimum size (image px) of a drawn or resized box in both dimensions. */
export const MIN_BOX_SIZE = 1

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function boxWidth(b: Pick<CanvasBox, 'x1' | 'x2'>): number {
  return Math.abs(b.x2 - b.x1)
}

export function boxHeight(b: Pick<CanvasBox, 'y1' | 'y2'>): number {
  return Math.abs(b.y2 - b.y1)
}

export function boxArea(b: Rect): number {
  return Math.abs(b.x2 - b.x1) * Math.abs(b.y2 - b.y1)
}

/** Ensure x1 <= x2 and y1 <= y2. Returns a new box (other fields are kept). */
export function normalizeBox<T extends Rect>(b: T): T {
  return {
    ...b,
    x1: Math.min(b.x1, b.x2),
    x2: Math.max(b.x1, b.x2),
    y1: Math.min(b.y1, b.y2),
    y2: Math.max(b.y1, b.y2),
  }
}

/** Normalised copy of the four coordinates only. */
export function normalizeRect(r: Rect): Rect {
  return {
    x1: Math.min(r.x1, r.x2),
    y1: Math.min(r.y1, r.y2),
    x2: Math.max(r.x1, r.x2),
    y2: Math.max(r.y1, r.y2),
  }
}

/** Normalise and clamp a box inside [0, w] x [0, h]. Returns a new box. */
export function clampBox<T extends Rect>(b: T, w: number, h: number): T {
  const n = normalizeBox(b)
  n.x1 = clamp(n.x1, 0, w)
  n.x2 = clamp(n.x2, 0, w)
  n.y1 = clamp(n.y1, 0, h)
  n.y2 = clamp(n.y2, 0, h)
  return n
}

export function clampPoint(p: Point, w: number, h: number): Point {
  return { x: clamp(p.x, 0, w), y: clamp(p.y, 0, h) }
}

export function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2
}

/** True if (x, y) lies inside the box (edges included), optionally grown by `slop` on every side. */
export function boxContains(b: Rect, x: number, y: number, slop = 0): boolean {
  const x1 = b.x1 < b.x2 ? b.x1 : b.x2
  const x2 = b.x1 < b.x2 ? b.x2 : b.x1
  const y1 = b.y1 < b.y2 ? b.y1 : b.y2
  const y2 = b.y1 < b.y2 ? b.y2 : b.y1
  return x >= x1 - slop && x <= x2 + slop && y >= y1 - slop && y <= y2 + slop
}

/** Strict overlap test (touching edges do not count). Works with non-normalised input. */
export function boxesIntersect(
  a: Pick<CanvasBox, 'x1' | 'y1' | 'x2' | 'y2'>,
  b: Pick<CanvasBox, 'x1' | 'y1' | 'x2' | 'y2'>,
): boolean {
  return (
    Math.min(a.x1, a.x2) < Math.max(b.x1, b.x2) &&
    Math.max(a.x1, a.x2) > Math.min(b.x1, b.x2) &&
    Math.min(a.y1, a.y2) < Math.max(b.y1, b.y2) &&
    Math.max(a.y1, a.y2) > Math.min(b.y1, b.y2)
  )
}

/** Bounding rectangle of a group of boxes, or null for an empty group. */
export function boundsOf(boxes: readonly Rect[]): Rect | null {
  if (boxes.length === 0) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const b of boxes) {
    x1 = Math.min(x1, b.x1, b.x2)
    y1 = Math.min(y1, b.y1, b.y2)
    x2 = Math.max(x2, b.x1, b.x2)
    y2 = Math.max(y2, b.y1, b.y2)
  }
  return { x1, y1, x2, y2 }
}

/**
 * Clamp a translation so a group with the given bounds stays inside [0, w] x [0, h].
 * The allowed range always contains 0, so a group that already sticks out is never yanked;
 * it just cannot move further out.
 */
export function clampGroupDelta(bounds: Rect, dx: number, dy: number, w: number, h: number): Point {
  const minX = Math.min(bounds.x1, bounds.x2)
  const maxX = Math.max(bounds.x1, bounds.x2)
  const minY = Math.min(bounds.y1, bounds.y2)
  const maxY = Math.max(bounds.y1, bounds.y2)
  const cdx = clamp(dx, Math.min(0, -minX), Math.max(0, w - maxX))
  const cdy = clamp(dy, Math.min(0, -minY), Math.max(0, h - maxY))
  // Avoid -0 so callers can compare with === 0 and serialise cleanly.
  return { x: cdx === 0 ? 0 : cdx, y: cdy === 0 ? 0 : cdy }
}

/**
 * Move boxes by (dx, dy) as a group, clamped so the whole group stays inside the image.
 * Returns the input array unchanged when the clamped delta is zero.
 */
export function translateBoxes<T extends Rect>(boxes: T[], dx: number, dy: number, w: number, h: number): T[] {
  const bounds = boundsOf(boxes)
  if (bounds === null) return boxes
  const d = clampGroupDelta(bounds, dx, dy, w, h)
  if (d.x === 0 && d.y === 0) return boxes
  return boxes.map((b) => ({ ...b, x1: b.x1 + d.x, x2: b.x2 + d.x, y1: b.y1 + d.y, y2: b.y2 + d.y }))
}

/** Position of a handle on a box (the box is normalised first). */
export function handlePoint(b: Rect, handle: HandleId): Point {
  const x1 = Math.min(b.x1, b.x2)
  const x2 = Math.max(b.x1, b.x2)
  const y1 = Math.min(b.y1, b.y2)
  const y2 = Math.max(b.y1, b.y2)
  const cx = (x1 + x2) / 2
  const cy = (y1 + y2) / 2
  switch (handle) {
    case 'nw':
      return { x: x1, y: y1 }
    case 'n':
      return { x: cx, y: y1 }
    case 'ne':
      return { x: x2, y: y1 }
    case 'e':
      return { x: x2, y: cy }
    case 'se':
      return { x: x2, y: y2 }
    case 's':
      return { x: cx, y: y2 }
    case 'sw':
      return { x: x1, y: y2 }
    case 'w':
      return { x: x1, y: cy }
  }
}

export function isCornerHandle(h: HandleId): boolean {
  return h.length === 2
}

/** CSS cursor for a handle. */
export function handleCursor(h: HandleId): string {
  switch (h) {
    case 'nw':
    case 'se':
      return 'nwse-resize'
    case 'ne':
    case 'sw':
      return 'nesw-resize'
    case 'n':
    case 's':
      return 'ns-resize'
    case 'e':
    case 'w':
      return 'ew-resize'
  }
}

/** Mirror a handle horizontally and/or vertically (used when a resize flips through). */
export function flipHandle(h: HandleId, flipX: boolean, flipY: boolean): HandleId {
  let v = h.includes('n') ? 'n' : h.includes('s') ? 's' : ''
  let x = h.includes('w') ? 'w' : h.includes('e') ? 'e' : ''
  if (flipY && v !== '') v = v === 'n' ? 's' : 'n'
  if (flipX && x !== '') x = x === 'w' ? 'e' : 'w'
  return (v + x) as HandleId
}

function handleMovesLeft(h: HandleId): boolean {
  return h === 'nw' || h === 'w' || h === 'sw'
}
function handleMovesRight(h: HandleId): boolean {
  return h === 'ne' || h === 'e' || h === 'se'
}
function handleMovesTop(h: HandleId): boolean {
  return h === 'nw' || h === 'n' || h === 'ne'
}
function handleMovesBottom(h: HandleId): boolean {
  return h === 'sw' || h === 's' || h === 'se'
}

/**
 * One axis of a resize: `fixed` stays, `moving` follows the pointer. The result is clamped to
 * [0, limit], may flip through `fixed`, and is at least `min` long. `side` (+1/-1) is the side the
 * moving edge started on, used when the pointer lands exactly on the fixed edge.
 */
function resizeAxis(fixed: number, moving: number, side: number, limit: number, min: number): [number, number] {
  const f = clamp(fixed, 0, limit)
  let m = clamp(moving, 0, limit)
  if (Math.abs(m - f) < min) {
    const dir = m === f ? side : m > f ? 1 : -1
    m = f + dir * min
    if (m > limit) m = f - min
    else if (m < 0) m = f + min
  }
  return m < f ? [m, f] : [f, m]
}

/**
 * Resize `orig` by dragging `handle` by (dx, dy) image px. The result is normalised (the box can
 * flip through its opposite edge), clamped to [0, w] x [0, h] and at least `minSize` in both
 * dimensions. Edge handles only change one dimension.
 */
export function resizeBox(
  orig: Rect,
  handle: HandleId,
  dx: number,
  dy: number,
  w: number,
  h: number,
  minSize = MIN_BOX_SIZE,
): Rect {
  const n = normalizeRect(orig)
  let { x1, y1, x2, y2 } = n
  if (handleMovesLeft(handle)) [x1, x2] = resizeAxis(n.x2, n.x1 + dx, -1, w, minSize)
  else if (handleMovesRight(handle)) [x1, x2] = resizeAxis(n.x1, n.x2 + dx, 1, w, minSize)
  else {
    x1 = clamp(x1, 0, w)
    x2 = clamp(x2, 0, w)
  }
  if (handleMovesTop(handle)) [y1, y2] = resizeAxis(n.y2, n.y1 + dy, -1, h, minSize)
  else if (handleMovesBottom(handle)) [y1, y2] = resizeAxis(n.y1, n.y2 + dy, 1, h, minSize)
  else {
    y1 = clamp(y1, 0, h)
    y2 = clamp(y2, 0, h)
  }
  return { x1, y1, x2, y2 }
}

/** Which way a resize currently faces relative to the original box (for the cursor). */
export function resizeFlip(orig: Rect, handle: HandleId, dx: number, dy: number): { x: boolean; y: boolean } {
  const n = normalizeRect(orig)
  return {
    x: handleMovesLeft(handle) ? n.x1 + dx > n.x2 : handleMovesRight(handle) ? n.x2 + dx < n.x1 : false,
    y: handleMovesTop(handle) ? n.y1 + dy > n.y2 : handleMovesBottom(handle) ? n.y2 + dy < n.y1 : false,
  }
}

export interface DrawModifiers {
  /** Constrain to a square (the larger dimension wins). */
  square?: boolean
  /** The anchor is the centre instead of a corner. */
  fromCenter?: boolean
}

/**
 * Rectangle being drawn from `anchor` to `current` (image px), clamped inside [0, w] x [0, h].
 * The anchor is clamped onto the image first, so drawing can start outside it. Square and
 * centre constraints are preserved by the clamping (the size shrinks instead of the shape).
 */
export function drawRect(anchor: Point, current: Point, mods: DrawModifiers, w: number, h: number): Rect {
  const ax = clamp(anchor.x, 0, w)
  const ay = clamp(anchor.y, 0, h)
  const dx = current.x - ax
  const dy = current.y - ay
  const sx = dx < 0 ? -1 : 1
  const sy = dy < 0 ? -1 : 1
  let rw = Math.abs(dx)
  let rh = Math.abs(dy)
  let maxW: number
  let maxH: number
  if (mods.fromCenter) {
    maxW = Math.min(ax, w - ax)
    maxH = Math.min(ay, h - ay)
  } else {
    maxW = sx > 0 ? w - ax : ax
    maxH = sy > 0 ? h - ay : ay
  }
  if (mods.square) {
    const s = Math.min(Math.max(rw, rh), maxW, maxH)
    rw = s
    rh = s
  } else {
    rw = Math.min(rw, maxW)
    rh = Math.min(rh, maxH)
  }
  if (mods.fromCenter) return { x1: ax - rw, y1: ay - rh, x2: ax + rw, y2: ay + rh }
  return normalizeRect({ x1: ax, y1: ay, x2: ax + sx * rw, y2: ay + sy * rh })
}
