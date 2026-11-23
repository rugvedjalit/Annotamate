// Pure gesture state machine. The component feeds it pointer samples (container-relative CSS px)
// plus the current props/view and applies the returned effects. Nothing here touches the DOM.
import {
  boundsOf,
  clampGroupDelta,
  clampPoint,
  drawRect,
  flipHandle,
  handleCursor,
  MIN_BOX_SIZE,
  normalizeRect,
  rectsEqual,
  resizeBox,
  resizeFlip,
  type HandleId,
  type Point,
  type Rect,
} from './geometry'
import { boxesInRect, hitTest, NO_HIT, type HitTarget } from './hittest'
import type { BoxChangeMeta, CanvasBox, CanvasPin, CanvasTool, ViewState } from './types'
import { imageToScreen, panBy, screenToImage } from './view'

/** Pointer travel (CSS px) that turns a click into a drag. */
export const DRAG_THRESHOLD = 3

export interface Modifiers {
  shift: boolean
  alt: boolean
  ctrl: boolean
  meta: boolean
}

export interface PointerSample extends Modifiers {
  /** Container-relative CSS px. */
  x: number
  y: number
  /** 0 primary, 1 middle, 2 secondary (ignored for moves). */
  button: number
}

export interface GestureContext {
  view: ViewState
  imageWidth: number
  imageHeight: number
  boxes: readonly CanvasBox[]
  selectedIds: readonly string[]
  tool: CanvasTool
  readOnly: boolean
  placingPin: boolean
  pins: readonly CanvasPin[] | null
  defaultClassId: number | null
  /** Id generator for new boxes. */
  createId: () => string
}

type DragPlan =
  | { kind: 'none' }
  | { kind: 'pan' }
  | { kind: 'draw' }
  | { kind: 'move'; selection: string[] }
  | { kind: 'resize'; boxId: string; handle: HandleId }
  | { kind: 'marquee'; additive: boolean }

type ClickPlan =
  | { kind: 'none' }
  | { kind: 'select'; ids: string[] }
  | { kind: 'pinPlace'; at: Point }
  | { kind: 'pinClick'; pin: CanvasPin }

export type Gesture =
  | { kind: 'idle' }
  /** Pointer is down but has not travelled DRAG_THRESHOLD yet. */
  | { kind: 'pending'; startX: number; startY: number; drag: DragPlan; click: ClickPlan }
  | { kind: 'pan'; lastX: number; lastY: number; startView: ViewState }
  /** Anchor (ax, ay) and current rect in image px. */
  | { kind: 'draw'; ax: number; ay: number; rect: Rect }
  | {
      kind: 'move'
      ids: ReadonlySet<string>
      /** Image point where the drag started. */
      startX: number
      startY: number
      bounds: Rect
      /** Current clamped translation (image px). */
      dx: number
      dy: number
      /** Selection to restore on cancel (when the drag start changed it). */
      restoreSelection: string[] | null
    }
  | {
      kind: 'resize'
      boxId: string
      handle: HandleId
      /** Handle the cursor should show (changes when the box flips through). */
      cursorHandle: HandleId
      orig: Rect
      startX: number
      startY: number
      rect: Rect
    }
  /** Marquee corners in image px. */
  | { kind: 'marquee'; rect: Rect; ax: number; ay: number; additive: boolean }
  /** Cancelled while the pointer is still down: swallow everything until release. */
  | { kind: 'ignore' }

export type GestureKind = Gesture['kind']

/** Gestures that are real drags (reported through onGestureChange). */
export type DragKind = 'pan' | 'draw' | 'move' | 'resize' | 'marquee'

export interface Effects {
  view?: ViewState
  selection?: string[]
  commit?: { next: CanvasBox[]; meta: BoxChangeMeta }
  created?: { box: CanvasBox; anchor: Point }
  pinPlace?: Point
  pinClick?: CanvasPin
  /** The pointer was released without dragging. */
  click?: boolean
}

export interface Step {
  gesture: Gesture
  effects: Effects | null
}

export const IDLE: Gesture = Object.freeze({ kind: 'idle' })
const IGNORE: Gesture = Object.freeze({ kind: 'ignore' })
const NO_CLICK: ClickPlan = Object.freeze({ kind: 'none' })

function step(gesture: Gesture, effects: Effects | null = null): Step {
  return { gesture, effects }
}

export function isToggle(m: Modifiers): boolean {
  return m.shift || m.ctrl || m.meta
}

/** Boxes can be created, moved and resized. */
export function canEdit(ctx: GestureContext): boolean {
  return !ctx.readOnly && ctx.imageWidth > 0 && ctx.imageHeight > 0
}

export function isDragKind(k: GestureKind): k is DragKind {
  return k === 'pan' || k === 'draw' || k === 'move' || k === 'resize' || k === 'marquee'
}

/** Order-insensitive equality of two id lists. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  if (a.length === 0) return true
  const s = new Set(a)
  for (const id of b) if (!s.has(id)) return false
  return true
}

function toggled(selection: readonly string[], id: string): string[] {
  return selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]
}

function findBox(boxes: readonly CanvasBox[], id: string): CanvasBox | undefined {
  for (const b of boxes) if (b.id === id) return b
  return undefined
}

function startPan(x: number, y: number, view: ViewState): Gesture {
  return { kind: 'pan', lastX: x, lastY: y, startView: view }
}

/** What is under the pointer when idle (pins included unless a pin is being placed). */
export function hoverTarget(ctx: GestureContext, sx: number, sy: number): HitTarget {
  if (ctx.tool === 'pan' || ctx.placingPin) return NO_HIT
  return hitTest(
    { boxes: ctx.boxes, selectedIds: ctx.selectedIds, view: ctx.view, pins: ctx.pins, handles: canEdit(ctx) },
    sx,
    sy,
  )
}

export function pointerDown(g: Gesture, p: PointerSample, ctx: GestureContext): Step {
  if (g.kind !== 'idle') return step(g)
  if (p.button === 1) return step(startPan(p.x, p.y, ctx.view))
  if (p.button !== 0) return step(IDLE)

  if (ctx.placingPin) {
    const ip = screenToImage(ctx.view, p.x, p.y)
    const onImage = ip.x >= 0 && ip.y >= 0 && ip.x <= ctx.imageWidth && ip.y <= ctx.imageHeight
    const click: ClickPlan = onImage ? { kind: 'pinPlace', at: ip } : NO_CLICK
    return step({ kind: 'pending', startX: p.x, startY: p.y, drag: { kind: 'pan' }, click })
  }
  if (ctx.tool === 'pan') return step(startPan(p.x, p.y, ctx.view))

  const editable = canEdit(ctx)
  const base = { boxes: ctx.boxes, selectedIds: ctx.selectedIds, view: ctx.view, handles: editable }
  let target = hitTest({ ...base, pins: ctx.pins }, p.x, p.y)
  let pinClick: ClickPlan | null = null
  if (target.kind === 'pin') {
    // Click on a pin opens it; a drag acts on whatever is underneath.
    pinClick = { kind: 'pinClick', pin: target.pin }
    target = hitTest(base, p.x, p.y)
  }

  const toggle = isToggle(p)
  let drag: DragPlan
  let click: ClickPlan
  if (target.kind === 'handle') {
    drag = { kind: 'resize', boxId: target.box.id, handle: target.handle }
    click = NO_CLICK
  } else if (target.kind === 'box') {
    const id = target.box.id
    click = { kind: 'select', ids: toggle ? toggled(ctx.selectedIds, id) : [id] }
    if (ctx.tool === 'box') {
      drag = editable ? { kind: 'draw' } : { kind: 'marquee', additive: toggle }
    } else if (editable && !target.box.locked) {
      const selection = ctx.selectedIds.includes(id) ? [...ctx.selectedIds] : toggle ? [...ctx.selectedIds, id] : [id]
      drag = { kind: 'move', selection }
    } else {
      drag = { kind: 'marquee', additive: toggle }
    }
  } else {
    click = toggle ? NO_CLICK : { kind: 'select', ids: [] }
    drag = ctx.tool === 'box' && editable ? { kind: 'draw' } : { kind: 'marquee', additive: toggle }
  }
  return step({ kind: 'pending', startX: p.x, startY: p.y, drag, click: pinClick ?? click })
}

/** Turn a pending gesture into the planned drag, starting at the pointer-down position. */
function beginDrag(g: Extract<Gesture, { kind: 'pending' }>, ctx: GestureContext): Step {
  const plan = g.drag
  switch (plan.kind) {
    case 'none':
      return step(IGNORE)
    case 'pan':
      return step(startPan(g.startX, g.startY, ctx.view))
    case 'draw': {
      const a = clampPoint(screenToImage(ctx.view, g.startX, g.startY), ctx.imageWidth, ctx.imageHeight)
      return step({ kind: 'draw', ax: a.x, ay: a.y, rect: { x1: a.x, y1: a.y, x2: a.x, y2: a.y } })
    }
    case 'move': {
      const ids = new Set<string>()
      const moving: CanvasBox[] = []
      const wanted = new Set(plan.selection)
      for (const b of ctx.boxes) {
        if (wanted.has(b.id) && !b.hidden && !b.locked) {
          ids.add(b.id)
          moving.push(b)
        }
      }
      const bounds = boundsOf(moving)
      const changed = !sameIds(plan.selection, ctx.selectedIds)
      const effects: Effects | null = changed ? { selection: plan.selection } : null
      if (bounds === null) return step(IGNORE, effects)
      const s = screenToImage(ctx.view, g.startX, g.startY)
      return step(
        {
          kind: 'move',
          ids,
          startX: s.x,
          startY: s.y,
          bounds,
          dx: 0,
          dy: 0,
          restoreSelection: changed ? [...ctx.selectedIds] : null,
        },
        effects,
      )
    }
    case 'resize': {
      const box = findBox(ctx.boxes, plan.boxId)
      if (!box || box.locked || box.hidden) return step(IGNORE)
      const orig = normalizeRect(box)
      const s = screenToImage(ctx.view, g.startX, g.startY)
      return step({
        kind: 'resize',
        boxId: box.id,
        handle: plan.handle,
        cursorHandle: plan.handle,
        orig,
        startX: s.x,
        startY: s.y,
        rect: orig,
      })
    }
    case 'marquee': {
      const a = screenToImage(ctx.view, g.startX, g.startY)
      return step({
        kind: 'marquee',
        ax: a.x,
        ay: a.y,
        rect: { x1: a.x, y1: a.y, x2: a.x, y2: a.y },
        additive: plan.additive,
      })
    }
  }
}

/** Update an active drag for pointer sample `p`. Pure: returns a new gesture. */
function dragTo(g: Gesture, p: PointerSample, ctx: GestureContext): Step {
  switch (g.kind) {
    case 'pan': {
      const dx = p.x - g.lastX
      const dy = p.y - g.lastY
      const next: Gesture = { ...g, lastX: p.x, lastY: p.y }
      if (dx === 0 && dy === 0) return step(next)
      return step(next, { view: panBy(ctx.view, dx, dy) })
    }
    case 'draw': {
      const c = screenToImage(ctx.view, p.x, p.y)
      const rect = drawRect(
        { x: g.ax, y: g.ay },
        c,
        { square: p.shift, fromCenter: p.alt },
        ctx.imageWidth,
        ctx.imageHeight,
      )
      return step({ ...g, rect })
    }
    case 'move': {
      const c = screenToImage(ctx.view, p.x, p.y)
      const d = clampGroupDelta(g.bounds, c.x - g.startX, c.y - g.startY, ctx.imageWidth, ctx.imageHeight)
      if (d.x === g.dx && d.y === g.dy) return step(g)
      return step({ ...g, dx: d.x, dy: d.y })
    }
    case 'resize': {
      const c = screenToImage(ctx.view, p.x, p.y)
      const dx = c.x - g.startX
      const dy = c.y - g.startY
      const rect = resizeBox(g.orig, g.handle, dx, dy, ctx.imageWidth, ctx.imageHeight, MIN_BOX_SIZE)
      const f = resizeFlip(g.orig, g.handle, dx, dy)
      return step({ ...g, rect, cursorHandle: flipHandle(g.handle, f.x, f.y) })
    }
    case 'marquee': {
      const c = screenToImage(ctx.view, p.x, p.y)
      return step({ ...g, rect: normalizeRect({ x1: g.ax, y1: g.ay, x2: c.x, y2: c.y }) })
    }
    default:
      return step(g)
  }
}

function mergeEffects(a: Effects | null, b: Effects | null): Effects | null {
  if (!a) return b
  if (!b) return a
  return { ...a, ...b }
}

export function pointerMove(g: Gesture, p: PointerSample, ctx: GestureContext): Step {
  if (g.kind === 'idle' || g.kind === 'ignore') return step(g)
  if (g.kind === 'pending') {
    const dx = p.x - g.startX
    const dy = p.y - g.startY
    if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return step(g)
    const started = beginDrag(g, ctx)
    const moved = dragTo(started.gesture, p, ctx)
    return step(moved.gesture, mergeEffects(started.effects, moved.effects))
  }
  return dragTo(g, p, ctx)
}

/** Screen anchor near a box's top-right corner (used by onBoxCreated / onBoxDoubleClick). */
export function boxAnchor(view: ViewState, b: Rect): Point {
  return imageToScreen(view, Math.max(b.x1, b.x2), Math.min(b.y1, b.y2))
}

export function pointerUp(g: Gesture, p: PointerSample, ctx: GestureContext): Step {
  switch (g.kind) {
    case 'idle':
    case 'ignore':
    case 'pan':
      return step(IDLE)
    case 'pending': {
      const c = g.click
      switch (c.kind) {
        case 'none':
          return step(IDLE, { click: true })
        case 'select':
          return step(IDLE, sameIds(c.ids, ctx.selectedIds) ? { click: true } : { selection: c.ids, click: true })
        case 'pinPlace':
          return step(IDLE, { pinPlace: c.at, click: true })
        case 'pinClick':
          return step(IDLE, { pinClick: c.pin, click: true })
      }
      return step(IDLE)
    }
    case 'draw': {
      const fin = dragTo(g, p, ctx).gesture as Extract<Gesture, { kind: 'draw' }>
      const r = fin.rect
      if (r.x2 - r.x1 < MIN_BOX_SIZE || r.y2 - r.y1 < MIN_BOX_SIZE) return step(IDLE)
      const box: CanvasBox = {
        id: ctx.createId(),
        classId: ctx.defaultClassId,
        x1: r.x1,
        y1: r.y1,
        x2: r.x2,
        y2: r.y2,
      }
      return step(IDLE, {
        commit: { next: [...ctx.boxes, box], meta: { kind: 'create', ids: [box.id] } },
        created: { box, anchor: boxAnchor(ctx.view, box) },
      })
    }
    case 'move': {
      const fin = dragTo(g, p, ctx).gesture as Extract<Gesture, { kind: 'move' }>
      const { dx, dy } = fin
      if (dx === 0 && dy === 0) return step(IDLE)
      const ids: string[] = []
      const next = ctx.boxes.map((b) => {
        if (!fin.ids.has(b.id)) return b
        ids.push(b.id)
        return { ...b, x1: b.x1 + dx, y1: b.y1 + dy, x2: b.x2 + dx, y2: b.y2 + dy }
      })
      if (ids.length === 0) return step(IDLE)
      return step(IDLE, { commit: { next, meta: { kind: 'move', ids } } })
    }
    case 'resize': {
      const fin = dragTo(g, p, ctx).gesture as Extract<Gesture, { kind: 'resize' }>
      const box = findBox(ctx.boxes, fin.boxId)
      if (!box || rectsEqual(box, fin.rect)) return step(IDLE)
      const r = fin.rect
      const next = ctx.boxes.map((b) => (b.id === fin.boxId ? { ...b, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 } : b))
      return step(IDLE, { commit: { next, meta: { kind: 'resize', ids: [fin.boxId] } } })
    }
    case 'marquee': {
      const fin = dragTo(g, p, ctx).gesture as Extract<Gesture, { kind: 'marquee' }>
      const hits = boxesInRect(ctx.boxes, fin.rect)
      let selection = hits
      if (fin.additive) {
        const seen = new Set(ctx.selectedIds)
        selection = [...ctx.selectedIds]
        for (const id of hits) if (!seen.has(id)) selection.push(id)
      }
      return step(IDLE, sameIds(selection, ctx.selectedIds) ? null : { selection })
    }
  }
}

/**
 * Cancel the active gesture (Escape). Restores the view of a pan and the selection changed by a
 * move's start; nothing is committed. While the pointer stays down, further input is ignored.
 */
export function cancelGesture(g: Gesture): Step {
  switch (g.kind) {
    case 'idle':
    case 'ignore':
      return step(g)
    case 'pan':
      return step(IGNORE, { view: g.startView })
    case 'move':
      return step(IGNORE, g.restoreSelection ? { selection: g.restoreSelection } : null)
    default:
      return step(IGNORE)
  }
}

/** CSS cursor for the current gesture/hover. */
export function cursorFor(ctx: GestureContext, g: Gesture, hover: HitTarget): string {
  switch (g.kind) {
    case 'pan':
      return 'grabbing'
    case 'move':
      return 'move'
    case 'resize':
      return handleCursor(g.cursorHandle)
    case 'draw':
      return 'crosshair'
    case 'marquee':
      return 'default'
    case 'pending':
      if (g.drag.kind === 'resize') return handleCursor(g.drag.handle)
      if (g.drag.kind === 'move') return 'move'
      break
    default:
      break
  }
  if (ctx.placingPin) return 'crosshair'
  if (ctx.tool === 'pan') return 'grab'
  const editable = canEdit(ctx)
  switch (hover.kind) {
    case 'handle':
      return handleCursor(hover.handle)
    case 'pin':
      return 'pointer'
    case 'box':
      if (ctx.tool === 'box') return editable ? 'crosshair' : 'default'
      return editable && !hover.box.locked ? 'move' : 'default'
    default:
      return ctx.tool === 'box' && editable ? 'crosshair' : 'default'
  }
}
