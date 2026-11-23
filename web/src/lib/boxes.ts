// Conversion between API boxes (snake_case) and canvas/editor boxes, plus box helpers.
import type { CanvasBox } from '@/canvas'
import type { Box } from './types'
import { uuid } from './utils'

/** Editor box = canvas box + VOC flags. hidden/locked are local view state, never saved. */
export interface EditorBox extends CanvasBox {
  difficult?: boolean
  truncated?: boolean
}

export function fromApiBox(b: Box): EditorBox {
  const out: EditorBox = {
    id: b.id,
    classId: b.class_id,
    rawLabel: b.class_id === null ? (b.raw_label ?? null) : null,
    x1: b.x1,
    y1: b.y1,
    x2: b.x2,
    y2: b.y2,
  }
  if (b.difficult) out.difficult = true
  if (b.truncated) out.truncated = true
  return out
}

export function toApiBox(b: EditorBox): Box {
  return {
    id: b.id,
    class_id: b.classId,
    raw_label: b.classId === null ? (b.rawLabel ?? null) : null,
    x1: b.x1,
    y1: b.y1,
    x2: b.x2,
    y2: b.y2,
    difficult: !!b.difficult,
    truncated: !!b.truncated,
  }
}

export const fromApiBoxes = (boxes: readonly Box[]): EditorBox[] => boxes.map(fromApiBox)
export const toApiBoxes = (boxes: readonly EditorBox[]): Box[] => boxes.map(toApiBox)

/** Stable fingerprint of the persisted fields only (hidden/locked do not make a doc dirty). */
export function persistedKey(boxes: readonly EditorBox[]): string {
  let s = ''
  for (const b of boxes) {
    s += `${b.id}|${b.classId ?? 'n'}|${b.classId === null ? (b.rawLabel ?? '') : ''}|${b.x1}|${b.y1}|${b.x2}|${b.y2}|${b.difficult ? 1 : 0}${b.truncated ? 1 : 0};`
  }
  return s
}

/** Copy boxes with fresh ids (paste / duplicate), clamped inside the image, optionally offset. */
export function cloneBoxes(
  boxes: readonly EditorBox[],
  imageWidth: number,
  imageHeight: number,
  offset = 0,
): EditorBox[] {
  return boxes.map((b) => {
    const w = Math.min(Math.abs(b.x2 - b.x1), imageWidth)
    const h = Math.min(Math.abs(b.y2 - b.y1), imageHeight)
    const x1 = Math.min(Math.max(Math.min(b.x1, b.x2) + offset, 0), Math.max(imageWidth - w, 0))
    const y1 = Math.min(Math.max(Math.min(b.y1, b.y2) + offset, 0), Math.max(imageHeight - h, 0))
    const copy: EditorBox = { id: uuid(), classId: b.classId, rawLabel: b.rawLabel ?? null, x1, y1, x2: x1 + w, y2: y1 + h }
    if (b.difficult) copy.difficult = true
    if (b.truncated) copy.truncated = true
    return copy
  })
}

/** Boxes with at least 1 image px in both dimensions (smaller ones are dropped by the server too). */
export function isValidBox(b: Pick<CanvasBox, 'x1' | 'y1' | 'x2' | 'y2'>): boolean {
  return Math.abs(b.x2 - b.x1) >= 1 && Math.abs(b.y2 - b.y1) >= 1
}
