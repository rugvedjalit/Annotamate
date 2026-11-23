import { describe, expect, it } from 'vitest'
import {
  cancelGesture,
  canEdit,
  cursorFor,
  DRAG_THRESHOLD,
  hoverTarget,
  IDLE,
  pointerDown,
  pointerMove,
  pointerUp,
  sameIds,
  type Effects,
  type Gesture,
  type GestureContext,
  type Modifiers,
  type PointerSample,
} from './controller'
import { NO_HIT } from './hittest'
import type { CanvasBox, CanvasPin, ViewState } from './types'
import { imageToScreen } from './view'

const box = (id: string, x1: number, y1: number, x2: number, y2: number, extra: Partial<CanvasBox> = {}): CanvasBox => ({
  id,
  classId: 1,
  x1,
  y1,
  x2,
  y2,
  ...extra,
})

const NO_MODS: Modifiers = { shift: false, alt: false, ctrl: false, meta: false }

function sample(x: number, y: number, mods: Partial<Modifiers> = {}, button = 0): PointerSample {
  return { x, y, button, ...NO_MODS, ...mods }
}

let idCounter = 0
function makeCtx(over: Partial<GestureContext> = {}): GestureContext {
  return {
    view: { scale: 1, tx: 0, ty: 0 },
    imageWidth: 1000,
    imageHeight: 800,
    boxes: [],
    selectedIds: [],
    tool: 'select',
    readOnly: false,
    placingPin: false,
    pins: null,
    defaultClassId: 7,
    createId: () => `new-${++idCounter}`,
    ...over,
  }
}

type Ev =
  | ['down', number, number, Partial<Modifiers>?, number?]
  | ['move', number, number, Partial<Modifiers>?]
  | ['up', number, number, Partial<Modifiers>?]
  | ['cancel']

/**
 * Runs a sequence of pointer events through the controller, applying view/selection effects to
 * the context like the app would, and collects every effect.
 */
function drive(ctx: GestureContext, events: Ev[], start: Gesture = IDLE) {
  let g = start
  const effects: Effects[] = []
  const during: Effects[] = []
  for (const ev of events) {
    let r
    if (ev[0] === 'cancel') r = cancelGesture(g)
    else if (ev[0] === 'down') r = pointerDown(g, sample(ev[1], ev[2], ev[3], ev[4] ?? 0), ctx)
    else if (ev[0] === 'move') r = pointerMove(g, sample(ev[1], ev[2], ev[3]), ctx)
    else r = pointerUp(g, sample(ev[1], ev[2], ev[3]), ctx)
    g = r.gesture
    if (r.effects) {
      effects.push(r.effects)
      if (ev[0] !== 'up') during.push(r.effects)
      if (r.effects.view) ctx.view = r.effects.view
      if (r.effects.selection) ctx.selectedIds = r.effects.selection
    }
  }
  const commits = effects.filter((e) => e.commit)
  return { gesture: g, effects, during, commits, ctx }
}

describe('box tool: drawing', () => {
  it('draws a box with a drag and commits once on release', () => {
    const ctx = makeCtx({ tool: 'box', boxes: [box('a', 500, 500, 600, 600)] })
    const r = drive(ctx, [
      ['down', 100, 100],
      ['move', 120, 130],
      ['move', 150, 160],
      ['up', 150, 160],
    ])
    expect(r.gesture.kind).toBe('idle')
    expect(r.during.some((e) => e.commit)).toBe(false)
    expect(r.commits).toHaveLength(1)
    const { next, meta } = r.commits[0]!.commit!
    expect(meta.kind).toBe('create')
    expect(next).toHaveLength(2)
    const created = next[1]!
    expect(created).toMatchObject({ x1: 100, y1: 100, x2: 150, y2: 160, classId: 7 })
    expect(meta.ids).toEqual([created.id])
    const eff = r.commits[0]!
    expect(eff.created?.box).toBe(created)
    expect(eff.created?.anchor).toEqual({ x: 150, y: 100 }) // top-right corner on screen
  })

  it('uses null class when no default class is given', () => {
    const ctx = makeCtx({ tool: 'box', defaultClassId: null })
    const r = drive(ctx, [
      ['down', 10, 10],
      ['move', 50, 50],
      ['up', 50, 50],
    ])
    expect(r.commits[0]!.commit!.next[0]!.classId).toBeNull()
  })

  it('works in image coordinates under a zoomed/panned view', () => {
    const view: ViewState = { scale: 2, tx: 100, ty: 50 }
    const ctx = makeCtx({ tool: 'box', view })
    const a = imageToScreen(view, 10, 20)
    const b = imageToScreen(view, 60, 90)
    const r = drive(ctx, [
      ['down', a.x, a.y],
      ['move', b.x, b.y],
      ['up', b.x, b.y],
    ])
    expect(r.commits[0]!.commit!.next[0]).toMatchObject({ x1: 10, y1: 20, x2: 60, y2: 90 })
    expect(r.commits[0]!.created!.anchor).toEqual(imageToScreen(view, 60, 20))
  })

  it('respects the drag threshold', () => {
    const ctx = makeCtx({ tool: 'box' })
    let g = pointerDown(IDLE, sample(100, 100), ctx).gesture
    g = pointerMove(g, sample(100 + DRAG_THRESHOLD - 1, 100), ctx).gesture
    expect(g.kind).toBe('pending')
    g = pointerMove(g, sample(100 + DRAG_THRESHOLD, 100), ctx).gesture
    expect(g.kind).toBe('draw')
  })

  it('anchors the draft at the pointer-down position, not where the threshold was crossed', () => {
    const ctx = makeCtx({ tool: 'box' })
    const r = drive(ctx, [
      ['down', 100, 100],
      ['move', 130, 140],
    ])
    expect(r.gesture).toMatchObject({ kind: 'draw', rect: { x1: 100, y1: 100, x2: 130, y2: 140 } })
  })

  it('does not create a box smaller than 1 image px', () => {
    const ctx = makeCtx({ tool: 'box', view: { scale: 10, tx: 0, ty: 0 } })
    const r = drive(ctx, [
      ['down', 100, 100],
      ['move', 105, 140],
      ['up', 105, 140],
    ])
    expect(r.commits).toHaveLength(0)
    expect(r.gesture.kind).toBe('idle')
  })

  it('Shift draws a square, Alt draws from the centre, and modifiers can change mid-drag', () => {
    const ctx = makeCtx({ tool: 'box' })
    let r = drive(ctx, [
      ['down', 100, 100],
      ['move', 150, 120, { shift: true }],
    ])
    expect(r.gesture).toMatchObject({ rect: { x1: 100, y1: 100, x2: 150, y2: 150 } })
    r = drive(ctx, [['move', 150, 120, { alt: true }]], r.gesture)
    expect(r.gesture).toMatchObject({ rect: { x1: 50, y1: 80, x2: 150, y2: 120 } })
    r = drive(ctx, [['up', 150, 120, { alt: true, shift: true }]], r.gesture)
    expect(r.commits[0]!.commit!.next[0]).toMatchObject({ x1: 50, y1: 50, x2: 150, y2: 150 })
  })

  it('clamps drawing that starts or ends outside the image', () => {
    const ctx = makeCtx({ tool: 'box' })
    const r = drive(ctx, [
      ['down', -50, -40],
      ['move', 1200, 30],
      ['up', 1200, 30],
    ])
    expect(r.commits[0]!.commit!.next[0]).toMatchObject({ x1: 0, y1: 0, x2: 1000, y2: 30 })
  })

  it('a drag that starts on an existing box draws a new one', () => {
    const ctx = makeCtx({ tool: 'box', boxes: [box('a', 0, 0, 500, 500)] })
    const r = drive(ctx, [
      ['down', 100, 100],
      ['move', 200, 200],
      ['up', 200, 200],
    ])
    expect(r.commits[0]!.commit!.meta.kind).toBe('create')
    expect(r.commits[0]!.commit!.next[0]).toEqual(ctx.boxes[0])
  })

  it('a click on a box selects it; on empty space clears the selection', () => {
    const ctx = makeCtx({ tool: 'box', boxes: [box('a', 0, 0, 50, 50), box('b', 100, 100, 150, 150)] })
    let r = drive(ctx, [
      ['down', 10, 10],
      ['up', 11, 11],
    ])
    expect(r.effects).toEqual([{ selection: ['a'], click: true }])
    expect(r.commits).toHaveLength(0)
    r = drive(ctx, [
      ['down', 110, 110, { shift: true }],
      ['up', 110, 110, { shift: true }],
    ])
    expect(r.effects[0]!.selection).toEqual(['a', 'b'])
    expect(ctx.selectedIds).toEqual(['a', 'b'])
    r = drive(ctx, [
      ['down', 700, 700],
      ['up', 700, 700],
    ])
    expect(r.effects[0]!.selection).toEqual([])
  })

  it('read-only: a drag does not draw (marquee instead)', () => {
    const ctx = makeCtx({ tool: 'box', readOnly: true, boxes: [box('a', 150, 150, 160, 160)] })
    const r = drive(ctx, [
      ['down', 100, 100],
      ['move', 200, 200],
      ['up', 200, 200],
    ])
    expect(r.commits).toHaveLength(0)
    expect(ctx.selectedIds).toEqual(['a'])
  })

  it('cannot draw without image dimensions', () => {
    const ctx = makeCtx({ tool: 'box', imageWidth: 0, imageHeight: 0 })
    expect(canEdit(ctx)).toBe(false)
    const r = drive(ctx, [
      ['down', 10, 10],
      ['move', 100, 100],
      ['up', 100, 100],
    ])
    expect(r.commits).toHaveLength(0)
  })
})

describe('select tool: selection', () => {
  const boxes = [box('a', 0, 0, 100, 100), box('b', 200, 200, 300, 300), box('c', 10, 10, 30, 30)]

  it('click selects the smallest box under the pointer', () => {
    const ctx = makeCtx({ boxes })
    drive(ctx, [
      ['down', 20, 20],
      ['up', 20, 20],
    ])
    expect(ctx.selectedIds).toEqual(['c'])
  })

  it('Shift/Ctrl/Meta click toggles', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'] })
    drive(ctx, [
      ['down', 250, 250, { ctrl: true }],
      ['up', 250, 250, { ctrl: true }],
    ])
    expect(ctx.selectedIds).toEqual(['a', 'b'])
    drive(ctx, [
      ['down', 50, 50, { meta: true }],
      ['up', 50, 50, { meta: true }],
    ])
    expect(ctx.selectedIds).toEqual(['b'])
    drive(ctx, [
      ['down', 50, 50, { shift: true }],
      ['up', 50, 50, { shift: true }],
    ])
    expect(ctx.selectedIds).toEqual(['b', 'a'])
  })

  it('a toggle click on empty space keeps the selection', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'] })
    const r = drive(ctx, [
      ['down', 700, 700, { shift: true }],
      ['up', 700, 700, { shift: true }],
    ])
    expect(r.effects).toEqual([{ click: true }])
  })

  it('click on a box inside a multi-selection selects just that box', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a', 'b'] })
    drive(ctx, [
      ['down', 250, 250],
      ['up', 250, 250],
    ])
    expect(ctx.selectedIds).toEqual(['b'])
  })

  it('no selection effect when nothing changes', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['b'] })
    const r = drive(ctx, [
      ['down', 250, 250],
      ['up', 250, 250],
    ])
    expect(r.effects).toEqual([{ click: true }])
    const empty = makeCtx({ boxes })
    expect(
      drive(empty, [
        ['down', 700, 700],
        ['up', 700, 700],
      ]).effects,
    ).toEqual([{ click: true }])
  })

  it('locked boxes can be selected', () => {
    const ctx = makeCtx({ boxes: [box('l', 0, 0, 100, 100, { locked: true })] })
    drive(ctx, [
      ['down', 50, 50],
      ['up', 50, 50],
    ])
    expect(ctx.selectedIds).toEqual(['l'])
  })

  it('hidden boxes are ignored', () => {
    const ctx = makeCtx({ boxes: [box('h', 0, 0, 100, 100, { hidden: true })], selectedIds: ['x'] })
    drive(ctx, [
      ['down', 50, 50],
      ['up', 50, 50],
    ])
    expect(ctx.selectedIds).toEqual([])
  })
})

describe('select tool: marquee', () => {
  const boxes = [
    box('a', 100, 100, 150, 150),
    box('b', 200, 200, 250, 250),
    box('c', 600, 600, 650, 650),
    box('h', 120, 120, 130, 130, { hidden: true }),
  ]

  it('drag on empty space selects intersecting visible boxes', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['c'] })
    const r = drive(ctx, [
      ['down', 50, 50],
      ['move', 120, 120],
      ['move', 210, 210],
      ['up', 210, 210],
    ])
    expect(r.during).toHaveLength(0) // no selection churn during the drag
    expect(ctx.selectedIds).toEqual(['a', 'b'])
  })

  it('works in any direction', () => {
    const ctx = makeCtx({ boxes })
    drive(ctx, [
      ['down', 260, 260],
      ['move', 140, 140],
      ['up', 140, 140],
    ])
    expect(ctx.selectedIds).toEqual(['a', 'b'])
  })

  it('Shift adds to the selection', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['c'] })
    drive(ctx, [
      ['down', 50, 50, { shift: true }],
      ['move', 160, 160, { shift: true }],
      ['up', 160, 160, { shift: true }],
    ])
    expect(ctx.selectedIds).toEqual(['c', 'a'])
  })

  it('empty marquee clears the selection', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'] })
    drive(ctx, [
      ['down', 400, 400],
      ['move', 450, 450],
      ['up', 450, 450],
    ])
    expect(ctx.selectedIds).toEqual([])
  })

  it('a drag starting on a locked box is a marquee, not a move', () => {
    const ctx = makeCtx({ boxes: [box('l', 0, 0, 300, 300, { locked: true }), box('a', 100, 100, 120, 120)] })
    const r = drive(ctx, [
      ['down', 10, 10],
      ['move', 150, 150],
      ['up', 150, 150],
    ])
    expect(r.commits).toHaveLength(0)
    expect(ctx.selectedIds).toEqual(['l', 'a'])
  })
})

describe('select tool: move', () => {
  const boxes = [box('a', 100, 100, 200, 200), box('b', 300, 300, 400, 400), box('l', 500, 100, 550, 150, { locked: true })]

  it('dragging an unselected box selects it at drag start and moves it, one commit', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['b'] })
    const r = drive(ctx, [
      ['down', 150, 150],
      ['move', 160, 150],
      ['move', 170, 165],
      ['move', 180, 170],
      ['up', 180, 170],
    ])
    expect(r.during.map((e) => e.selection)).toEqual([['a']])
    expect(r.during.some((e) => e.commit)).toBe(false)
    expect(r.commits).toHaveLength(1)
    const { next, meta } = r.commits[0]!.commit!
    expect(meta).toEqual({ kind: 'move', ids: ['a'] })
    expect(next[0]).toMatchObject({ x1: 130, y1: 120, x2: 230, y2: 220 })
    expect(next[1]).toBe(boxes[1]) // untouched boxes keep identity
  })

  it('dragging a selected box moves the whole selection, skipping locked members', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a', 'b', 'l'] })
    const r = drive(ctx, [
      ['down', 350, 350],
      ['move', 360, 340],
      ['up', 360, 340],
    ])
    const { next, meta } = r.commits[0]!.commit!
    expect(meta).toEqual({ kind: 'move', ids: ['a', 'b'] })
    expect(next[0]).toMatchObject({ x1: 110, y1: 90 })
    expect(next[1]).toMatchObject({ x1: 310, y1: 290 })
    expect(next[2]).toBe(boxes[2])
    expect(r.effects.some((e) => e.selection)).toBe(false)
  })

  it('Shift-drag on an unselected box adds it and moves the group', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['b'] })
    const r = drive(ctx, [
      ['down', 150, 150, { shift: true }],
      ['move', 160, 160, { shift: true }],
      ['up', 160, 160, { shift: true }],
    ])
    expect(ctx.selectedIds).toEqual(['b', 'a'])
    expect(r.commits[0]!.commit!.meta.ids).toEqual(['a', 'b'])
  })

  it('clamps the group inside the image', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a', 'b'] })
    const r = drive(ctx, [
      ['down', 150, 150],
      ['move', -2000, 5000],
      ['up', -2000, 5000],
    ])
    const { next } = r.commits[0]!.commit!
    expect(next[0]).toMatchObject({ x1: 0, x2: 100, y1: 500, y2: 600 })
    expect(next[1]).toMatchObject({ x1: 200, x2: 300, y1: 700, y2: 800 })
  })

  it('no commit when the box ends where it started', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'] })
    const r = drive(ctx, [
      ['down', 150, 150],
      ['move', 190, 190],
      ['move', 150, 150],
      ['up', 150, 150],
    ])
    expect(r.commits).toHaveLength(0)
  })

  it('a click (below threshold) on a box never moves it', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'] })
    const r = drive(ctx, [
      ['down', 150, 150],
      ['move', 151, 152],
      ['up', 151, 152],
    ])
    expect(r.commits).toHaveLength(0)
  })

  it('read-only: dragging a box does not move it', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'], readOnly: true })
    const r = drive(ctx, [
      ['down', 150, 150],
      ['move', 250, 250],
      ['up', 250, 250],
    ])
    expect(r.commits).toHaveLength(0)
  })
})

describe('select tool: resize', () => {
  const boxes = [box('a', 100, 100, 200, 200), box('b', 150, 150, 160, 160)]

  it('dragging a handle of the single selected box resizes it, one commit', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'] })
    const r = drive(ctx, [
      ['down', 200, 200], // se handle
      ['move', 220, 210],
      ['move', 240, 230],
      ['up', 240, 230],
    ])
    expect(r.during.some((e) => e.commit || e.selection)).toBe(false)
    expect(r.commits).toHaveLength(1)
    const { next, meta } = r.commits[0]!.commit!
    expect(meta).toEqual({ kind: 'resize', ids: ['a'] })
    expect(next[0]).toMatchObject({ x1: 100, y1: 100, x2: 240, y2: 230 })
    expect(next[1]).toBe(boxes[1])
  })

  it('handles win over a smaller box at the same point', () => {
    const ctx = makeCtx({ boxes: [box('a', 100, 100, 200, 200), box('tiny', 98, 98, 104, 104)], selectedIds: ['a'] })
    const r = drive(ctx, [
      ['down', 100, 100],
      ['move', 80, 90],
      ['up', 80, 90],
    ])
    expect(r.commits[0]!.commit!.meta).toEqual({ kind: 'resize', ids: ['a'] })
    expect(r.commits[0]!.commit!.next[0]).toMatchObject({ x1: 80, y1: 90, x2: 200, y2: 200 })
  })

  it('flips through and stays normalised and clamped', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'] })
    const r = drive(ctx, [
      ['down', 150, 100], // n handle
      ['move', 150, 900],
      ['up', 150, 900],
    ])
    expect(r.commits[0]!.commit!.next[0]).toMatchObject({ x1: 100, y1: 200, x2: 200, y2: 800 })
  })

  it('the cursor follows a flip', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'] })
    const r = drive(ctx, [
      ['down', 200, 150], // e handle
      ['move', 50, 150],
    ])
    expect(r.gesture).toMatchObject({ kind: 'resize', handle: 'e', cursorHandle: 'w' })
  })

  it('no commit when the size did not change', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'] })
    const r = drive(ctx, [
      ['down', 200, 200],
      ['move', 230, 230],
      ['move', 200, 200],
      ['up', 200, 200],
    ])
    expect(r.commits).toHaveLength(0)
  })

  it('locked boxes have no handles', () => {
    const ctx = makeCtx({ boxes: [box('l', 100, 100, 200, 200, { locked: true })], selectedIds: ['l'] })
    const r = drive(ctx, [
      ['down', 200, 200],
      ['move', 260, 260],
      ['up', 260, 260],
    ])
    expect(r.commits).toHaveLength(0)
  })

  it('read-only: handles are inactive', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'], readOnly: true })
    const r = drive(ctx, [
      ['down', 200, 200],
      ['move', 260, 260],
      ['up', 260, 260],
    ])
    expect(r.commits).toHaveLength(0)
  })

  it('handles also work in the box tool', () => {
    const ctx = makeCtx({ tool: 'box', boxes, selectedIds: ['a'] })
    const r = drive(ctx, [
      ['down', 200, 200],
      ['move', 250, 250],
      ['up', 250, 250],
    ])
    expect(r.commits[0]!.commit!.meta.kind).toBe('resize')
  })
})

describe('Escape / cancel', () => {
  it('cancelling a draw commits nothing and ignores the rest of the gesture', () => {
    const ctx = makeCtx({ tool: 'box' })
    const r = drive(ctx, [['down', 10, 10], ['move', 100, 100], ['cancel'], ['move', 200, 200], ['up', 200, 200]])
    expect(r.commits).toHaveLength(0)
    expect(r.effects).toEqual([])
    expect(r.gesture.kind).toBe('idle')
  })

  it('cancelling a move restores positions and the selection changed at drag start', () => {
    const ctx = makeCtx({ boxes: [box('a', 100, 100, 200, 200), box('b', 300, 300, 400, 400)], selectedIds: ['b'] })
    const r = drive(ctx, [['down', 150, 150], ['move', 170, 170], ['cancel'], ['up', 170, 170]])
    expect(r.commits).toHaveLength(0)
    expect(ctx.selectedIds).toEqual(['b'])
  })

  it('cancelling a resize commits nothing', () => {
    const ctx = makeCtx({ boxes: [box('a', 100, 100, 200, 200)], selectedIds: ['a'] })
    const r = drive(ctx, [['down', 200, 200], ['move', 300, 300], ['cancel'], ['up', 300, 300]])
    expect(r.commits).toHaveLength(0)
  })

  it('cancelling a pan restores the view', () => {
    const ctx = makeCtx({ tool: 'pan' })
    const start = ctx.view
    const r = drive(ctx, [['down', 10, 10], ['move', 100, 50], ['cancel'], ['up', 100, 50]])
    expect(r.ctx.view).toEqual(start)
  })

  it('cancelling a marquee keeps the selection', () => {
    const ctx = makeCtx({ boxes: [box('a', 100, 100, 150, 150)], selectedIds: [] })
    drive(ctx, [['down', 50, 50], ['move', 200, 200], ['cancel'], ['up', 200, 200]])
    expect(ctx.selectedIds).toEqual([])
  })

  it('cancelling before the threshold suppresses the click', () => {
    const ctx = makeCtx({ boxes: [box('a', 0, 0, 100, 100)] })
    const r = drive(ctx, [['down', 50, 50], ['cancel'], ['up', 50, 50]])
    expect(r.effects).toEqual([])
  })

  it('cancel while idle is a no-op', () => {
    expect(cancelGesture(IDLE)).toEqual({ gesture: IDLE, effects: null })
  })
})

describe('pan', () => {
  it('the pan tool pans with the left button and does not select', () => {
    const ctx = makeCtx({ tool: 'pan', boxes: [box('a', 0, 0, 500, 500)] })
    const r = drive(ctx, [
      ['down', 10, 10],
      ['move', 11, 12],
      ['move', 40, 30],
      ['up', 40, 30],
    ])
    expect(ctx.view).toEqual({ scale: 1, tx: 30, ty: 20 })
    expect(r.effects.some((e) => e.selection || e.commit)).toBe(false)
  })

  it('middle button pans in any tool', () => {
    for (const tool of ['select', 'box'] as const) {
      const ctx = makeCtx({ tool, boxes: [box('a', 0, 0, 500, 500)], selectedIds: ['a'] })
      const r = drive(ctx, [
        ['down', 10, 10, {}, 1],
        ['move', 60, 10],
        ['up', 60, 10],
      ])
      expect(ctx.view.tx).toBe(50)
      expect(r.commits).toHaveLength(0)
    }
  })

  it('the right button starts nothing', () => {
    const ctx = makeCtx()
    expect(pointerDown(IDLE, sample(10, 10, {}, 2), ctx).gesture).toBe(IDLE)
  })

  it('a second pointer down during a gesture is ignored', () => {
    const ctx = makeCtx({ tool: 'box' })
    const g = drive(ctx, [
      ['down', 10, 10],
      ['move', 50, 50],
    ]).gesture
    expect(pointerDown(g, sample(300, 300), ctx).gesture).toBe(g)
  })

  it('panning works in read-only mode', () => {
    const ctx = makeCtx({ tool: 'pan', readOnly: true })
    drive(ctx, [
      ['down', 0, 0],
      ['move', 20, 0],
      ['up', 20, 0],
    ])
    expect(ctx.view.tx).toBe(20)
  })
})

describe('pins', () => {
  const pins: CanvasPin[] = [{ id: 'p1', x: 300, y: 300 }]

  it('placingPin: a click on the image places a pin instead of editing', () => {
    const ctx = makeCtx({ tool: 'box', placingPin: true, view: { scale: 2, tx: 0, ty: 0 }, boxes: [box('a', 0, 0, 400, 400)] })
    const r = drive(ctx, [
      ['down', 100, 60],
      ['up', 100, 60],
    ])
    expect(r.effects).toEqual([{ pinPlace: { x: 50, y: 30 }, click: true }])
  })

  it('placingPin: clicks outside the image do nothing; drags pan', () => {
    const ctx = makeCtx({ placingPin: true })
    let r = drive(ctx, [
      ['down', 1500, 100],
      ['up', 1500, 100],
    ])
    expect(r.effects).toEqual([{ click: true }])
    r = drive(ctx, [
      ['down', 100, 100],
      ['move', 150, 100],
      ['up', 150, 100],
    ])
    expect(r.effects.some((e) => e.pinPlace)).toBe(false)
    expect(ctx.view.tx).toBe(50)
  })

  it('clicking a pin reports it', () => {
    const ctx = makeCtx({ pins, boxes: [box('a', 0, 0, 1000, 800)] })
    const r = drive(ctx, [
      ['down', 301, 299],
      ['up', 301, 299],
    ])
    expect(r.effects).toEqual([{ pinClick: pins[0], click: true }])
  })

  it('dragging from a pin acts on what is underneath', () => {
    const ctx = makeCtx({ pins, boxes: [box('a', 320, 320, 340, 340)] })
    drive(ctx, [
      ['down', 300, 300],
      ['move', 350, 350],
      ['up', 350, 350],
    ])
    expect(ctx.selectedIds).toEqual(['a'])
  })
})

describe('exactly one commit per gesture', () => {
  it('long drags produce a single commit, never during the drag', () => {
    const ctx = makeCtx({ boxes: [box('a', 100, 100, 200, 200)], selectedIds: ['a'] })
    const moves: Ev[] = []
    for (let i = 1; i <= 50; i++) moves.push(['move', 150 + i * 3, 150 + i * 2])
    const r = drive(ctx, [['down', 150, 150], ...moves, ['up', 300, 250]])
    expect(r.commits).toHaveLength(1)
    expect(r.during.filter((e) => e.commit)).toHaveLength(0)
  })
})

describe('hover & cursors', () => {
  const boxes = [box('a', 100, 100, 200, 200), box('l', 300, 300, 400, 400, { locked: true })]

  it('hoverTarget finds handles, boxes and nothing', () => {
    const ctx = makeCtx({ boxes, selectedIds: ['a'] })
    expect(hoverTarget(ctx, 200, 200)).toMatchObject({ kind: 'handle', handle: 'se' })
    expect(hoverTarget(ctx, 150, 150)).toMatchObject({ kind: 'box', box: { id: 'a' } })
    expect(hoverTarget(ctx, 700, 700)).toBe(NO_HIT)
    expect(hoverTarget(makeCtx({ boxes, tool: 'pan' }), 150, 150)).toBe(NO_HIT)
  })

  it('cursor rules', () => {
    const sel = makeCtx({ boxes, selectedIds: ['a'] })
    expect(cursorFor(sel, IDLE, hoverTarget(sel, 200, 200))).toBe('nwse-resize')
    expect(cursorFor(sel, IDLE, hoverTarget(sel, 200, 150))).toBe('ew-resize')
    expect(cursorFor(sel, IDLE, hoverTarget(sel, 150, 150))).toBe('move')
    expect(cursorFor(sel, IDLE, hoverTarget(sel, 350, 350))).toBe('default') // locked
    expect(cursorFor(sel, IDLE, NO_HIT)).toBe('default')
    const ro = makeCtx({ boxes, readOnly: true })
    expect(cursorFor(ro, IDLE, hoverTarget(ro, 150, 150))).toBe('default')
    const boxTool = makeCtx({ boxes, tool: 'box' })
    expect(cursorFor(boxTool, IDLE, hoverTarget(boxTool, 150, 150))).toBe('crosshair')
    expect(cursorFor(boxTool, IDLE, NO_HIT)).toBe('crosshair')
    const pan = makeCtx({ tool: 'pan' })
    expect(cursorFor(pan, IDLE, NO_HIT)).toBe('grab')
    const panning = drive(makeCtx({ tool: 'pan' }), [['down', 0, 0]]).gesture
    expect(cursorFor(pan, panning, NO_HIT)).toBe('grabbing')
    const moving = drive(makeCtx({ boxes }), [
      ['down', 150, 150],
      ['move', 170, 170],
    ]).gesture
    expect(cursorFor(sel, moving, NO_HIT)).toBe('move')
    expect(cursorFor(makeCtx({ placingPin: true }), IDLE, NO_HIT)).toBe('crosshair')
  })
})

describe('sameIds', () => {
  it('is order-insensitive', () => {
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameIds(['a'], ['a', 'b'])).toBe(false)
    expect(sameIds([], [])).toBe(true)
    expect(sameIds(['a', 'b'], ['a', 'c'])).toBe(false)
  })
})
