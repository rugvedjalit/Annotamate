export * from './types'
export { AnnotationCanvas } from './AnnotationCanvas'
export {
  clampBox,
  normalizeBox,
  translateBoxes,
  boxWidth,
  boxHeight,
  boxesIntersect,
  boundsOf,
  boxContains,
  clampGroupDelta,
  resizeBox,
  HANDLES,
  MIN_BOX_SIZE,
  type HandleId,
  type Point,
  type Rect,
} from './geometry'
export { MIN_SCALE, MAX_SCALE, FIT_PADDING, fitView, clampScale } from './view'
export { newBoxId } from './ids'
