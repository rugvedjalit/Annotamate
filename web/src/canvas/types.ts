/**
 * Public contract of the annotation canvas module.
 *
 * This file is shared between the canvas engine and the rest of the app. Treat it as frozen:
 * add optional fields if needed, never rename or remove existing ones.
 * All coordinates are image pixels unless the name says "screen".
 */
import type { ReactNode } from 'react'

export interface CanvasBox {
  id: string
  /** ProjectClass id; null = label not in the project's class list (drawn grey, uses rawLabel). */
  classId: number | null
  rawLabel?: string | null
  x1: number
  y1: number
  x2: number
  y2: number
  hidden?: boolean
  locked?: boolean
}

export interface CanvasClass {
  id: number
  name: string
  color: string // "#RRGGBB"
}

export type CanvasTool = 'select' | 'box' | 'pan'

/** Drag gestures reported by `onGestureChange`. */
export type CanvasGestureKind = 'pan' | 'draw' | 'move' | 'resize' | 'marquee'

export interface CanvasPin {
  id: string | number
  x: number
  y: number
  label?: string
  resolved?: boolean
}

/** screen = image * scale + (tx, ty), in CSS pixels relative to the canvas container. */
export interface ViewState {
  scale: number
  tx: number
  ty: number
}

export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

export type BoxChangeKind = 'create' | 'move' | 'resize' | 'delete'

export interface BoxChangeMeta {
  kind: BoxChangeKind
  /** ids of the boxes affected by the gesture */
  ids: string[]
}

export interface AnnotationCanvasProps {
  /** Decoded image. null while loading (the canvas shows the backdrop only). */
  image: ImageBitmap | HTMLImageElement | HTMLCanvasElement | null
  imageWidth: number
  imageHeight: number
  /** Changes whenever a different image is shown; used to re-fit the view. */
  imageKey: string | number

  boxes: CanvasBox[]
  classes: CanvasClass[]
  selectedIds: string[]
  tool: CanvasTool
  readOnly?: boolean

  /** Class for boxes created by drawing. null = caller decides later (e.g. class picker). */
  defaultClassId?: number | null
  /** Box id to highlight (e.g. hovered in the objects list). */
  highlightId?: string | null

  showLabels?: boolean // default true
  showCrosshair?: boolean // default true
  fillOpacity?: number // default 0.16
  strokeWidth?: number // default 2
  wheel?: 'zoom' | 'scroll' // default 'zoom'
  pins?: CanvasPin[]
  /** When true, the next click on the image calls onPinPlace instead of editing. */
  placingPin?: boolean

  onSelectionChange: (ids: string[]) => void
  /**
   * Called once per completed gesture with the full next box list.
   * For 'create', the new box is the last element and also passed to onBoxCreated.
   */
  onBoxesChange: (next: CanvasBox[], meta: BoxChangeMeta) => void
  /** After a box is drawn. anchor = screen point (container-relative) near the box's top-right corner. */
  onBoxCreated?: (box: CanvasBox, anchor: { x: number; y: number }) => void
  /** Pointer position in image pixels (null when the pointer leaves the canvas). */
  onCursorMove?: (p: { x: number; y: number } | null) => void
  /** Fires on every view change (pan/zoom/resize/fit). zoom = scale. */
  onViewChange?: (view: ViewState) => void
  onPinClick?: (pin: CanvasPin) => void
  onPinPlace?: (p: { x: number; y: number }) => void
  onContextMenu?: (e: { clientX: number; clientY: number; boxId: string | null }) => void
  /** Double click on a box (e.g. open the class picker). */
  onBoxDoubleClick?: (boxId: string, anchor: { x: number; y: number }) => void
  /**
   * Called with the drag kind when a drag gesture starts (after the 3 px threshold) and with null
   * when it ends or is cancelled. Handy for hiding floating UI (box toolbar) while dragging.
   */
  onGestureChange?: (gesture: CanvasGestureKind | null) => void

  className?: string
  /**
   * Extra content rendered inside the canvas container, above both canvas layers (e.g. the floating
   * box toolbar or zoom control). Coordinates from boxScreenRect/onBoxCreated are relative to this
   * container, so absolutely positioned children line up without conversion.
   */
  children?: ReactNode
}

export interface AnnotationCanvasHandle {
  zoomToFit(): void
  /** 1 image px = 1 CSS px, centred on the current view centre. */
  zoomToActual(): void
  /** Multiply scale by factor around the view centre. */
  zoomBy(factor: number): void
  /** Pan/zoom so the box is visible (keeps scale unless the box does not fit). */
  revealBox(boxId: string): void
  getView(): ViewState
  /** Screen rect (container-relative CSS px) of a box, or null if unknown. */
  boxScreenRect(boxId: string): ScreenRect | null
  /** Convert container-relative screen coordinates to image pixels. */
  screenToImage(p: { x: number; y: number }): { x: number; y: number }
  /** Cancel any in-progress gesture (as if Escape was pressed). */
  cancelGesture(): void
  /** Convert image pixels to container-relative screen coordinates (inverse of screenToImage). */
  imageToScreen?(p: { x: number; y: number }): { x: number; y: number }
  /** True while the pointer is down on the canvas (pending click or any drag). */
  isGestureActive?(): boolean
}
