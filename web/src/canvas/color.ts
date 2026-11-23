// Small colour helpers for the renderer (hex parsing, mixing, contrast). Pure.

export interface RGB {
  r: number
  g: number
  b: number
}

export const DEFAULT_ACCENT = '#3D8FD6'
export const DEFAULT_CANVAS = '#090b0e'
/** Colour of boxes whose class is unknown. */
export const UNKNOWN_CLASS_COLOR = '#8a93a3'

/** Parse "#RGB", "#RRGGBB" (alpha suffixes ignored) or "rgb(r, g, b)" / "rgba(...)". */
export function parseColor(input: string): RGB | null {
  const s = input.trim()
  if (s.startsWith('#')) {
    const h = s.slice(1)
    if (/^[0-9a-f]{3,4}$/i.test(h)) {
      return {
        r: parseInt(h[0]! + h[0]!, 16),
        g: parseInt(h[1]! + h[1]!, 16),
        b: parseInt(h[2]! + h[2]!, 16),
      }
    }
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) {
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
    }
    return null
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s)
  if (m) return { r: Math.round(+m[1]!), g: Math.round(+m[2]!), b: Math.round(+m[3]!) }
  return null
}

function channel(v: number): number {
  const c = Math.max(0, Math.min(255, Math.round(v)))
  return c
}

export function toHex(c: RGB): string {
  const h = (v: number) => channel(v).toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

export function rgba(c: RGB, a: number): string {
  return `rgba(${channel(c.r)}, ${channel(c.g)}, ${channel(c.b)}, ${Math.max(0, Math.min(1, a))})`
}

/** Linear mix: t = 0 -> a, t = 1 -> b. */
export function mix(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }
}

const WHITE: RGB = { r: 255, g: 255, b: 255 }
const BLACK: RGB = { r: 0, g: 0, b: 0 }

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(c: RGB): number {
  const f = (v: number) => {
    const s = channel(v) / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

/** Text colour for a chip: white on dark/saturated colours, a deep shade of the colour on light ones. */
export function contrastText(c: RGB): string {
  return luminance(c) > 0.36 ? toHex(mix(c, BLACK, 0.8)) : '#ffffff'
}

export function isLight(color: string): boolean {
  const c = parseColor(color)
  return c !== null && luminance(c) > 0.4
}

export function brighten(c: RGB, t: number): RGB {
  return mix(c, WHITE, t)
}
