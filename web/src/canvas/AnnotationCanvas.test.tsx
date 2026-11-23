import { act, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnnotationCanvas } from './AnnotationCanvas'
import { createMockContext, type MockContext } from './testing'
import type { AnnotationCanvasHandle, AnnotationCanvasProps, CanvasBox } from './types'

const W = 800
const H = 600

class FakeResizeObserver {
  private readonly cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
  }
  observe(target: Element) {
    const entry = {
      target,
      contentRect: { width: W, height: H, x: 0, y: 0, top: 0, left: 0, right: W, bottom: H },
      devicePixelContentBoxSize: [],
      contentBoxSize: [],
      borderBoxSize: [],
    } as unknown as ResizeObserverEntry
    this.cb([entry], this as unknown as ResizeObserver)
  }
  unobserve() {}
  disconnect() {}
}

const boxes: CanvasBox[] = [
  { id: 'a', classId: 1, x1: 100, y1: 100, x2: 300, y2: 300 },
  { id: 'b', classId: 2, x1: 500, y1: 400, x2: 600, y2: 500, locked: true },
]

function baseProps(over: Partial<AnnotationCanvasProps> = {}): AnnotationCanvasProps {
  return {
    image: null,
    imageWidth: 1000,
    imageHeight: 800,
    imageKey: 'img-1',
    boxes,
    classes: [
      { id: 1, name: 'car', color: '#3b82f6' },
      { id: 2, name: 'person', color: '#f97316' },
    ],
    selectedIds: [],
    tool: 'select',
    onSelectionChange: vi.fn(),
    onBoxesChange: vi.fn(),
    ...over,
  }
}

function overlayOf(container: HTMLElement): HTMLCanvasElement {
  return container.querySelectorAll('canvas')[1] as HTMLCanvasElement
}

function pointer(type: 'pointerDown' | 'pointerMove' | 'pointerUp', el: Element, x: number, y: number, init = {}) {
  const buttons = type === 'pointerUp' ? 0 : 1
  fireEvent[type](el, { clientX: x, clientY: y, button: 0, buttons, pointerId: 1, isPrimary: true, ...init })
}

let contexts: MockContext[] = []

beforeEach(() => {
  contexts = []
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: W,
    height: H,
    right: W,
    bottom: H,
    toJSON: () => ({}),
  } as DOMRect)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const m = createMockContext(this)
    contexts.push(m)
    return m.ctx
  } as unknown as HTMLCanvasElement['getContext'])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

describe('AnnotationCanvas', () => {
  it('renders two stacked canvases and does not crash without a 2D context', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const ref = createRef<AnnotationCanvasHandle>()
    const { container, unmount } = render(<AnnotationCanvas ref={ref} {...baseProps({ className: 'cv' })} />)
    const root = container.querySelector('.cv') as HTMLElement
    expect(root).toBeInTheDocument()
    expect(root.querySelectorAll('canvas')).toHaveLength(2)
    expect(root.style.position).toBe('relative')
    await nextFrame()
    pointer('pointerDown', overlayOf(container), 10, 10)
    pointer('pointerUp', overlayOf(container), 10, 10)
    expect(() => unmount()).not.toThrow()
  })

  it('renders children above the canvases', () => {
    const { getByText } = render(
      <AnnotationCanvas {...baseProps()}>
        <div>toolbar</div>
      </AnnotationCanvas>,
    )
    expect(getByText('toolbar')).toBeInTheDocument()
  })

  it('fits the image on mount and reports the view', () => {
    const onViewChange = vi.fn()
    const ref = createRef<AnnotationCanvasHandle>()
    render(<AnnotationCanvas ref={ref} {...baseProps({ onViewChange })} />)
    const v = ref.current!.getView()
    expect(v.scale).toBeCloseTo(Math.min((W - 48) / 1000, (H - 48) / 800))
    expect(onViewChange).toHaveBeenLastCalledWith(v)
  })

  it('exposes a working imperative handle', () => {
    const ref = createRef<AnnotationCanvasHandle>()
    render(<AnnotationCanvas ref={ref} {...baseProps()} />)
    const h = ref.current!
    const fit = h.getView()
    h.zoomBy(2)
    expect(h.getView().scale).toBeCloseTo(fit.scale * 2)
    h.zoomToActual()
    expect(h.getView().scale).toBe(1)
    h.zoomToFit()
    expect(h.getView()).toEqual(fit)

    const r = h.boxScreenRect('a')!
    expect(r.x).toBeCloseTo(100 * fit.scale + fit.tx)
    expect(r.w).toBeCloseTo(200 * fit.scale)
    expect(h.boxScreenRect('missing')).toBeNull()

    const p = h.screenToImage({ x: 400, y: 300 })
    expect(h.imageToScreen!(p)).toEqual({ x: 400, y: 300 })

    h.zoomBy(20)
    h.revealBox('b')
    const rb = h.boxScreenRect('b')!
    expect(rb.x).toBeGreaterThanOrEqual(0)
    expect(rb.x + rb.w).toBeLessThanOrEqual(W)
    expect(rb.y).toBeGreaterThanOrEqual(0)
    expect(rb.y + rb.h).toBeLessThanOrEqual(H)
    expect(() => h.cancelGesture()).not.toThrow()
    expect(h.isGestureActive!()).toBe(false)
  })

  it('re-fits when imageKey changes', () => {
    const ref = createRef<AnnotationCanvasHandle>()
    const { rerender } = render(<AnnotationCanvas ref={ref} {...baseProps()} />)
    ref.current!.zoomBy(3)
    rerender(<AnnotationCanvas ref={ref} {...baseProps({ imageKey: 'img-2', imageWidth: 400, imageHeight: 1600 })} />)
    expect(ref.current!.getView().scale).toBeCloseTo(Math.min((W - 48) / 400, (H - 48) / 1600))
  })

  it('draws a box with the box tool: one commit, then onBoxCreated', () => {
    const onBoxesChange = vi.fn()
    const onBoxCreated = vi.fn()
    const onGestureChange = vi.fn()
    const ref = createRef<AnnotationCanvasHandle>()
    const { container } = render(
      <AnnotationCanvas
        ref={ref}
        {...baseProps({ tool: 'box', defaultClassId: 2, onBoxesChange, onBoxCreated, onGestureChange })}
      />,
    )
    const o = overlayOf(container)
    pointer('pointerDown', o, 400, 100)
    expect(ref.current!.isGestureActive!()).toBe(true)
    pointer('pointerMove', o, 450, 150)
    pointer('pointerMove', o, 500, 200)
    expect(onBoxesChange).not.toHaveBeenCalled()
    pointer('pointerUp', o, 500, 200)
    expect(onBoxesChange).toHaveBeenCalledTimes(1)
    const [next, meta] = onBoxesChange.mock.calls[0]!
    expect(meta.kind).toBe('create')
    expect(next).toHaveLength(3)
    const created = next[2]
    const a = ref.current!.screenToImage({ x: 400, y: 100 })
    const b = ref.current!.screenToImage({ x: 500, y: 200 })
    expect(created.classId).toBe(2)
    expect(created.x1).toBeCloseTo(a.x, 6)
    expect(created.y1).toBeCloseTo(a.y, 6)
    expect(created.x2).toBeCloseTo(b.x, 6)
    expect(created.y2).toBeCloseTo(b.y, 6)
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(onBoxCreated).toHaveBeenCalledWith(created, ref.current!.imageToScreen!({ x: created.x2, y: created.y1 }))
    expect(onBoxCreated.mock.calls[0]![1].x).toBeCloseTo(500)
    expect(onBoxCreated.mock.calls[0]![1].y).toBeCloseTo(100)
    expect(onBoxesChange.mock.invocationCallOrder[0]).toBeLessThan(onBoxCreated.mock.invocationCallOrder[0]!)
    expect(onGestureChange.mock.calls).toEqual([['draw'], [null]])
  })

  it('Escape cancels the drag (window listener) and nothing is committed', () => {
    const onBoxesChange = vi.fn()
    const { container } = render(<AnnotationCanvas {...baseProps({ tool: 'box', onBoxesChange })} />)
    const o = overlayOf(container)
    pointer('pointerDown', o, 400, 100)
    pointer('pointerMove', o, 500, 200)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(true)
    pointer('pointerMove', o, 550, 250)
    pointer('pointerUp', o, 550, 250)
    expect(onBoxesChange).not.toHaveBeenCalled()
    // The listener is gone once idle: Escape is not swallowed any more.
    const esc2 = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(esc2)
    expect(esc2.defaultPrevented).toBe(false)
  })

  it('cancelGesture() aborts a move', () => {
    const onBoxesChange = vi.fn()
    const ref = createRef<AnnotationCanvasHandle>()
    const { container } = render(
      <AnnotationCanvas ref={ref} {...baseProps({ selectedIds: ['a'], onBoxesChange })} />,
    )
    const o = overlayOf(container)
    const c = ref.current!.imageToScreen!({ x: 200, y: 200 })
    pointer('pointerDown', o, c.x, c.y)
    pointer('pointerMove', o, c.x + 40, c.y + 40)
    act(() => ref.current!.cancelGesture())
    pointer('pointerUp', o, c.x + 40, c.y + 40)
    expect(onBoxesChange).not.toHaveBeenCalled()
  })

  it('moves the selection with one commit and selects on click', () => {
    const onBoxesChange = vi.fn()
    const onSelectionChange = vi.fn()
    const ref = createRef<AnnotationCanvasHandle>()
    const { container } = render(
      <AnnotationCanvas ref={ref} {...baseProps({ selectedIds: ['a'], onBoxesChange, onSelectionChange })} />,
    )
    const o = overlayOf(container)
    const c = ref.current!.imageToScreen!({ x: 200, y: 200 })
    pointer('pointerDown', o, c.x, c.y)
    for (let i = 1; i <= 10; i++) pointer('pointerMove', o, c.x + i * 5, c.y)
    pointer('pointerUp', o, c.x + 50, c.y)
    expect(onBoxesChange).toHaveBeenCalledTimes(1)
    expect(onBoxesChange.mock.calls[0]![1]).toEqual({ kind: 'move', ids: ['a'] })
    const moved = onBoxesChange.mock.calls[0]![0][0] as CanvasBox
    expect(moved.x1).toBeCloseTo(100 + 50 / ref.current!.getView().scale)

    const lb = ref.current!.imageToScreen!({ x: 550, y: 450 })
    pointer('pointerDown', o, lb.x, lb.y)
    pointer('pointerUp', o, lb.x, lb.y)
    expect(onSelectionChange).toHaveBeenLastCalledWith(['b'])
  })

  it('read-only blocks edits but keeps selection', () => {
    const onBoxesChange = vi.fn()
    const onSelectionChange = vi.fn()
    const ref = createRef<AnnotationCanvasHandle>()
    const { container } = render(
      <AnnotationCanvas ref={ref} {...baseProps({ readOnly: true, tool: 'box', onBoxesChange, onSelectionChange })} />,
    )
    const o = overlayOf(container)
    pointer('pointerDown', o, 400, 100)
    pointer('pointerMove', o, 500, 200)
    pointer('pointerUp', o, 500, 200)
    const c = ref.current!.imageToScreen!({ x: 200, y: 200 })
    pointer('pointerDown', o, c.x, c.y)
    pointer('pointerUp', o, c.x, c.y)
    expect(onBoxesChange).not.toHaveBeenCalled()
    expect(onSelectionChange).toHaveBeenLastCalledWith(['a'])
  })

  it('wheel zooms at the cursor and the middle button pans', () => {
    const onViewChange = vi.fn()
    const ref = createRef<AnnotationCanvasHandle>()
    const { container } = render(<AnnotationCanvas ref={ref} {...baseProps({ onViewChange })} />)
    const o = overlayOf(container)
    const before = ref.current!.screenToImage({ x: 300, y: 200 })
    const wheel = new WheelEvent('wheel', { deltaY: -100, clientX: 300, clientY: 200, bubbles: true, cancelable: true })
    o.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    const after = ref.current!.screenToImage({ x: 300, y: 200 })
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(onViewChange.mock.lastCall![0].scale).toBeGreaterThan(0.69)

    const v0 = ref.current!.getView()
    pointer('pointerDown', o, 300, 300, { button: 1, buttons: 4 })
    pointer('pointerMove', o, 340, 310, { buttons: 4 })
    pointer('pointerUp', o, 340, 310, { button: 1 })
    expect(ref.current!.getView().tx).toBeCloseTo(v0.tx + 40)
    expect(ref.current!.getView().ty).toBeCloseTo(v0.ty + 10)
  })

  it('reports the cursor, context menu, double click and cursor styles', () => {
    const onCursorMove = vi.fn()
    const onContextMenu = vi.fn()
    const onBoxDoubleClick = vi.fn()
    const ref = createRef<AnnotationCanvasHandle>()
    const { container } = render(
      <AnnotationCanvas ref={ref} {...baseProps({ onCursorMove, onContextMenu, onBoxDoubleClick })} />,
    )
    const o = overlayOf(container)
    const c = ref.current!.imageToScreen!({ x: 200, y: 200 })
    pointer('pointerMove', o, c.x, c.y, { buttons: 0 })
    expect(onCursorMove.mock.lastCall![0].x).toBeCloseTo(200)
    expect(o.style.cursor).toBe('move')
    const lb = ref.current!.imageToScreen!({ x: 550, y: 450 })
    pointer('pointerMove', o, lb.x, lb.y, { buttons: 0 })
    expect(o.style.cursor).toBe('default') // locked
    fireEvent.pointerLeave(o)
    expect(onCursorMove).toHaveBeenLastCalledWith(null)

    const menu = new MouseEvent('contextmenu', { clientX: c.x, clientY: c.y, bubbles: true, cancelable: true })
    o.dispatchEvent(menu)
    expect(menu.defaultPrevented).toBe(true)
    expect(onContextMenu).toHaveBeenCalledWith({ clientX: c.x, clientY: c.y, boxId: 'a' })

    pointer('pointerDown', o, c.x, c.y)
    pointer('pointerUp', o, c.x, c.y)
    fireEvent.dblClick(o, { clientX: c.x, clientY: c.y })
    expect(onBoxDoubleClick).toHaveBeenCalledWith('a', ref.current!.imageToScreen!({ x: 300, y: 100 }))
  })

  it('places pins and reports pin clicks', () => {
    const onPinPlace = vi.fn()
    const onPinClick = vi.fn()
    const pins = [{ id: 1, x: 900, y: 700 }]
    const ref = createRef<AnnotationCanvasHandle>()
    const { container, rerender } = render(
      <AnnotationCanvas ref={ref} {...baseProps({ placingPin: true, pins, onPinPlace, onPinClick })} />,
    )
    const o = overlayOf(container)
    const c = ref.current!.imageToScreen!({ x: 200, y: 200 })
    pointer('pointerDown', o, c.x, c.y)
    pointer('pointerUp', o, c.x, c.y)
    expect(onPinPlace.mock.lastCall![0].x).toBeCloseTo(200)
    rerender(<AnnotationCanvas ref={ref} {...baseProps({ pins, onPinPlace, onPinClick })} />)
    const pc = ref.current!.imageToScreen!({ x: 900, y: 700 })
    pointer('pointerDown', o, pc.x, pc.y)
    pointer('pointerUp', o, pc.x, pc.y)
    expect(onPinClick).toHaveBeenCalledWith(pins[0])
  })

  it('draws both layers through the 2D context on the next frame', async () => {
    const image = document.createElement('canvas')
    image.width = 1000
    image.height = 800
    render(<AnnotationCanvas {...baseProps({ image, selectedIds: ['a'], pins: [{ id: 1, x: 10, y: 10 }] })} />)
    await nextFrame()
    const [imageLayer, overlay] = contexts
    expect(imageLayer!.count('drawImage')).toBe(1)
    expect(overlay!.count('strokeRect')).toBeGreaterThan(0)
    expect(overlay!.calls.some((c) => c.name === 'fillText' && c.args[0] === 'car')).toBe(true)
  })

  it('cleans up window listeners on unmount mid-gesture', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { container, unmount } = render(<AnnotationCanvas {...baseProps({ tool: 'box' })} />)
    const o = overlayOf(container)
    pointer('pointerDown', o, 400, 100)
    pointer('pointerMove', o, 500, 200)
    unmount()
    expect(remove.mock.calls.some(([type]) => type === 'keydown')).toBe(true)
  })
})
