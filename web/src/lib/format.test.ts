import { describe, expect, it } from 'vitest'
import {
  dayLabel,
  formatBytes,
  formatCompact,
  formatDate,
  formatNumber,
  formatPercent,
  formatPx,
  isSameDay,
  parseDate,
  relativeTime,
} from './format'

// Locale-dependent output is compared against the same Intl formatters the module uses.
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' })
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const shortDateYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

const now = new Date(2026, 10, 23, 12, 0, 0) // local time, Nov 23 2026 12:00
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000)

describe('parseDate', () => {
  it('parses ISO strings and rejects invalid input', () => {
    expect(parseDate('2026-11-23T10:15:00Z')?.toISOString()).toBe('2026-11-23T10:15:00.000Z')
    expect(parseDate(now)).toBe(now)
    expect(parseDate('not a date')).toBeNull()
    expect(parseDate(null)).toBeNull()
    expect(parseDate(undefined)).toBeNull()
    expect(parseDate('')).toBeNull()
  })
})

describe('relativeTime', () => {
  it('returns "" for missing or invalid dates', () => {
    expect(relativeTime(null, now)).toBe('')
    expect(relativeTime('garbage', now)).toBe('')
  })

  it('says "just now" within 45 seconds either way', () => {
    expect(relativeTime(ago(20), now)).toBe('just now')
    expect(relativeTime(ago(-30), now)).toBe('just now')
  })

  it('uses minutes, hours and days', () => {
    expect(relativeTime(ago(5 * 60), now)).toBe(rtf.format(-5, 'minute'))
    expect(relativeTime(ago(3 * 3600), now)).toBe(rtf.format(-3, 'hour'))
    expect(relativeTime(ago(2 * 86400), now)).toBe(rtf.format(-2, 'day'))
    expect(relativeTime(ago(-10 * 60), now)).toBe(rtf.format(10, 'minute'))
  })

  it('falls back to a date after a week, with the year when it differs', () => {
    const lastMonth = new Date(2026, 9, 3, 9, 0)
    expect(relativeTime(lastMonth, now)).toBe(shortDate.format(lastMonth))
    const lastYear = new Date(2025, 4, 1, 9, 0)
    expect(relativeTime(lastYear, now)).toBe(shortDateYear.format(lastYear))
  })

  it('accepts ISO strings', () => {
    expect(relativeTime(ago(5 * 60).toISOString(), now)).toBe(rtf.format(-5, 'minute'))
  })
})

describe('dayLabel / isSameDay', () => {
  it('labels today, yesterday, this year and older dates', () => {
    expect(dayLabel(new Date(2026, 10, 23, 1, 0), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 10, 22, 23, 59), now)).toBe('Yesterday')
    const earlier = new Date(2026, 2, 3, 10, 0)
    expect(dayLabel(earlier, now)).toBe(longDay.format(earlier))
    const older = new Date(2024, 2, 3, 10, 0)
    expect(dayLabel(older, now)).toBe(shortDateYear.format(older))
    expect(dayLabel('nope', now)).toBe('')
  })

  it('compares calendar days', () => {
    expect(isSameDay(new Date(2026, 10, 23, 0, 1), new Date(2026, 10, 23, 23, 59))).toBe(true)
    expect(isSameDay(new Date(2026, 10, 23), new Date(2026, 10, 24))).toBe(false)
    expect(isSameDay('bad', now)).toBe(false)
  })
})

describe('numbers', () => {
  it('formats percentages safely', () => {
    expect(formatPercent(1, 3)).toBe('33%')
    expect(formatPercent(1, 3, 1)).toBe('33.3%')
    expect(formatPercent(5, 0)).toBe('0%')
    expect(formatPercent(10, 10)).toBe('100%')
    // Decimals only when they carry information.
    expect(formatPercent(1, 5, 1)).toBe('20%')
    expect(formatPercent(10, 10, 2)).toBe('100%')
    expect(formatPercent(1, 200, 1)).toBe('0.5%')
  })

  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB')
    expect(formatBytes(2048 * 1024 ** 4)).toBe('2048 TB')
  })

  it('formats image pixels', () => {
    expect(formatPx(12)).toBe('12')
    expect(formatPx(12.345)).toBe('12.3')
    expect(formatPx(0)).toBe('0')
  })

  it('formats plain and compact numbers', () => {
    const plain = new Intl.NumberFormat()
    expect(formatNumber(1234567)).toBe(plain.format(1234567))
    expect(formatCompact(9999)).toBe(plain.format(9999))
    expect(formatCompact(123456)).toBe(
      new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(123456),
    )
  })

  it('formatDate omits the year for the current year', () => {
    const thisYear = new Date(new Date().getFullYear(), 0, 15)
    expect(formatDate(thisYear)).toBe(shortDate.format(thisYear))
    const old = new Date(2001, 0, 15)
    expect(formatDate(old)).toBe(shortDateYear.format(old))
    expect(formatDate(null)).toBe('')
  })
})
