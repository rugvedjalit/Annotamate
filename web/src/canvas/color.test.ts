import { describe, expect, it } from 'vitest'
import { brighten, contrastText, isLight, luminance, mix, parseColor, rgba, toHex } from './color'

describe('color helpers', () => {
  it('parses hex and rgb forms', () => {
    expect(parseColor('#3D8FD6')).toEqual({ r: 0x3d, g: 0x8f, b: 0xd6 })
    expect(parseColor('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc })
    expect(parseColor('#3d8fd680')).toEqual({ r: 0x3d, g: 0x8f, b: 0xd6 })
    expect(parseColor(' rgb(1, 2, 3) ')).toEqual({ r: 1, g: 2, b: 3 })
    expect(parseColor('rgba(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30 })
    expect(parseColor('oklch(0.5 0.1 200)')).toBeNull()
    expect(parseColor('#12')).toBeNull()
  })
  it('formats', () => {
    expect(toHex({ r: 255, g: 0, b: 16 })).toBe('#ff0010')
    expect(rgba({ r: 1, g: 2, b: 3 }, 0.16)).toBe('rgba(1, 2, 3, 0.16)')
    expect(toHex(mix({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5))).toBe('#808080')
    expect(toHex(brighten({ r: 0, g: 0, b: 0 }, 1))).toBe('#ffffff')
  })
  it('luminance bounds', () => {
    expect(luminance({ r: 0, g: 0, b: 0 })).toBe(0)
    expect(luminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1)
  })
  it('chip text matches the mockup: white on blue/orange, dark on green/yellow', () => {
    expect(contrastText(parseColor('#3b82f6')!)).toBe('#ffffff')
    expect(contrastText(parseColor('#f97316')!)).toBe('#ffffff')
    expect(contrastText(parseColor('#22c55e')!)).not.toBe('#ffffff')
    expect(contrastText(parseColor('#facc15')!)).not.toBe('#ffffff')
  })
  it('isLight distinguishes the two canvas backdrops', () => {
    expect(isLight('#090b0e')).toBe(false)
    expect(isLight('#e9edf2')).toBe(true)
    expect(isLight('not a colour')).toBe(false)
  })
})
