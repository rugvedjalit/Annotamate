import { describe, expect, it } from 'vitest'
import type { ViewState } from './types'
import {
  actualSizeView,
  applyWheel,
  clampScale,
  constrainView,
  FIT_PADDING,
  fitRect,
  fitView,
  imageSmoothingFor,
  imageToScreen,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  rectToScreen,
  revealRect,
  screenToImage,
  viewsEqual,
  wheelDeltaPx,
  wheelZoomFactor,
  zoomAt,
  zoomToScaleAt,
  type WheelInput,
} from './view'

function imageRectOnScreen(v: ViewState, w: number, h: number) {
  return { left: v.tx, top: v.ty, right: v.tx + w * v.scale, bottom: v.ty + h * v.scale }
}

describe('fitView', () => {
  it('fits a wide image to the width with 24 px padding, centred vertically', () => {
    const v = fitView(2000, 1000, 1000, 800)
    expect(v.scale).toBeCloseTo((1000 - 2 * FIT_PADDING) / 2000)
    const r = imageRectOnScreen(v, 2000, 1000)
    expect(r.left).toBeCloseTo(FIT_PADDING, 0)
    expect(1000 - r.right).toBeCloseTo(FIT_PADDING, 0)
    expect(r.top - 0).toBeCloseTo(800 - r.bottom, 0)
    expect(r.top).toBeGreaterThan(FIT_PADDING)
  })

  it('fits a tall image to the height, centred horizontally', () => {
    const v = fitView(600, 3000, 1200, 900)
    expect(v.scale).toBeCloseTo((900 - 2 * FIT_PADDING) / 3000)
    const r = imageRectOnScreen(v, 600, 3000)
    expect(r.top).toBeCloseTo(FIT_PADDING, 0)
    expect(900 - r.bottom).toBeCloseTo(FIT_PADDING, 0)
    expect(r.left).toBeCloseTo(1200 - r.right, 0)
  })

  it('rounds the translation to whole pixels', () => {
    const v = fitView(1234, 567, 999, 777)
    expect(Number.isInteger(v.tx)).toBe(true)
    expect(Number.isInteger(v.ty)).toBe(true)
  })

  it('clamps the scale for tiny and huge images', () => {
    expect(fitView(1, 1, 1000, 1000).scale).toBe(MAX_SCALE)
    expect(fitView(1_000_000, 1_000_000, 1000, 1000).scale).toBe(MIN_SCALE)
  })

  it('returns identity for degenerate sizes', () => {
    expect(fitView(0, 100, 800, 600)).toEqual({ scale: 1, tx: 0, ty: 0 })
    expect(fitView(100, 100, 0, 600)).toEqual({ scale: 1, tx: 0, ty: 0 })
  })

  it('fitRect centres a sub-rectangle', () => {
    const v = fitRect({ x1: 100, y1: 100, x2: 200, y2: 150 }, 800, 600)
    const c = imageToScreen(v, 150, 125)
    expect(c.x).toBeCloseTo(400, 0)
    expect(c.y).toBeCloseTo(300, 0)
  })
})

describe('screen <-> image', () => {
  const v: ViewState = { scale: 2.5, tx: -130, ty: 47 }
  it('round-trips', () => {
    for (const [x, y] of [
      [0, 0],
      [123.4, 567.8],
      [-50, 9000],
    ] as const) {
      const s = imageToScreen(v, x, y)
      const i = screenToImage(v, s.x, s.y)
      expect(i.x).toBeCloseTo(x, 9)
      expect(i.y).toBeCloseTo(y, 9)
    }
  })
  it('follows screen = image * scale + t', () => {
    expect(imageToScreen(v, 10, 20)).toEqual({ x: 10 * 2.5 - 130, y: 20 * 2.5 + 47 })
  })
  it('rectToScreen normalises', () => {
    expect(rectToScreen({ scale: 2, tx: 10, ty: 20 }, { x1: 50, y1: 40, x2: 10, y2: 20 })).toEqual({
      x: 30,
      y: 60,
      w: 80,
      h: 40,
    })
  })
})

describe('zoom', () => {
  const v: ViewState = { scale: 0.75, tx: 40, ty: -20 }
  it('keeps the image point under the cursor fixed', () => {
    for (const f of [1.2, 0.5, 3, 1 / 7]) {
      const sx = 333
      const sy = 222
      const before = screenToImage(v, sx, sy)
      const z = zoomAt(v, f, sx, sy)
      expect(z.scale).toBeCloseTo(v.scale * f)
      const after = screenToImage(z, sx, sy)
      expect(after.x).toBeCloseTo(before.x, 9)
      expect(after.y).toBeCloseTo(before.y, 9)
    }
  })
  it('clamps the scale but still keeps the anchor fixed', () => {
    const big = zoomAt(v, 1e6, 100, 100)
    expect(big.scale).toBe(MAX_SCALE)
    const small = zoomAt(v, 1e-6, 100, 100)
    expect(small.scale).toBe(MIN_SCALE)
    const before = screenToImage(v, 100, 100)
    const after = screenToImage(small, 100, 100)
    expect(after.x).toBeCloseTo(before.x, 9)
  })
  it('zoomToScaleAt sets an absolute scale', () => {
    expect(zoomToScaleAt(v, 2, 0, 0).scale).toBe(2)
  })
  it('clampScale', () => {
    expect(clampScale(100)).toBe(MAX_SCALE)
    expect(clampScale(0.0001)).toBe(MIN_SCALE)
    expect(clampScale(1.5)).toBe(1.5)
    expect(clampScale(Number.NaN)).toBe(1)
    expect(clampScale(-3)).toBe(1)
  })
  it('actualSizeView keeps the centre image point', () => {
    const vw = 800
    const vh = 600
    const c = screenToImage(v, vw / 2, vh / 2)
    const a = actualSizeView(v, vw, vh)
    expect(a.scale).toBe(1)
    const c2 = screenToImage(a, vw / 2, vh / 2)
    expect(c2.x).toBeCloseTo(c.x, 0)
    expect(c2.y).toBeCloseTo(c.y, 0)
  })
  it('panBy translates only', () => {
    expect(panBy(v, 5, -6)).toEqual({ scale: 0.75, tx: 45, ty: -26 })
  })
  it('viewsEqual', () => {
    expect(viewsEqual(v, { ...v })).toBe(true)
    expect(viewsEqual(v, { ...v, tx: 41 })).toBe(false)
  })
  it('smoothing turns off above 1.5x', () => {
    expect(imageSmoothingFor(1)).toBe(true)
    expect(imageSmoothingFor(1.5)).toBe(true)
    expect(imageSmoothingFor(1.6)).toBe(false)
  })
})

describe('revealRect', () => {
  const v: ViewState = { scale: 1, tx: 0, ty: 0 }
  it('returns the same view when the rect is already visible', () => {
    expect(revealRect(v, { x1: 100, y1: 100, x2: 200, y2: 200 }, 800, 600)).toBe(v)
  })
  it('pans just enough to bring a rect into view (with padding)', () => {
    const r = revealRect(v, { x1: 900, y1: 100, x2: 1000, y2: 150 }, 800, 600)
    expect(r.scale).toBe(1)
    expect(1000 + r.tx).toBe(800 - FIT_PADDING)
    expect(r.ty).toBe(0)
    const up = revealRect(v, { x1: 100, y1: -300, x2: 150, y2: -250 }, 800, 600)
    expect(-300 + up.ty).toBe(FIT_PADDING)
  })
  it('zooms out to fit a rect that is too large', () => {
    const r = revealRect({ scale: 4, tx: 0, ty: 0 }, { x1: 0, y1: 0, x2: 400, y2: 300 }, 800, 600)
    expect(r.scale).toBeLessThan(4)
    const s = rectToScreen(r, { x1: 0, y1: 0, x2: 400, y2: 300 })
    expect(s.x).toBeGreaterThanOrEqual(FIT_PADDING - 1)
    expect(s.x + s.w).toBeLessThanOrEqual(800 - FIT_PADDING + 1)
  })
})

describe('constrainView', () => {
  it('keeps part of the image on screen', () => {
    const v = constrainView({ scale: 1, tx: -5000, ty: 9000 }, 1000, 800, 800, 600)
    expect(v.tx + 1000).toBeGreaterThanOrEqual(48)
    expect(v.ty).toBeLessThanOrEqual(600 - 48)
  })
  it('keeps a small image fully visible', () => {
    const v = constrainView({ scale: 1, tx: 790, ty: -100 }, 20, 20, 800, 600)
    expect(v.tx).toBe(780)
    expect(v.ty).toBe(0)
  })
  it('returns the same object when nothing changes', () => {
    const v = { scale: 1, tx: 10, ty: 10 }
    expect(constrainView(v, 1000, 800, 800, 600)).toBe(v)
  })
})

describe('wheel', () => {
  const base: WheelInput = { dx: 0, dy: 0, ctrlKey: false, metaKey: false, shiftKey: false, x: 200, y: 150 }
  const v: ViewState = { scale: 1, tx: 0, ty: 0 }

  it('converts delta modes to px', () => {
    expect(wheelDeltaPx(1, 2, 0, 600)).toEqual({ x: 1, y: 2 })
    expect(wheelDeltaPx(1, 3, 1, 600)).toEqual({ x: 16, y: 48 })
    expect(wheelDeltaPx(0, 1, 2, 600)).toEqual({ x: 0, y: 600 })
  })

  it('zoom factor: wheel down zooms out, symmetric, clamped', () => {
    expect(wheelZoomFactor(100, false)).toBeLessThan(1)
    expect(wheelZoomFactor(-100, false)).toBeGreaterThan(1)
    expect(wheelZoomFactor(100, false) * wheelZoomFactor(-100, false)).toBeCloseTo(1)
    expect(wheelZoomFactor(10000, false)).toBe(wheelZoomFactor(100, false))
    expect(wheelZoomFactor(1000, true)).toBe(wheelZoomFactor(25, true))
  })

  it("'zoom' mode: plain wheel zooms anchored at the pointer", () => {
    const z = applyWheel(v, { ...base, dy: -100 }, 'zoom')
    expect(z.scale).toBeGreaterThan(1)
    const p = screenToImage(z, 200, 150)
    expect(p.x).toBeCloseTo(200)
    expect(p.y).toBeCloseTo(150)
  })

  it("'zoom' mode: shift+wheel pans horizontally", () => {
    expect(applyWheel(v, { ...base, dy: 40, shiftKey: true }, 'zoom')).toEqual({ scale: 1, tx: -40, ty: 0 })
    expect(applyWheel(v, { ...base, dx: 30, shiftKey: true }, 'zoom')).toEqual({ scale: 1, tx: -30, ty: 0 })
  })

  it("'scroll' mode: wheel pans, ctrl/meta zooms (pinch)", () => {
    expect(applyWheel(v, { ...base, dx: 5, dy: 40 }, 'scroll')).toEqual({ scale: 1, tx: -5, ty: -40 })
    expect(applyWheel(v, { ...base, dy: -10, ctrlKey: true }, 'scroll').scale).toBeGreaterThan(1)
    expect(applyWheel(v, { ...base, dy: 100, metaKey: true }, 'scroll').scale).toBeLessThan(1)
  })

  it("'zoom' mode: ctrl+wheel (pinch) also zooms", () => {
    expect(applyWheel(v, { ...base, dy: 10, ctrlKey: true }, 'zoom').scale).toBeLessThan(1)
  })
})
