// User preferences schema + defaults. Stored as free-form JSON via /api/me/settings.
import { ACTION_IDS, isActionId, sanitizeCombos, type ShortcutOverrides } from './keymap'
import { clamp } from './utils'

export type ThemePreference = 'dark' | 'light' | 'system'

export interface UserSettings {
  theme: ThemePreference
  shortcuts: ShortcutOverrides
  autosave: boolean
  autosave_delay_ms: number
  ask_class_after_draw: boolean
  tool_after_draw: 'box' | 'select'
  wheel: 'zoom' | 'scroll'
  fill_opacity: number
  stroke_width: number
  show_labels: boolean
  show_crosshair: boolean
  files_panel_width: number
  inspector_width: number
  notify_sound: boolean
}

export const DEFAULT_SETTINGS: Readonly<UserSettings> = Object.freeze({
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
  files_panel_width: 260,
  inspector_width: 300,
  notify_sound: false,
})

export const SETTINGS_LIMITS = {
  autosave_delay_ms: [200, 10000],
  fill_opacity: [0, 0.6],
  stroke_width: [1, 6],
  files_panel_width: [220, 420],
  inspector_width: [260, 420],
} as const satisfies Partial<Record<keyof UserSettings, readonly [number, number]>>

export const THEME_STORAGE_KEY = 'annotamate.theme'

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function num(v: unknown, fallback: number, [min, max]: readonly [number, number]): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, min, max) : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback
}

export function sanitizeShortcuts(value: unknown): ShortcutOverrides {
  const out: ShortcutOverrides = {}
  if (!isRecord(value)) return out
  for (const [key, list] of Object.entries(value)) {
    if (!isActionId(key)) continue
    const combos = sanitizeCombos(list)
    if (combos) out[key] = combos
  }
  return out
}

/**
 * Merge a stored (untrusted, possibly partial or outdated) settings object onto the defaults.
 * Invalid values fall back to defaults; numbers are clamped to their allowed range.
 */
export function mergeSettings(stored: unknown, base: UserSettings = DEFAULT_SETTINGS): UserSettings {
  const s = isRecord(stored) ? stored : {}
  return {
    theme: oneOf(s.theme, ['dark', 'light', 'system'] as const, base.theme),
    shortcuts: 'shortcuts' in s ? sanitizeShortcuts(s.shortcuts) : { ...base.shortcuts },
    autosave: bool(s.autosave, base.autosave),
    autosave_delay_ms: Math.round(num(s.autosave_delay_ms, base.autosave_delay_ms, SETTINGS_LIMITS.autosave_delay_ms)),
    ask_class_after_draw: bool(s.ask_class_after_draw, base.ask_class_after_draw),
    tool_after_draw: oneOf(s.tool_after_draw, ['box', 'select'] as const, base.tool_after_draw),
    wheel: oneOf(s.wheel, ['zoom', 'scroll'] as const, base.wheel),
    fill_opacity: num(s.fill_opacity, base.fill_opacity, SETTINGS_LIMITS.fill_opacity),
    stroke_width: num(s.stroke_width, base.stroke_width, SETTINGS_LIMITS.stroke_width),
    show_labels: bool(s.show_labels, base.show_labels),
    show_crosshair: bool(s.show_crosshair, base.show_crosshair),
    files_panel_width: Math.round(num(s.files_panel_width, base.files_panel_width, SETTINGS_LIMITS.files_panel_width)),
    inspector_width: Math.round(num(s.inspector_width, base.inspector_width, SETTINGS_LIMITS.inspector_width)),
    notify_sound: bool(s.notify_sound, base.notify_sound),
  }
}

/** Apply a partial update (validated) to current settings. */
export function applySettingsPatch(current: UserSettings, patch: Partial<UserSettings>): UserSettings {
  return mergeSettings({ ...current, ...patch }, current)
}

/**
 * Object to PUT: unknown keys from the stored object are preserved (forward compatibility with
 * newer clients), known keys come from the validated settings.
 */
export function serializeSettings(settings: UserSettings, storedRaw: Record<string, unknown> = {}): Record<string, unknown> {
  const shortcuts: Record<string, string[]> = {}
  for (const id of ACTION_IDS) {
    const list = settings.shortcuts[id]
    if (list) shortcuts[id] = list
  }
  return { ...storedRaw, ...settings, shortcuts }
}

export function readStoredTheme(): ThemePreference | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    return v === 'dark' || v === 'light' || v === 'system' ? v : null
  } catch {
    return null
  }
}

export function storeTheme(theme: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // storage unavailable (private mode); the server copy still applies after sign-in
  }
}

export function resolveTheme(pref: ThemePreference): 'dark' | 'light' {
  if (pref !== 'system') return pref
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** Apply the theme class on <html> (also used before React renders to avoid a flash). */
export function applyThemeClass(theme: 'dark' | 'light'): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.classList.toggle('light', theme === 'light')
  const meta = document.querySelector('meta[name="theme-color"]')
  meta?.setAttribute('content', theme === 'dark' ? '#0e1014' : '#f4f6f9')
}
