import { describe, expect, it } from 'vitest'
import {
  buildStyles,
  CHIP_HEIGHT,
  createScene,
  drawImageLayer,
  labelFor,
  OverlayRenderer,
  sourceSize,
  styleOf,
  unknownStyle,
  type CanvasImage,
  type ImageLayerParams,
  type OverlayScene,
} from './render'
import { createMockContext } from './testing'
import type { CanvasBox, CanvasClass } from './types'

const classes: CanvasClass[] = [
  { id: 1, name: 'car', color: '#3b82f6' },
  { id: 2, name: 'bicycle', color: '#22c55e' },
]

const box = (id: string, x1: number, y1: number, x2: number, y2: number, extra: Partial<CanvasBox> = {}): CanvasBox => ({
  id,
  classId: 1,
  x1,
  y1,
  x2,
  y2,
  ...extra,
})

function scene(over: Partial<OverlayScene> = {}): OverlayScene {
  const s = createScene()
  s.width = 800
  s.height = 600
  s.styles = buildStyles(classes, 0.16)
  s.unknown = unknownStyle(0.16)
  return Object.assign(s, over)
}

function textsDrawn(calls: { name: string; args: unknown[] }[]): string[] {
  return calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]))
}

describe('styles and labels', () => {
  const styles = buildStyles(classes, 0.2)
  it('builds a style per class with fill alpha and contrasting chip text', () => {
    const car = styles.get(1)!
    expect(car.stroke).toBe('#3b82f6')
    expect(car.fill).toBe('rgba(59, 130, 246, 0.2)')
    expect(car.chipText).toBe('#ffffff')
    expect(styles.get(2)!.chipText).not.toBe('#ffffff')
    expect(car.hover).not.toBe(car.stroke)
  })
  it('unknown classes get the grey dashed style', () => {
    const unknown = unknownStyle(0.2)
    expect(unknown.dashed).toBe(true)
    expect(styleOf(box('a', 0, 0, 1, 1, { classId: null }), styles, unknown)).toBe(unknown)
    expect(styleOf(box('a', 0, 0, 1, 1, { classId: 99 }), styles, unknown)).toBe(unknown)
    expect(styleOf(box('a', 0, 0, 1, 1), styles, unknown)).toBe(styles.get(1))
  })
  it('labels: class name, raw label, ? or #id', () => {
    expect(labelFor(box('a', 0, 0, 1, 1), styles)).toBe('car')
    expect(labelFor(box('a', 0, 0, 1, 1, { classId: null, rawLabel: 'truck' }), styles)).toBe('truck')
    expect(labelFor(box('a', 0, 0, 1, 1, { classId: 42, rawLabel: 'bus' }), styles)).toBe('bus')
    expect(labelFor(box('a', 0, 0, 1, 1, { classId: null }), styles)).toBe('?')
    expect(labelFor(box('a', 0, 0, 1, 1, { classId: 42 }), styles)).toBe('#42')
  })
})

describe('OverlayRenderer', () => {
  it('draws visible boxes, skips hidden and off-screen ones', () => {
    const m = createMockContext()
    const r = new OverlayRenderer(m.ctx)
    r.draw(
      scene({
        boxes: [box('a', 10, 50, 110, 150), box('h', 10, 50, 110, 150, { hidden: true }), box('far', 5000, 5000, 5100, 5100)],
      }),
    )
    expect(m.count('fillRect')).toBe(1)
    expect(m.count('strokeRect')).toBe(1)
    expect(textsDrawn(m.calls)).toEqual(['car'])
  })

  it('label chips: hidden with showLabels=false and for tiny boxes unless emphasised', () => {
    const m = createMockContext()
    const r = new OverlayRenderer(m.ctx)
    const boxes = [box('big', 10, 50, 110, 150), box('tiny', 300, 300, 303, 303)]
    r.draw(scene({ boxes, showLabels: false }))
    expect(textsDrawn(m.calls)).toEqual([])
    m.clear()
    r.draw(scene({ boxes }))
    expect(textsDrawn(m.calls)).toEqual(['car'])
    m.clear()
    r.draw(scene({ boxes, hoverId: 'tiny' }))
    expect(textsDrawn(m.calls)).toEqual(['car', 'car'])
  })

  it('places the chip above the box, or inside at the top edge', () => {
    const m = createMockContext()
    const r = new OverlayRenderer(m.ctx)
    r.draw(scene({ boxes: [box('a', 10, 100, 110, 200)] }))
    const above = m.calls.find((c) => c.name === 'fillText')!
    expect(above.args[2] as number).toBeLessThan(100)
    m.clear()
    r.draw(scene({ boxes: [box('a', 10, 2, 110, 200)] }))
    const inside = m.calls.find((c) => c.name === 'fillText')!
    expect(inside.args[2] as number).toBeGreaterThan(2)
    expect(inside.args[2] as number).toBeLessThan(2 + CHIP_HEIGHT + 2)
  })

  it('puts the chip inside a box at the top edge of the image even with room above', () => {
    const m = createMockContext()
    const r = new OverlayRenderer(m.ctx)
    // image top is at screen y = 40; the box touches it
    r.draw(scene({ view: { scale: 1, tx: 24, ty: 40 }, boxes: [box('a', 10, 0, 110, 100)] }))
    const t = m.calls.find((c) => c.name === 'fillText')!
    expect(t.args[2] as number).toBeGreaterThan(40)
    m.clear()
    r.draw(scene({ view: { scale: 1, tx: 24, ty: 40 }, boxes: [box('a', 10, 30, 110, 100)] }))
    expect(m.calls.find((c) => c.name === 'fillText')!.args[2] as number).toBeLessThan(70)
  })

  it('unknown classes show the raw label with a dashed outline', () => {
    const m = createMockContext()
    const r = new OverlayRenderer(m.ctx)
    r.draw(scene({ boxes: [box('u', 10, 50, 110, 150, { classId: null, rawLabel: 'truck' })] }))
    expect(textsDrawn(m.calls)).toEqual(['truck'])
    const dashes = m.calls.filter((c) => c.name === 'setLineDash').map((c) => c.args[0] as number[])
    expect(dashes.some((d) => d.length > 0)).toBe(true)
  })

  it('selected boxes get a white stroke and an accent halo; handles only for the handle box', () => {
    const m = createMockContext()
    const r = new OverlayRenderer(m.ctx)
    const boxes = [box('a', 10, 50, 110, 150)]
    r.draw(scene({ boxes, selected: new Set(['a']), accent: '#3D8FD6' }))
    expect(m.sets).toContainEqual(['strokeStyle', '#ffffff'])
    expect(m.sets).toContainEqual(['strokeStyle', '#3D8FD6'])
    expect(m.count('rect')).toBe(0)
    m.clear()
    r.draw(scene({ boxes, selected: new Set(['a']), handleId: 'a' }))
    expect(m.count('rect')).toBe(8)
    m.clear()
    r.draw(scene({ boxes: [box('s', 10, 50, 20, 60)], selected: new Set(['s']), handleId: 's' }))
    expect(m.count('rect')).toBe(4) // short sides: corners only
  })

  it('applies move and resize previews', () => {
    const m = createMockContext()
    const r = new OverlayRenderer(m.ctx)
    const boxes = [box('a', 10, 50, 110, 150), box('b', 200, 200, 300, 300)]
    r.draw(scene({ boxes, moveIds: new Set(['a']), moveDx: 5, moveDy: 7, view: { scale: 2, tx: 0, ty: 0 } }))
    const fills = m.calls.filter((c) => c.name === 'fillRect' && c.args[2] !== 800)
    expect(fills.some((c) => c.args[0] === 30 && c.args[1] === 114)).toBe(true)
    m.clear()
    r.draw(scene({ boxes, resizeId: 'b', resizeRect: { x1: 200, y1: 200, x2: 400, y2: 350 } }))
    expect(m.calls.some((c) => c.name === 'fillRect' && c.args[2] === 200 && c.args[3] === 150)).toBe(true)
  })

  it('marquee preview highlights intersecting boxes', () => {
    const m = createMockContext()
    const r = new OverlayRenderer(m.ctx)
    r.draw(scene({ boxes: [box('a', 10, 50, 110, 150)], marquee: { x1: 0, y1: 0, x2: 50, y2: 80 } }))
    expect(m.sets).toContainEqual(['strokeStyle', '#ffffff'])
  })

  it('draws the crosshair, the draft with its size and pins', () => {
    const m = createMockContext()
    const r = new OverlayRenderer(m.ctx)
    r.draw(
      scene({
        crosshair: true,
        pointerX: 100,
        pointerY: 120,
        draft: { x1: 10, y1: 10, x2: 60, y2: 40 },
        pins: [
          { id: 1, x: 300, y: 300 },
          { id: 2, x: 400, y: 300, label: 'B', resolved: true },
        ],
      }),
    )
    expect(m.count('moveTo')).toBe(2)
    expect(m.count('lineTo')).toBe(2)
    const texts = textsDrawn(m.calls)
    expect(texts).toContain('50 × 30')
    expect(texts).toContain('1')
    expect(texts).toContain('B')
    expect(texts.indexOf('B')).toBeLessThan(texts.indexOf('1')) // resolved drawn underneath
  })

  it('caches label widths across frames', () => {
    const m = createMockContext()
    const r = new OverlayRenderer(m.ctx)
    const s = scene({ boxes: [box('a', 10, 50, 110, 150), box('b', 200, 50, 300, 150), box('c', 400, 50, 500, 150, { classId: 2 })] })
    r.draw(s)
    r.draw(s)
    expect(m.count('measureText')).toBe(2) // "car" and "bicycle"
    r.invalidateText()
    r.draw(s)
    expect(m.count('measureText')).toBe(4)
  })

  it('falls back to fillRect chips without roundRect', () => {
    const m = createMockContext(undefined, { roundRect: false })
    const r = new OverlayRenderer(m.ctx)
    r.draw(scene({ boxes: [box('a', 10, 50, 110, 150)] }))
    expect(m.count('fillRect')).toBe(2) // box fill + chip
  })

  it('1000 boxes draw with a bounded number of canvas calls', () => {
    const m = createMockContext()
    const r = new OverlayRenderer(m.ctx)
    const boxes: CanvasBox[] = []
    for (let i = 0; i < 1000; i++) {
      const x = (i % 40) * 20
      const y = Math.floor(i / 40) * 24
      boxes.push(box(`b${i}`, x, y, x + 15, y + 18, { classId: (i % 2) + 1 }))
    }
    const s = scene({ boxes, hoverId: 'b5', selected: new Set(['b7']), handleId: 'b7' })
    r.draw(s)
    m.clear()
    const t0 = performance.now()
    r.draw(s)
    const elapsed = performance.now() - t0
    // fill + stroke + chip (roundRect, fill, fillText, a couple of style changes) per box
    expect(m.calls.length / boxes.length).toBeLessThan(9)
    expect(elapsed).toBeLessThan(250) // generous: the mock context itself is slow
  })
})

describe('drawImageLayer', () => {
  function params(over: Partial<ImageLayerParams> = {}): ImageLayerParams {
    return {
      width: 800,
      height: 600,
      dpr: 1,
      view: { scale: 0.5, tx: 100, ty: 50 },
      image: null,
      imageWidth: 1000,
      imageHeight: 800,
      backdrop: '#090b0e',
      pattern: null,
      ...over,
    }
  }
  const fakeImage = (w: number, h: number) => ({ width: w, height: h }) as unknown as CanvasImage

  it('paints only the backdrop without an image', () => {
    const m = createMockContext()
    drawImageLayer(m.ctx, params())
    expect(m.count('drawImage')).toBe(0)
    expect(m.sets).toContainEqual(['fillStyle', '#090b0e'])
  })

  it('draws the whole image with smoothing when it fits', () => {
    const m = createMockContext()
    drawImageLayer(m.ctx, params({ image: fakeImage(1000, 800) }))
    const d = m.calls.find((c) => c.name === 'drawImage')!
    expect(d.args.slice(1)).toEqual([0, 0, 1000, 800, 100, 50, 500, 400])
    expect(m.sets).toContainEqual(['imageSmoothingEnabled', true])
    expect(m.sets.some(([k]) => k === 'shadowBlur')).toBe(true)
  })

  it('draws only the visible source region, pixel-exact when zoomed in', () => {
    const m = createMockContext()
    drawImageLayer(m.ctx, params({ image: fakeImage(1000, 800), view: { scale: 4, tx: -1000, ty: -400 } }))
    const d = m.calls.find((c) => c.name === 'drawImage')!
    const [sx, sy, sw, sh, dx, dy, dw, dh] = d.args.slice(1) as number[]
    expect([sx, sy, sw, sh]).toEqual([250, 100, 200, 150])
    expect([dx, dy, dw, dh]).toEqual([0, 0, 800, 600])
    expect(m.sets).toContainEqual(['imageSmoothingEnabled', false])
    expect(m.sets.some(([k]) => k === 'shadowBlur')).toBe(false) // image covers the viewport
  })

  it('maps a reduced-resolution source onto image coordinates', () => {
    const m = createMockContext()
    drawImageLayer(m.ctx, params({ image: fakeImage(500, 400) }))
    const d = m.calls.find((c) => c.name === 'drawImage')!
    expect(d.args.slice(1)).toEqual([0, 0, 500, 400, 100, 50, 500, 400])
  })

  it('skips closed bitmaps, unloaded images and off-screen images', () => {
    const m = createMockContext()
    drawImageLayer(m.ctx, params({ image: fakeImage(0, 0) }))
    drawImageLayer(m.ctx, params({ image: fakeImage(1000, 800), view: { scale: 1, tx: 5000, ty: 0 } }))
    expect(m.count('drawImage')).toBe(0)
    const unloaded = { naturalWidth: 0, naturalHeight: 0, complete: false } as unknown as CanvasImage
    expect(sourceSize(unloaded)).toEqual([0, 0])
  })

  it('survives drawImage throwing', () => {
    const m = createMockContext()
    const ctx = new Proxy(m.ctx, {
      get(t, k) {
        if (k === 'drawImage')
          return () => {
            throw new Error('InvalidStateError')
          }
        return Reflect.get(t, k)
      },
      set(t, k, v) {
        return Reflect.set(t, k, v)
      },
    })
    expect(() => drawImageLayer(ctx, params({ image: fakeImage(1000, 800) }))).not.toThrow()
  })
})
