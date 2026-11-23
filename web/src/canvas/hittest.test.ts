import { describe, expect, it } from 'vitest'
import { HANDLES, handlePoint } from './geometry'
import {
  boxesInRect,
  handleBoxFor,
  hitTest,
  hitTestBoxes,
  hitTestHandle,
  hitTestPins,
  HANDLE_SIZE,
  HANDLE_HIT_SLOP,
  MIN_EDGE_HANDLE_SIDE,
} from './hittest'
import type { CanvasBox, ViewState } from './types'
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

const view: ViewState = { scale: 2, tx: 10, ty: 20 }

describe('handleBoxFor', () => {
  const boxes = [box('a', 0, 0, 10, 10), box('h', 0, 0, 5, 5, { hidden: true }), box('l', 0, 0, 5, 5, { locked: true })]
  it('returns the single selected box', () => {
    expect(handleBoxFor(boxes, ['a'])?.id).toBe('a')
  })
  it('is null for multi/empty selection, unknown ids, hidden or locked boxes', () => {
    expect(handleBoxFor(boxes, [])).toBeNull()
    expect(handleBoxFor(boxes, ['a', 'l'])).toBeNull()
    expect(handleBoxFor(boxes, ['zzz'])).toBeNull()
    expect(handleBoxFor(boxes, ['h'])).toBeNull()
    expect(handleBoxFor(boxes, ['l'])).toBeNull()
  })
})

describe('hitTestHandle', () => {
  const b = box('a', 100, 100, 300, 200) // 400 x 200 screen px at scale 2
  it.each(HANDLES)('finds handle %s at its screen position', (h) => {
    const p = handlePoint(b, h)
    const s = imageToScreen(view, p.x, p.y)
    expect(hitTestHandle(b, view, s.x + 1, s.y - 1)).toBe(h)
  })
  it('honours the hit size', () => {
    const s = imageToScreen(view, 300, 200)
    const r = HANDLE_SIZE / 2 + HANDLE_HIT_SLOP
    expect(hitTestHandle(b, view, s.x + r, s.y)).toBe('se')
    expect(hitTestHandle(b, view, s.x + r + 0.5, s.y)).toBeNull()
  })
  it('misses in the middle of the box', () => {
    const s = imageToScreen(view, 200, 150)
    expect(hitTestHandle(b, view, s.x, s.y)).toBeNull()
  })
  it('only offers corners on short sides', () => {
    const small = box('s', 10, 10, 15, 15) // 10 x 10 screen px
    expect(10).toBeLessThan(MIN_EDGE_HANDLE_SIDE)
    const top = imageToScreen(view, 12.5, 10)
    const hit = hitTestHandle(small, view, top.x, top.y)
    expect(hit === 'nw' || hit === 'ne').toBe(true)
  })
  it('works for flipped boxes', () => {
    const f = box('f', 300, 200, 100, 100)
    const s = imageToScreen(view, 100, 100)
    expect(hitTestHandle(f, view, s.x, s.y)).toBe('nw')
  })
})

describe('hitTestBoxes', () => {
  const outer = box('outer', 0, 0, 100, 100)
  const inner = box('inner', 20, 20, 40, 40)
  const hidden = box('hidden', 25, 25, 30, 30, { hidden: true })
  const locked = box('locked', 60, 60, 70, 70, { locked: true })
  const boxes = [outer, inner, hidden, locked]

  it('returns the smallest box containing the point', () => {
    expect(hitTestBoxes(boxes, 30, 30)?.id).toBe('inner')
    expect(hitTestBoxes(boxes, 10, 10)?.id).toBe('outer')
  })
  it('ignores hidden boxes and includes locked ones', () => {
    expect(hitTestBoxes(boxes, 27, 27)?.id).toBe('inner')
    expect(hitTestBoxes(boxes, 65, 65)?.id).toBe('locked')
  })
  it('returns null on empty space', () => {
    expect(hitTestBoxes(boxes, 500, 500)).toBeNull()
  })
  it('the topmost box wins ties', () => {
    expect(hitTestBoxes([box('a', 0, 0, 10, 10), box('b', 0, 0, 10, 10)], 5, 5)?.id).toBe('b')
  })
  it('slop grows the hit area', () => {
    expect(hitTestBoxes([inner], 41, 30)).toBeNull()
    expect(hitTestBoxes([inner], 41, 30, 1.5)?.id).toBe('inner')
  })
})

describe('hitTestPins', () => {
  const pins = [
    { id: 1, x: 50, y: 50 },
    { id: 2, x: 52, y: 50 },
  ]
  it('returns the topmost pin within the radius', () => {
    const s = imageToScreen(view, 51, 50)
    expect(hitTestPins(pins, view, s.x, s.y)?.id).toBe(2)
    expect(hitTestPins(pins, view, s.x + 100, s.y)).toBeNull()
  })
})

describe('hitTest order', () => {
  const big = box('big', 100, 100, 300, 300)
  const nested = box('nested', 102, 102, 120, 120) // tiny box right at big's nw corner
  const boxes = [big, nested]
  const corner = imageToScreen(view, 100, 100)

  it('handles of the single selected box beat a smaller box', () => {
    const h = hitTest({ boxes, selectedIds: ['big'], view, handles: true }, corner.x + 2, corner.y + 2)
    expect(h).toMatchObject({ kind: 'handle', handle: 'nw' })
  })
  it('without handles the smallest box wins', () => {
    const p = imageToScreen(view, 103, 103)
    expect(hitTest({ boxes, selectedIds: ['big'], view, handles: false }, p.x, p.y)).toMatchObject({
      kind: 'box',
      box: { id: 'nested' },
    })
  })
  it('no handles for multi-selection', () => {
    const p = imageToScreen(view, 103, 103)
    expect(hitTest({ boxes, selectedIds: ['big', 'nested'], view, handles: true }, p.x, p.y)).toMatchObject({
      kind: 'box',
    })
  })
  it('pins come first', () => {
    const pins = [{ id: 'p', x: 100, y: 100 }]
    expect(hitTest({ boxes, selectedIds: ['big'], view, handles: true, pins }, corner.x, corner.y)).toMatchObject({
      kind: 'pin',
    })
  })
  it('empty space is none', () => {
    expect(hitTest({ boxes, selectedIds: [], view, handles: true }, 5000, 5000)).toEqual({ kind: 'none' })
  })
})

describe('boxesInRect', () => {
  it('returns visible intersecting ids in order', () => {
    const boxes = [
      box('a', 0, 0, 10, 10),
      box('b', 50, 50, 60, 60),
      box('c', 5, 5, 8, 8, { hidden: true }),
      box('d', 9, 9, 20, 20, { locked: true }),
    ]
    expect(boxesInRect(boxes, { x1: 5, y1: 5, x2: 15, y2: 15 })).toEqual(['a', 'd'])
    expect(boxesInRect(boxes, { x1: 100, y1: 100, x2: 200, y2: 200 })).toEqual([])
  })
})
