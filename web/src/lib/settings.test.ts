import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  THEME_STORAGE_KEY,
  applySettingsPatch,
  applyThemeClass,
  mergeSettings,
  readStoredTheme,
  resolveTheme,
  sanitizeShortcuts,
  serializeSettings,
  storeTheme,
  type UserSettings,
} from './settings'

describe('DEFAULT_SETTINGS', () => {
  it('matches docs/frontend.md', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      theme: 'dark',
      shortcuts: {},
      autosave: true,
      autosave_delay_ms: 800,
      ask_class_after_draw: true,
      tool_after_draw: 'box',
      wheel: 'zoom',
      fill_opacity: 0.16,
      stroke_width: 2,
      show_labels: true,
      show_crosshair: true,
      notify_sound: false,
    })
    const [fMin, fMax] = SETTINGS_LIMITS.files_panel_width
    const [iMin, iMax] = SETTINGS_LIMITS.inspector_width
    expect(DEFAULT_SETTINGS.files_panel_width).toBeGreaterThanOrEqual(fMin)
    expect(DEFAULT_SETTINGS.files_panel_width).toBeLessThanOrEqual(fMax)
    expect(DEFAULT_SETTINGS.inspector_width).toBeGreaterThanOrEqual(iMin)
    expect(DEFAULT_SETTINGS.inspector_width).toBeLessThanOrEqual(iMax)
    expect(SETTINGS_LIMITS.files_panel_width).toEqual([220, 420])
    expect(SETTINGS_LIMITS.inspector_width).toEqual([260, 420])
  })

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true)
  })
})

describe('mergeSettings', () => {
  it('returns the defaults for missing or non-object input', () => {
    for (const input of [undefined, null, 'garbage', 42, [1, 2], true]) {
      expect(mergeSettings(input)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('applies a partial object on top of the defaults', () => {
    const s = mergeSettings({ theme: 'light', autosave: false, wheel: 'scroll' })
    expect(s).toEqual({ ...DEFAULT_SETTINGS, theme: 'light', autosave: false, wheel: 'scroll' })
  })

  it('falls back to the default for values of the wrong type or unknown options', () => {
    const s = mergeSettings({
      theme: 'purple',
      autosave: 'yes',
      autosave_delay_ms: '800',
      fill_opacity: Number.NaN,
      stroke_width: Number.POSITIVE_INFINITY,
      wheel: 3,
      tool_after_draw: 'polygon',
      show_labels: 1,
      notify_sound: null,
    })
    expect(s).toEqual(DEFAULT_SETTINGS)
  })

  it('clamps numbers to their allowed range and rounds pixel/ms values', () => {
    expect(mergeSettings({ autosave_delay_ms: 50 }).autosave_delay_ms).toBe(200)
    expect(mergeSettings({ autosave_delay_ms: 99999 }).autosave_delay_ms).toBe(10000)
    expect(mergeSettings({ autosave_delay_ms: 812.6 }).autosave_delay_ms).toBe(813)
    expect(mergeSettings({ fill_opacity: 2 }).fill_opacity).toBe(SETTINGS_LIMITS.fill_opacity[1])
    expect(mergeSettings({ fill_opacity: -1 }).fill_opacity).toBe(0)
    expect(mergeSettings({ fill_opacity: 0.3 }).fill_opacity).toBe(0.3)
    expect(mergeSettings({ stroke_width: 0 }).stroke_width).toBe(1)
    expect(mergeSettings({ stroke_width: 10 }).stroke_width).toBe(6)
    expect(mergeSettings({ files_panel_width: 100 }).files_panel_width).toBe(220)
    expect(mergeSettings({ files_panel_width: 900 }).files_panel_width).toBe(420)
    expect(mergeSettings({ inspector_width: 100 }).inspector_width).toBe(260)
    expect(mergeSettings({ inspector_width: 333.4 }).inspector_width).toBe(333)
  })

  it('sanitises shortcut overrides', () => {
    const s = mergeSettings({
      shortcuts: {
        undo: ['mod+shift+u', 'Mod+W', 'nonsense+'],
        'not.an.action': ['X'],
        redo: 'Mod+Y',
        'tool.box': [],
      },
    })
    expect(s.shortcuts).toEqual({ undo: ['Mod+Shift+U'], 'tool.box': [] })
  })

  it('keeps the base shortcuts when the stored object has none', () => {
    const base: UserSettings = { ...DEFAULT_SETTINGS, shortcuts: { undo: ['Mod+U'] } }
    const s = mergeSettings({ theme: 'light' }, base)
    expect(s.shortcuts).toEqual({ undo: ['Mod+U'] })
    expect(s.shortcuts).not.toBe(base.shortcuts)
  })

  it('treats a non-object shortcuts value as no overrides', () => {
    expect(mergeSettings({ shortcuts: ['Mod+K'] }).shortcuts).toEqual({})
    expect(sanitizeShortcuts(null)).toEqual({})
  })
})

describe('applySettingsPatch', () => {
  it('validates the patch and keeps other current values', () => {
    const current: UserSettings = { ...DEFAULT_SETTINGS, autosave: false, theme: 'light' }
    const next = applySettingsPatch(current, { fill_opacity: 5, stroke_width: 3 })
    expect(next.fill_opacity).toBe(SETTINGS_LIMITS.fill_opacity[1])
    expect(next.stroke_width).toBe(3)
    expect(next.autosave).toBe(false)
    expect(next.theme).toBe('light')
  })

  it('falls back to the current value (not the default) for invalid patches', () => {
    const current: UserSettings = { ...DEFAULT_SETTINGS, wheel: 'scroll' }
    const next = applySettingsPatch(current, { wheel: 'sideways' as UserSettings['wheel'] })
    expect(next.wheel).toBe('scroll')
  })
})

describe('serializeSettings', () => {
  it('writes validated settings and preserves unknown stored keys', () => {
    const settings: UserSettings = { ...DEFAULT_SETTINGS, theme: 'light', shortcuts: { undo: ['Mod+U'] } }
    const out = serializeSettings(settings, { future_key: { a: 1 }, theme: 'dark' })
    expect(out.future_key).toEqual({ a: 1 })
    expect(out.theme).toBe('light')
    expect(out.shortcuts).toEqual({ undo: ['Mod+U'] })
    expect(out.autosave_delay_ms).toBe(800)
  })

  it('round-trips through mergeSettings', () => {
    const settings: UserSettings = {
      ...DEFAULT_SETTINGS,
      autosave: false,
      fill_opacity: 0.3,
      shortcuts: { redo: ['Mod+Shift+Z'], 'tool.pan': [] },
    }
    expect(mergeSettings(serializeSettings(settings))).toEqual(settings)
  })
})

describe('theme helpers', () => {
  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
    document.documentElement.className = ''
  })

  function stubMatchMedia(light: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: light && query.includes('light'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
  }

  it('resolves explicit themes as is', () => {
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
  })

  it('resolves "system" from prefers-color-scheme', () => {
    stubMatchMedia(true)
    expect(resolveTheme('system')).toBe('light')
    stubMatchMedia(false)
    expect(resolveTheme('system')).toBe('dark')
  })

  it('defaults "system" to dark when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(resolveTheme('system')).toBe('dark')
  })

  it('stores and reads the theme for first paint', () => {
    expect(readStoredTheme()).toBeNull()
    storeTheme('system')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
    expect(readStoredTheme()).toBe('system')
    localStorage.setItem(THEME_STORAGE_KEY, 'blue')
    expect(readStoredTheme()).toBeNull()
  })

  it('applies the theme class on <html> and the theme-color meta tag', () => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
    applyThemeClass('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(meta.getAttribute('content')).toBe('#f4f6f9')
    applyThemeClass('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(meta.getAttribute('content')).toBe('#0e1014')
    meta.remove()
  })
})
