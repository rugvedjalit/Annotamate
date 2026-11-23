// Formatting helpers: relative time, numbers, file sizes, dates.

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' })
const numberFmt = new Intl.NumberFormat()
const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const dateYearFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

export function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "just now", "5 min. ago", "3 hr. ago", "yesterday", then a date. */
export function relativeTime(value: string | Date | null | undefined, now: Date = new Date()): string {
  const d = parseDate(value)
  if (!d) return ''
  const diff = (d.getTime() - now.getTime()) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return 'just now'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
  return d.getFullYear() === now.getFullYear() ? dateFmt.format(d) : dateYearFmt.format(d)
}

export function formatTime(value: string | Date | null | undefined): string {
  const d = parseDate(value)
  return d ? timeFmt.format(d) : ''
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const d = parseDate(value)
  return d ? fullFmt.format(d) : ''
}

export function formatDate(value: string | Date | null | undefined): string {
  const d = parseDate(value)
  if (!d) return ''
  return d.getFullYear() === new Date().getFullYear() ? dateFmt.format(d) : dateYearFmt.format(d)
}

/** Label for chat day separators: "Today", "Yesterday", "Monday, March 3". */
export function dayLabel(value: string | Date, now: Date = new Date()): string {
  const d = parseDate(value)
  if (!d) return ''
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(d)) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.getFullYear() === now.getFullYear() ? dayFmt.format(d) : dateYearFmt.format(d)
}

export function isSameDay(a: string | Date, b: string | Date): boolean {
  const x = parseDate(a)
  const y = parseDate(b)
  return !!x && !!y && x.toDateString() === y.toDateString()
}

export function formatNumber(n: number): string {
  return numberFmt.format(n)
}

export function formatCompact(n: number): string {
  return n < 10000 ? numberFmt.format(n) : compactFmt.format(n)
}

export function formatPercent(part: number, total: number, digits = 0): string {
  if (total <= 0) return '0%'
  const fixed = ((part / total) * 100).toFixed(digits)
  // "20%" rather than "20.0%"; keep meaningful decimals ("33.3%", "0.5%").
  return `${digits > 0 ? fixed.replace(/.?0+$/, '') : fixed}%`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

/** Image pixel value for display: integers stay integers, floats get one decimal. */
export function formatPx(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
