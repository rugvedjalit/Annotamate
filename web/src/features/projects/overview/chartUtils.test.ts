import { describe, expect, it } from 'vitest'
import { niceCountCeil, parseDay } from './chartUtils'

describe('chart helpers', () => {
  it('count axes end on an even nice number so the midline tick is a whole number', () => {
    const cases: [number, number][] = [[0, 2], [1, 2], [2, 2], [3, 4], [5, 6], [9, 10], [11, 20], [13, 20], [25, 40], [60, 60], [61, 80], [99, 100], [101, 200]]
    for (const [value, max] of cases) {
      expect(niceCountCeil(value)).toBe(max)
      expect(Number.isInteger(niceCountCeil(value) / 2)).toBe(true)
    }
  })

  it('parses calendar days in local time', () => {
    const d = parseDay('2026-11-23')
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 10, 23, 0])
  })
})
