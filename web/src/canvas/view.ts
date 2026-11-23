// Pure view math: screen = image * scale + (tx, ty), in CSS px relative to the canvas container.
import { clamp, type Point, type Rect } from './geometry'
import type { ScreenRect, ViewState } from './types'

export const MIN_SCALE = 0.02
export const MAX_SCALE = 40
/** Padding (CSS px) around the image when fitting. */
export const FIT_PADDING = 24
/** Above this scale the image is drawn without smoothing (pixel-exact). */
export const SMOOTHING_MAX_SCALE = 1.5
/** Minimum part of the image (CSS px) that panning keeps on screen. */
export const KEEP_VISIBLE = 48

export const IDENTITY_VIEW: ViewState = Object.freeze({ scale: 1, tx: 0, ty: 0 })

export function clampScale(s: number): number {
  if (!Number.isFinite(s) || s <= 0) return 1
  return clamp(s, MIN_SCALE, MAX_SCALE)
}

export function screenToImage(view: ViewState, sx: number, sy: number): Point {
  return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale }
}

export function imageToScreen(view: ViewState, ix: number, iy: number): Point {
  return { x: ix * view.scale + view.tx, y: iy * view.scale + view.ty }
}

/** Screen rectangle of an image-space rect (normalised, CSS px). */
export function rectToScreen(view: ViewState, r: Rect): ScreenRect {
  const x1 = Math.min(r.x1, r.x2) * view.scale + view.tx
  const y1 = Math.min(r.y1, r.y2) * view.scale + view.ty
  return {
    x: x1,
    y: y1,
    w: Math.abs(r.x2 - r.x1) * view.scale,
    h: Math.abs(r.y2 - r.y1) * view.scale,
  }
}

function effectivePadding(padding: number, vw: number, vh: number): number {
  // Never let the padding eat more than a quarter of a small viewport.
  return Math.max(0, Math.min(padding, vw / 4, vh / 4))
}

/** Fit a `rect` (image px) into a `vw` x `vh` viewport with padding, centred. */
export function fitRect(rect: Rect, vw: number, vh: number, padding = FIT_PADDING): ViewState {
  const rw = Math.abs(rect.x2 - rect.x1)
  const rh = Math.abs(rect.y2 - rect.y1)
  if (rw <= 0 || rh <= 0 || vw <= 0 || vh <= 0) return { scale: 1, tx: 0, ty: 0 }
  const pad = effectivePadding(padding, vw, vh)
  const scale = clampScale(Math.min((vw - 2 * pad) / rw, (vh - 2 * pad) / rh))
  const cx = (Math.min(rect.x1, rect.x2) + rw / 2) * scale
  const cy = (Math.min(rect.y1, rect.y2) + rh / 2) * scale
  return { scale, tx: Math.round(vw / 2 - cx), ty: Math.round(vh / 2 - cy) }
}

/** Fit the whole image with `padding` CSS px around it, centred (translation rounded to whole px). */
export function fitView(imgW: number, imgH: number, vw: number, vh: number, padding = FIT_PADDING): ViewState {
  return fitRect({ x1: 0, y1: 0, x2: imgW, y2: imgH }, vw, vh, padding)
}

/** Set the scale (clamped) keeping the image point under screen (sx, sy) fixed. */
export function zoomToScaleAt(view: ViewState, scale: number, sx: number, sy: number): ViewState {
  const s = clampScale(scale)
  const k = s / view.scale
  return { scale: s, tx: sx - (sx - view.tx) * k, ty: sy - (sy - view.ty) * k }
}

/** Multiply the scale by `factor` (clamped) keeping the image point under screen (sx, sy) fixed. */
export function zoomAt(view: ViewState, factor: number, sx: number, sy: number): ViewState {
  return zoomToScaleAt(view, view.scale * factor, sx, sy)
}

export function panBy(view: ViewState, dx: number, dy: number): ViewState {
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy }
}

/** 1 image px = 1 CSS px, keeping the image point at the viewport centre fixed. */
export function actualSizeView(view: ViewState, vw: number, vh: number): ViewState {
  const c = screenToImage(view, vw / 2, vh / 2)
  return { scale: 1, tx: Math.round(vw / 2 - c.x), ty: Math.round(vh / 2 - c.y) }
}

/**
 * Smallest view change that makes `rect` (image px) visible with padding. Keeps the scale unless
 * the rect does not fit, in which case it zooms out to fit the rect.
 */
export function revealRect(view: ViewState, rect: Rect, vw: number, vh: number, padding = FIT_PADDING): ViewState {
  if (vw <= 0 || vh <= 0) return view
  const pad = effectivePadding(padding, vw, vh)
  const r = rectToScreen(view, rect)
  if (r.w > vw - 2 * pad || r.h > vh - 2 * pad) {
    if (r.w <= 0 || r.h <= 0) return view
    const fitted = fitRect(rect, vw, vh, padding)
    // Only zoom out: a rect that does not fit never makes us zoom in.
    return fitted.scale < view.scale ? fitted : view
  }
  let dx = 0
  let dy = 0
  if (r.x < pad) dx = pad - r.x
  else if (r.x + r.w > vw - pad) dx = vw - pad - (r.x + r.w)
  if (r.y < pad) dy = pad - r.y
  else if (r.y + r.h > vh - pad) dy = vh - pad - (r.y + r.h)
  if (dx === 0 && dy === 0) return view
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy }
}

/**
 * Keep at least `keep` CSS px of the image inside the viewport (or the whole image when it is
 * smaller than that on screen), so it can never be panned out of reach.
 */
export function constrainView(
  view: ViewState,
  imgW: number,
  imgH: number,
  vw: number,
  vh: number,
  keep = KEEP_VISIBLE,
): ViewState {
  if (imgW <= 0 || imgH <= 0 || vw <= 0 || vh <= 0) return view
  const w = imgW * view.scale
  const h = imgH * view.scale
  const kx = Math.min(keep, w, vw / 2)
  const ky = Math.min(keep, h, vh / 2)
  const tx = clamp(view.tx, kx - w, vw - kx)
  const ty = clamp(view.ty, ky - h, vh - ky)
  if (tx === view.tx && ty === view.ty) return view
  return { scale: view.scale, tx, ty }
}

export function viewsEqual(a: ViewState, b: ViewState): boolean {
  return a.scale === b.scale && a.tx === b.tx && a.ty === b.ty
}

export function imageSmoothingFor(scale: number): boolean {
  return scale <= SMOOTHING_MAX_SCALE
}

/** WheelEvent.deltaMode values. */
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
const LINE_HEIGHT = 16

/** Wheel deltas converted to CSS px. */
export function wheelDeltaPx(deltaX: number, deltaY: number, deltaMode: number, pageHeight: number): Point {
  const k = deltaMode === DOM_DELTA_LINE ? LINE_HEIGHT : deltaMode === DOM_DELTA_PAGE ? Math.max(1, pageHeight) : 1
  return { x: deltaX * k, y: deltaY * k }
}

/**
 * Zoom factor for a wheel delta (CSS px, positive = zoom out). A mouse notch (~100 px) zooms by
 * about 22 %; trackpad pinch (reported as ctrl+wheel with small deltas) is more sensitive but
 * clamped so a ctrl+mouse notch stays reasonable.
 */
export function wheelZoomFactor(deltaY: number, pinch: boolean): number {
  if (pinch) return Math.exp(-clamp(deltaY, -25, 25) * 0.01)
  return Math.exp(-clamp(deltaY, -100, 100) * 0.002)
}

export type WheelMode = 'zoom' | 'scroll'

export interface WheelInput {
  /** Deltas in CSS px (see wheelDeltaPx). */
  dx: number
  dy: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  /** Pointer position (container-relative CSS px). */
  x: number
  y: number
}

/** New view for a wheel event, following the `wheel` preference. */
export function applyWheel(view: ViewState, e: WheelInput, mode: WheelMode): ViewState {
  const zoomModifier = e.ctrlKey || e.metaKey
  if (zoomModifier) return zoomAt(view, wheelZoomFactor(e.dy, e.ctrlKey), e.x, e.y)
  if (e.shiftKey) {
    // Horizontal pan. Some browsers already move the delta to deltaX when Shift is held.
    const d = e.dx !== 0 ? e.dx : e.dy
    return panBy(view, -d, 0)
  }
  if (mode === 'zoom') {
    if (e.dy === 0 && e.dx !== 0) return panBy(view, -e.dx, 0)
    return zoomAt(view, wheelZoomFactor(e.dy, false), e.x, e.y)
  }
  return panBy(view, -e.dx, -e.dy)
}
