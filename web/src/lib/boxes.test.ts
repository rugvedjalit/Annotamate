import { describe, expect, it } from 'vitest'
import {
  cloneBoxes,
  fromApiBox,
  fromApiBoxes,
  isValidBox,
  persistedKey,
  toApiBox,
  toApiBoxes,
  type EditorBox,
} from './boxes'
import type { Box } from './types'

const apiBox: Box = {
  id: '6f1c2a1e-0000-4000-8000-000000000001',
  class_id: 2,
  raw_label: null,
  x1: 10.5,
  y1: 20,
  x2: 110,
  y2: 220.25,
  difficult: false,
  truncated: false,
}

describe('API ↔ editor box conversion', () => {
  it('maps snake_case fields to the canvas shape', () => {
    expect(fromApiBox(apiBox)).toEqual({
      id: apiBox.id,
      classId: 2,
      rawLabel: null,
      x1: 10.5,
      y1: 20,
      x2: 110,
      y2: 220.25,
    })
  })

  it('keeps VOC flags only when set', () => {
    const b = fromApiBox({ ...apiBox, difficult: true, truncated: true })
    expect(b.difficult).toBe(true)
    expect(b.truncated).toBe(true)
    const plain = fromApiBox({ ...apiBox, difficult: undefined, truncated: undefined })
    expect('difficult' in plain).toBe(false)
    expect('truncated' in plain).toBe(false)
  })

  it('keeps raw_label only for unknown classes', () => {
    expect(fromApiBox({ ...apiBox, class_id: null, raw_label: '7' }).rawLabel).toBe('7')
    expect(fromApiBox({ ...apiBox, class_id: 3, raw_label: 'stale' }).rawLabel).toBeNull()
    expect(fromApiBox({ ...apiBox, class_id: null, raw_label: null }).rawLabel).toBeNull()
  })

  it('converts back with explicit flags and raw_label rules', () => {
    const unknown: EditorBox = { id: 'a', classId: null, rawLabel: 'truck', x1: 0, y1: 0, x2: 5, y2: 5 }
    expect(toApiBox(unknown)).toEqual({
      id: 'a',
      class_id: null,
      raw_label: 'truck',
      x1: 0,
      y1: 0,
      x2: 5,
      y2: 5,
      difficult: false,
      truncated: false,
    })
    expect(toApiBox({ ...unknown, classId: 3 }).raw_label).toBeNull()
    expect(toApiBox({ ...unknown, rawLabel: undefined }).raw_label).toBeNull()
  })

  it('drops view-only state (hidden/locked) when saving', () => {
    const saved = toApiBox({ ...fromApiBox(apiBox), hidden: true, locked: true })
    expect(saved).not.toHaveProperty('hidden')
    expect(saved).not.toHaveProperty('locked')
  })

  it('round-trips', () => {
    expect(toApiBox(fromApiBox(apiBox))).toEqual(apiBox)
    const unknown: Box = { ...apiBox, class_id: null, raw_label: 'dog', difficult: true, truncated: false }
    expect(toApiBox(fromApiBox(unknown))).toEqual(unknown)
    expect(toApiBoxes(fromApiBoxes([apiBox, unknown]))).toEqual([apiBox, unknown])
  })
})

describe('persistedKey', () => {
  const base: EditorBox = { id: 'a', classId: 1, rawLabel: null, x1: 1, y1: 2, x2: 3, y2: 4 }

  it('ignores hidden and locked', () => {
    expect(persistedKey([{ ...base, hidden: true, locked: true }])).toBe(persistedKey([base]))
  })

  it('changes with any persisted field', () => {
    const k = persistedKey([base])
    expect(persistedKey([{ ...base, x1: 1.5 }])).not.toBe(k)
    expect(persistedKey([{ ...base, classId: 2 }])).not.toBe(k)
    expect(persistedKey([{ ...base, classId: null }])).not.toBe(k)
    expect(persistedKey([{ ...base, difficult: true }])).not.toBe(k)
    expect(persistedKey([{ ...base, truncated: true }])).not.toBe(k)
    expect(persistedKey([{ ...base, id: 'b' }])).not.toBe(k)
    expect(persistedKey([base, base])).not.toBe(k)
    expect(persistedKey([])).toBe('')
  })

  it('ignores rawLabel for known classes but not for unknown ones', () => {
    expect(persistedKey([{ ...base, rawLabel: 'x' }])).toBe(persistedKey([base]))
    const unknown: EditorBox = { ...base, classId: null, rawLabel: 'x' }
    expect(persistedKey([{ ...unknown, rawLabel: 'y' }])).not.toBe(persistedKey([unknown]))
  })

  it('is order sensitive (box order is part of the label file)', () => {
    const b2: EditorBox = { ...base, id: 'b' }
    expect(persistedKey([base, b2])).not.toBe(persistedKey([b2, base]))
  })
})

describe('cloneBoxes', () => {
  it('gives copies fresh ids and keeps class, label and flags but not view state', () => {
    const src: EditorBox = {
      id: 'src',
      classId: null,
      rawLabel: 'cat',
      x1: 0,
      y1: 0,
      x2: 20,
      y2: 10,
      difficult: true,
      hidden: true,
      locked: true,
    }
    const [copy] = cloneBoxes([src], 100, 100)
    expect(copy).toBeDefined()
    expect(copy!.id).not.toBe('src')
    expect(copy!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(copy).toMatchObject({ classId: null, rawLabel: 'cat', difficult: true, x1: 0, y1: 0, x2: 20, y2: 10 })
    expect(copy!.hidden).toBeUndefined()
    expect(copy!.locked).toBeUndefined()
    expect(copy!.truncated).toBeUndefined()
  })

  it('applies the offset and clamps inside the image', () => {
    const boxes: EditorBox[] = [
      { id: 'a', classId: 1, x1: 0, y1: 0, x2: 20, y2: 10 },
      { id: 'b', classId: 1, x1: 90, y1: 90, x2: 100, y2: 100 },
    ]
    const [a, b] = cloneBoxes(boxes, 100, 100, 10)
    expect(a).toMatchObject({ x1: 10, y1: 10, x2: 30, y2: 20 })
    expect(b).toMatchObject({ x1: 90, y1: 90, x2: 100, y2: 100 })
  })

  it('shrinks boxes larger than the image and normalises reversed corners', () => {
    const [big, reversed] = cloneBoxes(
      [
        { id: 'big', classId: 1, x1: -10, y1: 0, x2: 150, y2: 50 },
        { id: 'rev', classId: 1, x1: 50, y1: 40, x2: 10, y2: 20 },
      ],
      100,
      80,
    )
    expect(big).toMatchObject({ x1: 0, y1: 0, x2: 100, y2: 50 })
    expect(reversed).toMatchObject({ x1: 10, y1: 20, x2: 50, y2: 40 })
  })

  it('produces unique ids for every copy', () => {
    const src: EditorBox = { id: 's', classId: 1, x1: 0, y1: 0, x2: 1, y2: 1 }
    const ids = cloneBoxes([src, src, src], 10, 10).map((b) => b.id)
    expect(new Set(ids).size).toBe(3)
  })
})

describe('isValidBox', () => {
  it('requires at least 1 image px in both dimensions', () => {
    expect(isValidBox({ x1: 0, y1: 0, x2: 1, y2: 1 })).toBe(true)
    expect(isValidBox({ x1: 5, y1: 5, x2: 0, y2: 0 })).toBe(true)
    expect(isValidBox({ x1: 0, y1: 0, x2: 0.5, y2: 10 })).toBe(false)
    expect(isValidBox({ x1: 0, y1: 0, x2: 10, y2: 0.99 })).toBe(false)
  })
})
