import { describe, expect, it } from 'vitest'
import {
  boundsOf,
  boxContains,
  boxesIntersect,
  boxHeight,
  boxWidth,
  clampBox,
  clampGroupDelta,
  clampPoint,
  drawRect,
  flipHandle,
  handleCursor,
  handlePoint,
  HANDLES,
  normalizeBox,
  resizeBox,
  resizeFlip,
  translateBoxes,
  type HandleId,
  type Rect,
} from './geometry'
import type { CanvasBox } from './types'

const box = (id: string, x1: number, y1: number, x2: number, y2: number, extra: Partial<CanvasBox> = {}): CanvasBox => ({
  id,
  classId: 1,
  x1,
  y1,
  x2,
  y2,
  ...extra,
})

const W = 1000
const H = 800

describe('size helpers', () => {
  it('measures width and height regardless of orientation', () => {
    expect(boxWidth({ x1: 10, x2: 30 })).toBe(20)
    expect(boxWidth({ x1: 30, x2: 10 })).toBe(20)
    expect(boxHeight({ y1: 5, y2: 2 })).toBe(3)
  })
})

describe('normalizeBox', () => {
  it('orders the corners and keeps the other fields', () => {
    const b = box('a', 50, 40, 10, 20, { rawLabel: 'car', locked: true })
    const n = normalizeBox(b)
    expect(n).toEqual({ ...b, x1: 10, y1: 20, x2: 50, y2: 40 })
    expect(n).not.toBe(b)
    expect(b.x1).toBe(50) // input untouched
  })
})

describe('clampBox', () => {
  it('normalises and clamps into the image', () => {
    expect(clampBox(box('a', 1200, -10, -5, 300), W, H)).toMatchObject({ x1: 0, y1: 0, x2: W, y2: 300 })
  })
  it('leaves an inside box alone', () => {
    expect(clampBox(box('a', 10, 20, 30, 40), W, H)).toMatchObject({ x1: 10, y1: 20, x2: 30, y2: 40 })
  })
  it('clampPoint clamps both axes', () => {
    expect(clampPoint({ x: -5, y: 900 }, W, H)).toEqual({ x: 0, y: H })
  })
})

describe('containment and intersection', () => {
  it('boxContains includes edges, honours slop, handles flipped boxes', () => {
    const b = box('a', 10, 10, 20, 20)
    expect(boxContains(b, 10, 10)).toBe(true)
    expect(boxContains(b, 20, 15)).toBe(true)
    expect(boxContains(b, 21, 15)).toBe(false)
    expect(boxContains(b, 21, 15, 2)).toBe(true)
    expect(boxContains(box('f', 20, 20, 10, 10), 15, 15)).toBe(true)
  })
  it('boxesIntersect is strict and orientation independent', () => {
    const a = box('a', 0, 0, 10, 10)
    expect(boxesIntersect(a, box('b', 5, 5, 15, 15))).toBe(true)
    expect(boxesIntersect(a, box('b', 10, 0, 20, 10))).toBe(false) // touching only
    expect(boxesIntersect(a, box('b', 2, 2, 3, 3))).toBe(true) // contained
    expect(boxesIntersect(a, box('b', 15, 15, 5, 5))).toBe(true) // flipped
    expect(boxesIntersect(a, box('b', 11, 11, 12, 12))).toBe(false)
  })
  it('boundsOf returns the union or null', () => {
    expect(boundsOf([])).toBeNull()
    expect(boundsOf([box('a', 10, 10, 20, 20), box('b', 50, 5, 40, 30)])).toEqual({ x1: 10, y1: 5, x2: 50, y2: 30 })
  })
})

describe('group translation', () => {
  const group = [box('a', 100, 100, 200, 200), box('b', 300, 150, 400, 250)]
  const bounds = boundsOf(group)!

  it('moves freely inside the image', () => {
    expect(clampGroupDelta(bounds, 10, -20, W, H)).toEqual({ x: 10, y: -20 })
  })
  it('clamps on every side', () => {
    expect(clampGroupDelta(bounds, -500, 0, W, H)).toEqual({ x: -100, y: 0 })
    expect(clampGroupDelta(bounds, 5000, 0, W, H)).toEqual({ x: 600, y: 0 })
    expect(clampGroupDelta(bounds, 0, -500, W, H)).toEqual({ x: 0, y: -100 })
    expect(clampGroupDelta(bounds, 0, 5000, W, H)).toEqual({ x: 0, y: 550 })
  })
  it('never yanks a group that already sticks out, but stops it going further', () => {
    const out = { x1: -20, y1: 10, x2: 50, y2: 60 }
    expect(clampGroupDelta(out, 0, 0, W, H)).toEqual({ x: 0, y: 0 })
    expect(clampGroupDelta(out, -10, 0, W, H)).toEqual({ x: 0, y: 0 })
    expect(clampGroupDelta(out, 15, 0, W, H)).toEqual({ x: 15, y: 0 })
  })
  it('translateBoxes keeps relative positions when clamped', () => {
    const moved = translateBoxes(group, -1000, 0, W, H)
    expect(moved.map((b) => [b.x1, b.x2])).toEqual([
      [0, 100],
      [200, 300],
    ])
    expect(moved[0]!.id).toBe('a')
  })
  it('translateBoxes returns the same array when nothing moves', () => {
    expect(translateBoxes(group, 0, 0, W, H)).toBe(group)
    const atEdge = [box('a', 0, 0, 10, 10)]
    expect(translateBoxes(atEdge, -5, -5, W, H)).toBe(atEdge)
    const empty: CanvasBox[] = []
    expect(translateBoxes(empty, 5, 5, W, H)).toBe(empty)
  })
})

describe('handles', () => {
  const b: Rect = { x1: 10, y1: 20, x2: 110, y2: 220 }
  it('handlePoint for all 8 handles', () => {
    const pts = Object.fromEntries(HANDLES.map((h) => [h, handlePoint(b, h)]))
    expect(pts).toEqual({
      nw: { x: 10, y: 20 },
      n: { x: 60, y: 20 },
      ne: { x: 110, y: 20 },
      e: { x: 110, y: 120 },
      se: { x: 110, y: 220 },
      s: { x: 60, y: 220 },
      sw: { x: 10, y: 220 },
      w: { x: 10, y: 120 },
    })
  })
  it('lists corners first', () => {
    expect(HANDLES.slice(0, 4)).toEqual(['nw', 'ne', 'se', 'sw'])
    expect(new Set(HANDLES).size).toBe(8)
  })
  it('maps handles to resize cursors', () => {
    expect(handleCursor('nw')).toBe('nwse-resize')
    expect(handleCursor('se')).toBe('nwse-resize')
    expect(handleCursor('ne')).toBe('nesw-resize')
    expect(handleCursor('sw')).toBe('nesw-resize')
    expect(handleCursor('n')).toBe('ns-resize')
    expect(handleCursor('s')).toBe('ns-resize')
    expect(handleCursor('e')).toBe('ew-resize')
    expect(handleCursor('w')).toBe('ew-resize')
  })
  it('flipHandle mirrors the relevant axes only', () => {
    expect(flipHandle('nw', true, false)).toBe('ne')
    expect(flipHandle('nw', false, true)).toBe('sw')
    expect(flipHandle('nw', true, true)).toBe('se')
    expect(flipHandle('n', true, false)).toBe('n')
    expect(flipHandle('n', false, true)).toBe('s')
    expect(flipHandle('e', true, true)).toBe('w')
  })
})

describe('resizeBox', () => {
  const orig: Rect = { x1: 100, y1: 100, x2: 200, y2: 200 }
  const cases: Array<[HandleId, number, number, Rect]> = [
    ['nw', -10, -20, { x1: 90, y1: 80, x2: 200, y2: 200 }],
    ['n', -10, -20, { x1: 100, y1: 80, x2: 200, y2: 200 }],
    ['ne', 10, -20, { x1: 100, y1: 80, x2: 210, y2: 200 }],
    ['e', 10, -20, { x1: 100, y1: 100, x2: 210, y2: 200 }],
    ['se', 10, 20, { x1: 100, y1: 100, x2: 210, y2: 220 }],
    ['s', 10, 20, { x1: 100, y1: 100, x2: 200, y2: 220 }],
    ['sw', -10, 20, { x1: 90, y1: 100, x2: 200, y2: 220 }],
    ['w', -10, 20, { x1: 90, y1: 100, x2: 200, y2: 200 }],
  ]
  it.each(cases)('handle %s moves only its edges', (h, dx, dy, expected) => {
    expect(resizeBox(orig, h, dx, dy, W, H)).toEqual(expected)
  })

  it('flips through the opposite edge and stays normalised', () => {
    expect(resizeBox(orig, 'e', -150, 0, W, H)).toEqual({ x1: 50, y1: 100, x2: 100, y2: 200 })
    expect(resizeBox(orig, 'n', 0, 160, W, H)).toEqual({ x1: 100, y1: 200, x2: 200, y2: 260 })
    expect(resizeBox(orig, 'nw', 130, 150, W, H)).toEqual({ x1: 200, y1: 200, x2: 230, y2: 250 })
    expect(resizeBox(orig, 'se', -130, -150, W, H)).toEqual({ x1: 70, y1: 50, x2: 100, y2: 100 })
  })

  it('keeps at least 1 px when dragged onto the fixed edge', () => {
    const r = resizeBox(orig, 'e', -100, 0, W, H)
    expect(r.x2 - r.x1).toBe(1)
    expect(r.x1).toBe(100) // kept on the original side
    const r2 = resizeBox(orig, 'sw', 99.6, -99.8, W, H)
    expect(r2.x2 - r2.x1).toBeGreaterThanOrEqual(1)
    expect(r2.y2 - r2.y1).toBeGreaterThanOrEqual(1)
  })

  it('respects a custom minimum size', () => {
    const r = resizeBox(orig, 'se', -95, -98, W, H, 8)
    expect(r).toEqual({ x1: 100, y1: 100, x2: 108, y2: 108 })
  })

  it('clamps to the image on every side', () => {
    expect(resizeBox(orig, 'nw', -500, -500, W, H)).toEqual({ x1: 0, y1: 0, x2: 200, y2: 200 })
    expect(resizeBox(orig, 'se', 5000, 5000, W, H)).toEqual({ x1: 100, y1: 100, x2: W, y2: H })
  })

  it('min size at the image border goes inwards', () => {
    const atEdge: Rect = { x1: 990, y1: 10, x2: 1000, y2: 20 }
    const r = resizeBox(atEdge, 'w', 50, 0, W, H)
    expect(r.x1).toBe(999)
    expect(r.x2).toBe(1000)
  })

  it('accepts a non-normalised original', () => {
    expect(resizeBox({ x1: 200, y1: 200, x2: 100, y2: 100 }, 'se', 10, 10, W, H)).toEqual({
      x1: 100,
      y1: 100,
      x2: 210,
      y2: 210,
    })
  })

  it('clamps a box that started partly outside the image', () => {
    expect(resizeBox({ x1: -10, y1: 10, x2: 50, y2: 60 }, 's', 0, 5, W, H)).toEqual({ x1: 0, y1: 10, x2: 50, y2: 65 })
  })

  it('resizeFlip reports which axes flipped', () => {
    expect(resizeFlip(orig, 'nw', 150, 0)).toEqual({ x: true, y: false })
    expect(resizeFlip(orig, 'se', -150, -150)).toEqual({ x: true, y: true })
    expect(resizeFlip(orig, 'n', 500, 10)).toEqual({ x: false, y: false })
  })
})

describe('drawRect', () => {
  it('spans anchor to pointer, normalised', () => {
    expect(drawRect({ x: 100, y: 100 }, { x: 150, y: 130 }, {}, W, H)).toEqual({ x1: 100, y1: 100, x2: 150, y2: 130 })
    expect(drawRect({ x: 100, y: 100 }, { x: 50, y: 70 }, {}, W, H)).toEqual({ x1: 50, y1: 70, x2: 100, y2: 100 })
  })
  it('clamps the pointer and the anchor to the image', () => {
    expect(drawRect({ x: 900, y: 700 }, { x: 1300, y: 900 }, {}, W, H)).toEqual({ x1: 900, y1: 700, x2: W, y2: H })
    expect(drawRect({ x: -50, y: -50 }, { x: 40, y: 30 }, {}, W, H)).toEqual({ x1: 0, y1: 0, x2: 40, y2: 30 })
  })
  it('square: the larger dimension wins, direction is kept', () => {
    expect(drawRect({ x: 100, y: 100 }, { x: 150, y: 120 }, { square: true }, W, H)).toEqual({
      x1: 100,
      y1: 100,
      x2: 150,
      y2: 150,
    })
    expect(drawRect({ x: 100, y: 100 }, { x: 80, y: 40 }, { square: true }, W, H)).toEqual({
      x1: 40,
      y1: 40,
      x2: 100,
      y2: 100,
    })
  })
  it('square stays square when clamped', () => {
    const r = drawRect({ x: 980, y: 100 }, { x: 1100, y: 200 }, { square: true }, W, H)
    expect(r.x2 - r.x1).toBe(r.y2 - r.y1)
    expect(r.x2).toBe(W)
  })
  it('from centre grows symmetrically and stays centred when clamped', () => {
    expect(drawRect({ x: 500, y: 400 }, { x: 520, y: 430 }, { fromCenter: true }, W, H)).toEqual({
      x1: 480,
      y1: 370,
      x2: 520,
      y2: 430,
    })
    const r = drawRect({ x: 10, y: 400 }, { x: 60, y: 430 }, { fromCenter: true }, W, H)
    expect(r).toEqual({ x1: 0, y1: 370, x2: 20, y2: 430 })
  })
  it('square from centre', () => {
    expect(drawRect({ x: 500, y: 400 }, { x: 510, y: 430 }, { square: true, fromCenter: true }, W, H)).toEqual({
      x1: 470,
      y1: 370,
      x2: 530,
      y2: 430,
    })
  })
})
