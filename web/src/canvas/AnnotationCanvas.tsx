import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type CSSProperties, type RefObject } from 'react'
import { CanvasEngine } from './engine'
import type { AnnotationCanvasHandle, AnnotationCanvasProps } from './types'

const CONTAINER_STYLE: CSSProperties = {
  overflow: 'hidden',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
  background: 'var(--canvas, #090b0e)',
}

const LAYER_STYLE: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: '100%',
  height: '100%',
  display: 'block',
}

const IMAGE_LAYER_STYLE: CSSProperties = { ...LAYER_STYLE, pointerEvents: 'none' }
const OVERLAY_LAYER_STYLE: CSSProperties = { ...LAYER_STYLE, touchAction: 'none' }

function createHandle(engine: RefObject<CanvasEngine | null>): Required<AnnotationCanvasHandle> {
  return {
    zoomToFit: () => engine.current?.zoomToFit(),
    zoomToActual: () => engine.current?.zoomToActual(),
    zoomBy: (factor) => engine.current?.zoomBy(factor),
    revealBox: (boxId) => engine.current?.revealBox(boxId),
    getView: () => engine.current?.getView() ?? { scale: 1, tx: 0, ty: 0 },
    boxScreenRect: (boxId) => engine.current?.boxScreenRect(boxId) ?? null,
    screenToImage: (p) => engine.current?.screenToImage(p) ?? { x: p.x, y: p.y },
    imageToScreen: (p) => engine.current?.imageToScreen(p) ?? { x: p.x, y: p.y },
    cancelGesture: () => engine.current?.cancelGesture(),
    isGestureActive: () => engine.current?.isGestureActive() ?? false,
  }
}

/**
 * Annotation canvas: image layer + interactive overlay (boxes, handles, chips, crosshair, pins).
 * Size it with `className` (it fills its own box; it becomes `position: relative` unless the
 * class already positions it). All interaction state lives in a non-React engine, so pointer
 * moves never re-render this component.
 */
export const AnnotationCanvas = forwardRef<AnnotationCanvasHandle, AnnotationCanvasProps>(function AnnotationCanvas(
  props,
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<CanvasEngine | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    const image = imageRef.current
    const overlay = overlayRef.current
    if (!container || !image || !overlay) return
    const engine = new CanvasEngine(container, image, overlay)
    engineRef.current = engine
    return () => {
      engine.destroy()
      engineRef.current = null
    }
  }, [])

  // Runs after every render (props are the only reason this component renders).
  useLayoutEffect(() => {
    engineRef.current?.setProps(props)
  })

  useImperativeHandle(ref, () => createHandle(engineRef), [])

  return (
    <div ref={containerRef} className={props.className} style={CONTAINER_STYLE} data-annotation-canvas="">
      <canvas ref={imageRef} style={IMAGE_LAYER_STYLE} aria-hidden="true" />
      <canvas ref={overlayRef} style={OVERLAY_LAYER_STYLE} aria-label="Annotation canvas" />
      {props.children}
    </div>
  )
})
